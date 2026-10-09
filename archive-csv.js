(function(global){
  'use strict';
  function parse(text){text=String(text).replace(/^\uFEFF/,'');const lines=text.split(/\r?\n/),first=lines.find(l=>/enlace/i.test(l)&&/pertenencia/i.test(l))||lines[0]||'',delimiter=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';if(c==='\r'&&text[i+1]==='\n')i++;}else cell+=c;}
    if(quoted)throw Error('CSV con comillas sin cerrar.');row.push(cell);if(row.some(x=>x.trim()))rows.push(row);return rows;
  }
  function corrections(text){const rows=parse(text),fold=s=>String(s).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim(),index=rows.findIndex(row=>row.some(c=>fold(c)==='enlace')&&row.some(c=>fold(c)==='pertenencia'));
    if(index<0)throw Error('No se encontró el encabezado de Publicaciones con Enlace y Pertenencia.');const head=rows[index].map(fold),link=head.indexOf('enlace'),format=head.indexOf('tipo de publicacion'),belonging=head.indexOf('pertenencia'),topic=head.indexOf('tema o proyecto');if(format<0||topic<0)throw Error('Faltan las columnas Tipo de publicación o Tema o proyecto.');return rows.slice(index+1).filter(r=>r[link]?.trim()).map(r=>({url:r[link].trim(),changes:{format:r[format]?.trim(),belonging:r[belonging]?.trim(),topic:r[topic]?.trim()}}));
  }
  global.ExtractorArchiveCSV=Object.freeze({parse,corrections});
})(globalThis);
