(function initXlsxWriter(global) {
  "use strict";

  const encoder = new TextEncoder();
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return encoder.encode(String(value));
  }

  function concatBytes(chunks) {
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    };
  }

  function localHeader(nameBytes, data, crc, stamp) {
    const bytes = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034B50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(8, 0, true);      // uncompressed
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    bytes.set(nameBytes, 30);
    return bytes;
  }

  function centralHeader(nameBytes, data, crc, stamp, offset) {
    const bytes = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x02014B50, true);
    // Version made by: 0x0314 (UNIX = 3, ZIP 2.0 = 20) -> Compatible con macOS Archive Utility / Linux / Windows
    view.setUint16(4, 0x0314, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, stamp.time, true);
    view.setUint16(14, stamp.date, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, data.length, true);
    view.setUint32(24, data.length, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    // External file attributes: 0x81A40000 (regular file 0100644)
    view.setUint32(38, 0x81A40000, true);
    view.setUint32(42, offset, true);
    bytes.set(nameBytes, 46);
    return bytes;
  }

  async function makeZip(entries, mimeType = "application/zip") {
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    const stamp = dosDateTime();

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      let value = entry.data;
      if (value instanceof Blob) {
        value = new Uint8Array(await value.arrayBuffer());
      }
      const data = asBytes(value);
      const crc = crc32(data);
      const local = localHeader(nameBytes, data, crc, stamp);
      localChunks.push(local, data);
      centralChunks.push(centralHeader(nameBytes, data, crc, stamp, offset));
      offset += local.length + data.length;
    }

    const central = concatBytes(centralChunks);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054B50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, central.length, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localChunks, central, end], { type: mimeType });
  }

  function xml(value) {
    return String(value ?? "")
      // Excel declara el archivo dañado si hay caracteres de control o sustitutos sueltos.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function columnName(number) {
    let value = number;
    let output = "";
    while (value > 0) {
      value -= 1;
      output = String.fromCharCode(65 + (value % 26)) + output;
      value = Math.floor(value / 26);
    }
    return output;
  }

  function stringCell(ref, value, style = 0) {
    // Excel admite 32,767 caracteres por celda.
    const text = String(value ?? "").slice(0, 32000);
    const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : "";
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${space}>${xml(text)}</t></is></c>`;
  }

  function numberCell(ref, value, style = 0) {
    return `<c r="${ref}" s="${style}"><v>${Number(value) || 0}</v></c>`;
  }

  function excelDateSerial(dateTime) {
    const match = String(dateTime || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    if (!match) return 0;
    const [, year, month, day, hour, minute] = match.map(Number);
    return (Date.UTC(year, month - 1, day, hour, minute) / 86_400_000) + 25_569;
  }

  function formulaCell(ref, formula, cachedValue, style = 0) {
    return `<c r="${ref}" s="${style}"><f>${xml(formula)}</f><v>${Number(cachedValue) || 0}</v></c>`;
  }

  function rowXml(number, cells, height) {
    const attributes = height ? ` ht="${height}" customHeight="1"` : "";
    return `<row r="${number}"${attributes}>${cells.join("")}</row>`;
  }

  function columnsXml(widths) {
    return `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`;
  }

  function worksheet({ rows, widths, dimension, mergeRefs = [], autoFilter = "", freezeRows = 0, validations = "" }) {
    const pane = freezeRows
      ? `<pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/>`
      : "";
    const merges = mergeRefs.length
      ? `<mergeCells count="${mergeRefs.length}">${mergeRefs.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0">${pane}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${columnsXml(widths)}
  <sheetData>${rows.join("")}</sheetData>
  ${autoFilter ? `<autoFilter ref="${autoFilter}"/>` : ""}
  ${merges}
  ${validations}
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.0"/></numFmts>
  <fonts count="5">
    <font><sz val="10"/><name val="Arial"/><family val="2"/></font>
    <font><b/><sz val="15"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
    <font><u/><sz val="10"/><color rgb="FF1254BD"/><name val="Arial"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF073C37"/><name val="Arial"/><family val="2"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF073C37"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF16685E"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF4F1"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFDDE6E3"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="10">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment vertical="top" wrapText="1"/><protection locked="0"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;


  function reportTitle(metadata) {
    return `${metadata.institutionName || metadata.handle || "Dependencia"} — ${global.ExtractorStatistics.network(metadata.platform) === "Sin determinar" ? "Varias redes" : global.ExtractorStatistics.network(metadata.platform)}`;
  }
  function exportName(metadata) {
    const name = reportTitle(metadata).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/\s+/g,"_").slice(0,100);
    return `${name}_${metadata.from}_${metadata.to}.xlsx`;
  }
  function publicationsSheet(metadata, posts) {
    const headers=["Fecha y hora","Bloque operativo","Texto de la publicación","Tipo de publicación","Pertenencia","Tema o proyecto","Red social","Autor","Enlace","Revisión","Motivo de pertenencia","Origen de fecha","Motivo de formato"];
    const rows=[rowXml(1,[stringCell("A1",reportTitle(metadata),5)],28),rowXml(2,[stringCell("A2",`Periodo: ${metadata.from} al ${metadata.to}. Cuenta: @${metadata.handle}`,3)],24),rowXml(3,[stringCell("A3","Formato, pertenencia y tema editables. Estadísticas sobre publicaciones extraídas." + (metadata.extraction ? ` Recorrido: ${metadata.extraction.reason}.` : "") + (metadata.facebookDiagnostics ? ` Facebook: ${metadata.facebookDiagnostics.detected} detectadas; ${metadata.facebookDiagnostics.unresolved} ${metadata.facebookDiagnostics.source === "Respuestas de Facebook" ? "respuestas sin interpretar" : "sin resolver"}. Cobertura total no garantizada.` : "") + (metadata.tiktokDiagnostics ? ` TikTok: ${metadata.tiktokDiagnostics.detected} enlaces detectados; ${metadata.tiktokDiagnostics.pending.length} pendientes. Cobertura total no garantizada.` : ""),3)],26),rowXml(5,headers.map((v,i)=>stringCell(`${columnName(i+1)}5`,v,2)),42)];
    posts.forEach((post,i)=>{
      const r=i+6,values=[post.dateTime,post.block,post.fullText || post.textSummary,post.format,post.belonging,post.topic,post.platform,post.author,post.url,post.needsReview ? "Revisar" : "",post.belongingReason || post.reasoning || "",post.dateSource || "",post.formatReason || post.reasoning || ""];
      rows.push(rowXml(r,values.map((v,j)=>j===0 ? numberCell(`A${r}`,excelDateSerial(v),7) : stringCell(`${columnName(j+1)}${r}`,v,j>=3&&j<=5?9:j===8?4:3)),Math.min(160,Math.max(60,Math.ceil(String(values[2]||"").length/72)*15))));
    });
    const last=Math.max(5,posts.length+5);
    const validations=posts.length?`<dataValidations count="2"><dataValidation type="list" allowBlank="0" showErrorMessage="1" errorStyle="stop" error="Selecciona un formato de la lista." sqref="D6:D${last}"><formula1>"Infografía,Video,Fotografía,Texto"</formula1></dataValidation><dataValidation type="list" allowBlank="0" showErrorMessage="1" errorStyle="stop" error="Selecciona una pertenencia de la lista." sqref="E6:E${last}"><formula1>"Propias,Gobernador,Gobierno del Estado"</formula1></dataValidation></dataValidations>`:"";
    return worksheet({rows,widths:[22,18,78,24,29,34,16,25,52,16,65,48,65],dimension:`A1:M${last}`,mergeRefs:["A1:M1","A2:M2","A3:M3"],freezeRows:5,autoFilter:`A5:M${last}`,validations});
  }
  function statisticsSheet(metadata,posts,stats) {
    const last=Math.max(6,posts.length+5),range=c=>`'Publicaciones'!$${c}$6:$${c}$${last}`;
    const map=new Map(),add=(r,cells,h=26)=>{const old=map.get(r)||{cells:[],h};old.cells.push(...cells);old.h=Math.max(old.h,h);map.set(r,old);};
    const label=(c,r,v)=>stringCell(`${c}${r}`,v,3),num=(c,r,f,n)=>n === "" ? `<c r="${c}${r}" s="6" t="str"><f>${xml(f)}</f><v></v></c>` : formulaCell(`${c}${r}`,f,n,6);
    const headers=(r,start,items)=>add(r,items.map((v,i)=>stringCell(`${columnName(start+i)}${r}`,v,2)),40);
    headers(1,1,["Sección","Categoría","Publicaciones","Porcentaje del total (%)","Estado"]);
    headers(5,7,["Sección","Categoría","Publicaciones","Porcentaje del total (%)"]);
    const networks=Object.entries(stats.platforms).filter(([key])=>stats.observed.includes(key));
    const slots=networks.length?networks:[[global.ExtractorStatistics.network(metadata.platform),0]];
    slots.forEach(([name,n],i)=>{const r=i+2;add(r,[label("A",r,"Red"),label("B",r,name),num("C",r,`COUNTIF(${range("G")},B${r})`,n),num("D",r,`IFERROR(C${r}/COUNTA(${range("A")})*100,0)`,stats.percent(n)*100)]);});
    ["Infografía","Video","Fotografía","Texto"].forEach((name,i)=>{const r=i+6,n=stats.formats[name]||0;add(r,[label("A",r,"Formato"),label("B",r,name),num("C",r,`COUNTIF(${range("D")},B${r})`,n),num("D",r,`IFERROR(C${r}/COUNTA(${range("A")})*100,0)`,stats.percent(n)*100)]);});
    ["Propias","Gobernador","Gobierno del Estado"].forEach((name,i)=>{const r=i+6,n=stats.belongings[name]||0;add(r,[label("G",r,"Pertenencia"),label("H",r,name),num("I",r,`COUNTIF(${range("E")},H${r})`,n),num("J",r,`IFERROR(I${r}/COUNTA(${range("A")})*100,0)`,stats.percent(n)*100)]);});
    Object.entries(stats.months).sort().forEach(([month,n],i)=>{const r=i+10,[y,m]=month.split("-").map(Number);add(r,[label("A",r,"Mes"),label("B",r,month),num("C",r,`COUNTIFS(${range("A")},">="&DATE(${y},${m},1),${range("A")},"<"&DATE(${m===12?y+1:y},${m===12?1:m+1},1))`,n),num("D",r,`IFERROR(C${r}/COUNTA(${range("A")})*100,0)`,stats.percent(n)*100)]);});
    const start=Math.max(15,13+Object.keys(stats.months).length);
    headers(start-1,1,["Sección","Categoría","Publicaciones","Porcentaje del total (%)"]);
    const seen=new Set();
    posts.forEach((p,i)=>{
      const r=start+i,source=i+6,first=p.topic&&!seen.has(p.topic),n=first?stats.topics[p.topic]||0:0;seen.add(p.topic);
      const crit=`SUBSTITUTE(SUBSTITUTE(SUBSTITUTE('Publicaciones'!F${source},"~","~~"),"*","~*"),"?","~?")`;
      const topic=`IF(AND('Publicaciones'!F${source}<>"",COUNTIF('Publicaciones'!$F$6:F${source},${crit})=1),'Publicaciones'!F${source},"")`;
      add(r,[`<c r="A${r}" s="3" t="str"><f>IF(B${r}="","","Tema o proyecto")</f><v>${first?"Tema o proyecto":""}</v></c>`,`<c r="B${r}" s="3" t="str"><f>${xml(topic)}</f><v>${xml(first?p.topic:"")}</v></c>`,num("C",r,`IF(B${r}="","",COUNTIF(${range("F")},${crit}))`,first?n:""),num("D",r,`IF(B${r}="","",IFERROR(C${r}/COUNTA(${range("A")})*100,0))`,first?stats.percent(n)*100:"" )]);
    });
    const pending=metadata.tiktokDiagnostics?.pending || [],pendingMerges=[];
    let bottom=Math.max(15,start+posts.length-1);
    if(pending.length) {
      const heading=bottom+3;
      headers(heading,1,["Pendientes sin incluir en conteos","Identificador","Enlace"]);
      pendingMerges.push(`C${heading}:J${heading}`);
      pending.forEach((p,i)=>{const r=heading+i+1;add(r,[label("A",r,"Sin extraer"),label("B",r,p.id),stringCell(`C${r}`,p.url,4)],34);pendingMerges.push(`C${r}:J${r}`);});
      bottom=heading+pending.length;
    }
    const rows=[...map].sort((a,b)=>a[0]-b[0]).map(([r,v])=>rowXml(r,v.cells,v.h));
    return worksheet({rows,widths:[23,36,20,28,18,3,23,34,20,28],dimension:`A1:J${bottom}`,mergeRefs:pendingMerges});
  }
  async function buildWorkbook({metadata,posts}) {
    posts=global.ExtractorStatistics.prepare(posts,metadata);
    const stats=global.ExtractorStatistics.report(posts,metadata);
    const types=`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${[1,2].map(i=>`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
    const rels=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const wb=`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Publicaciones" sheetId="1" r:id="rId1"/><sheet name="Estadísticas" sheetId="2" r:id="rId2"/></sheets><calcPr fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
    const wbRels=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1,2].map(i=>`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    return makeZip([{name:"[Content_Types].xml",data:types},{name:"_rels/.rels",data:rels},{name:"xl/workbook.xml",data:wb},{name:"xl/_rels/workbook.xml.rels",data:wbRels},{name:"xl/styles.xml",data:STYLES_XML},{name:"xl/worksheets/sheet1.xml",data:publicationsSheet(metadata,posts)},{name:"xl/worksheets/sheet2.xml",data:statisticsSheet(metadata,posts,stats)}],"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  global.ExtractorXXlsx=Object.freeze({buildWorkbook,makeZip,exportName});
})(globalThis);
