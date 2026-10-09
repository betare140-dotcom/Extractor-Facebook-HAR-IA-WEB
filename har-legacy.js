(function(global){
'use strict';

function getPath(obj, path){
  let cur=obj;
  for(const key of path){
    if(cur && typeof cur==='object' && Object.prototype.hasOwnProperty.call(cur,key)) cur=cur[key];
    else return null;
  }
  return cur;
}

function* iterObjects(root){
  const stack=[root];
  while(stack.length){
    const cur=stack.pop();
    if(!cur || typeof cur!=='object') continue;
    if(Array.isArray(cur)){
      for(let i=cur.length-1;i>=0;i--) stack.push(cur[i]);
    }else{
      yield cur;
      const vals=Object.values(cur);
      for(let i=vals.length-1;i>=0;i--) stack.push(vals[i]);
    }
  }
}

function friendlyName(entry){
  const text=entry?.request?.postData?.text || '';
  try{
    const p=new URLSearchParams(text);
    return p.get('fb_api_req_friendly_name') || '';
  }catch(_){
    const m=text.match(/(?:^|&)fb_api_req_friendly_name=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
}

function decodeBase64Utf8(text){
  try{
    const bin=atob(text);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    return new TextDecoder('utf-8',{fatal:false}).decode(bytes);
  }catch(_){ return ''; }
}

function responseText(entry){
  const content=entry?.response?.content || {};
  const text=content.text || '';
  return content.encoding==='base64' && text ? decodeBase64Utf8(text) : text;
}

function jsonChunks(text){
  const out=[];
  if(!text) return out;
  const lines=text.split(/\r?\n/);
  for(let line of lines){
    line=line.trim();
    if(!line) continue;
    if(line.startsWith('for (;;);')) line=line.slice('for (;;);'.length).trimStart();
    try{ out.push(JSON.parse(line)); }catch(_){ /* streamed non-json fragment */ }
  }
  if(out.length===0){
    let s=text.trim();
    if(s.startsWith('for (;;);')) s=s.slice('for (;;);'.length).trimStart();
    try{ out.push(JSON.parse(s)); }catch(_){ /* ignore */ }
  }
  return out;
}

function* storyNodes(payload){
  for(const d of iterObjects(payload)){
    if(d.__typename==='Story' && d.post_id && d.creation_time && d.permalink_url && Array.isArray(d.actors)) yield d;
  }
}

function extractMessage(story){
  const candidates=[
    getPath(story,['comet_sections','content','story','message','text']),
    getPath(story,['comet_sections','content','story','comet_sections','message','story','message','text']),
    getPath(story,['comet_sections','content','story','comet_sections','message_container','story','message','text'])
  ];
  for(const c of candidates) if(typeof c==='string' && c.trim()) return c.trim();

  const content=getPath(story,['comet_sections','content']) || {};
  const texts=[];
  for(const d of iterObjects(content)){
    const msg=d.message;
    if(msg && typeof msg==='object' && typeof msg.text==='string' && msg.text.trim()) texts.push(msg.text.trim());
    if(typeof d.text==='string' && d.text.trim().length>=8) texts.push(d.text.trim());
  }
  if(!texts.length) return '';
  texts.sort((a,b)=>b.length-a.length);
  return texts[0];
}

function extractMentions(story,message){
  const vals=[];
  try{
    const matches=(message||'').match(/(?<![\p{L}\p{N}_])[#@][\p{L}\p{N}_]+/gu) || [];
    vals.push(...matches);
  }catch(_){
    const matches=(message||'').match(/[#@][A-Za-z0-9_ÁÉÍÓÚÜÑáéíóúüñ]+/g) || [];
    vals.push(...matches);
  }
  const content=getPath(story,['comet_sections','content']) || {};
  for(const d of iterObjects(content)){
    if(!Array.isArray(d.ranges)) continue;
    for(const r of d.ranges){
      const ent=r && typeof r==='object' ? r.entity : null;
      if(!ent || typeof ent!=='object') continue;
      const typ=ent.__typename || '';
      if(['User','Page','Profile'].includes(typ)){
        const name=ent.name || ent.short_name;
        if(name) vals.push(String(name).trim());
      }else if(typ==='Hashtag'){
        const url=ent.url || '';
        const m=url.match(/\/hashtag\/([^?/#]+)/);
        if(m){ try{ vals.push('#'+decodeURIComponent(m[1])); }catch(_){} }
      }
    }
  }
  const seen=new Set(), out=[];
  for(const raw of vals){
    const v=String(raw||'').trim();
    if(!v) continue;
    const k=v.toLocaleLowerCase('es-MX');
    if(!seen.has(k)){seen.add(k);out.push(v);}
  }
  return out.join(', ');
}

function collectTypenames(obj){
  const out=[];
  for(const d of iterObjects(obj)) if(d.__typename) out.push(String(d.__typename));
  return out;
}

function detectFormat(story){
  const url=String(story.permalink_url||'').toLowerCase();
  const attachments=story.attachments || [];
  const types=collectTypenames(attachments);
  if(url.includes('/reel/') || types.some(t=>t.includes('Shorts')||t.includes('Reel'))) return 'Reel';
  if(types.some(t=>t==='Video'||t.includes('Video'))) return 'Video';
  const photos=types.filter(t=>t==='Photo').length;
  if(photos>2 || types.some(t=>t.includes('Album'))) return 'Álbum / fotografías';
  if(photos) return 'Fotografía';
  if(Array.isArray(attachments) ? attachments.length : !!attachments) return 'Enlace / adjunto';
  return 'Texto';
}

function metricFromRenderers(story,kind){
  const renderers=getPath(story,['comet_sections','feedback','story','story_ufi_container','story','feedback_context','feedback_target_with_context','comet_ufi_summary_and_actions_renderer','feedback','adaptive_ufi_action_renderers']);
  if(!Array.isArray(renderers)) return null;
  for(const item of renderers){
    const fb=item && typeof item==='object' ? item.feedback : null;
    if(!fb || typeof fb!=='object') continue;
    let v=null;
    if(kind==='reactions') v=getPath(fb,['reaction_count','count']);
    else if(kind==='comments') v=getPath(fb,['comment_rendering_instance','comments','total_count']);
    else if(kind==='shares'){
      v=getPath(fb,['share_count','count']);
      if(!Number.isFinite(v)) v=fb.i18n_share_count;
    }
    if(Number.isFinite(v)) return Math.trunc(v);
  }
  return null;
}

function metricFallback(story,kind){
  const values=[];
  const feedback=getPath(story,['comet_sections','feedback']) || {};
  for(const d of iterObjects(feedback)){
    if(kind==='reactions'){
      if(d.reaction_count && Number.isFinite(d.reaction_count.count)) values.push(Math.trunc(d.reaction_count.count));
      if(Number.isFinite(d.i18n_reaction_count)) values.push(Math.trunc(d.i18n_reaction_count));
    }else if(kind==='comments'){
      if(d.comments && Number.isFinite(d.comments.total_count)) values.push(Math.trunc(d.comments.total_count));
    }else if(kind==='shares'){
      if(d.share_count && Number.isFinite(d.share_count.count)) values.push(Math.trunc(d.share_count.count));
      if(Number.isFinite(d.i18n_share_count)) values.push(Math.trunc(d.i18n_share_count));
    }
  }
  return values.length ? Math.max(...values) : null;
}

function metric(story,kind){
  const v=metricFromRenderers(story,kind);
  return v!==null ? v : metricFallback(story,kind);
}

function actor(story){
  const a=Array.isArray(story.actors) && story.actors[0] && typeof story.actors[0]==='object' ? story.actors[0] : {};
  return {name:a.name||a.short_name||'',id:a.id||'',url:a.url||''};
}

function mexicoParts(timestamp){
  const dt=new Date(Number(timestamp)*1000);
  try{
    const fmt=new Intl.DateTimeFormat('es-MX',{timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    const p={}; for(const part of fmt.formatToParts(dt)) p[part.type]=part.value;
    return {fecha:`${p.day}/${p.month}/${p.year}`,hora:`${p.hour}:${p.minute}:${p.second}`,ymd:`${p.year}-${p.month}-${p.day}`,iso:`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}-06:00`};
  }catch(_){
    const shifted=new Date(dt.getTime()-6*3600000);
    const pad=n=>String(n).padStart(2,'0');
    const y=shifted.getUTCFullYear(),m=pad(shifted.getUTCMonth()+1),d=pad(shifted.getUTCDate()),h=pad(shifted.getUTCHours()),mi=pad(shifted.getUTCMinutes()),s=pad(shifted.getUTCSeconds());
    return {fecha:`${d}/${m}/${y}`,hora:`${h}:${mi}:${s}`,ymd:`${y}-${m}-${d}`,iso:`${y}-${m}-${d}T${h}:${mi}:${s}-06:00`};
  }
}

function storyToRow(story,sourceFile,friendly){
  const ts=Number(story.creation_time||0);
  const t=mexicoParts(ts);
  const a=actor(story);
  const msg=extractMessage(story);
  return {
    fecha:t.fecha,hora:t.hora,fecha_iso:t.iso,fecha_ymd:t.ymd,timestamp:ts,
    cuenta:a.name,cuenta_id:a.id,cuenta_url:a.url,publicacion:msg,
    url:story.permalink_url||'',post_id:String(story.post_id||''),formato:detectFormat(story),
    reacciones:metric(story,'reactions'),comentarios:metric(story,'comments'),compartidos:metric(story,'shares'),
    menciones:extractMentions(story,msg),consulta_graphql:friendly||'',archivo_origen:sourceFile
  };
}

function richerScore(r){
  return String(r.publicacion||'').length + ['reacciones','comentarios','compartidos'].reduce((s,k)=>s+(Number(r[k])||0),0);
}

async function extractFiles(files,startYmd='',endYmd='',progressCb=null){
  const byId=new Map();
  const diag={archivos:[],entradas_har:0,solicitudes_graphql:0,solicitudes_timeline:0,chunks_json:0,historias_detectadas:0,duplicados:0,errores:[]};
  for(let fi=0;fi<files.length;fi++){
    const file=files[fi];
    const fd={archivo:file.name,entradas:0,timeline:0,historias:0}; diag.archivos.push(fd);
    if(progressCb) progressCb(`Leyendo ${file.name} (${fi+1}/${files.length})…`);
    let har;
    try{ har=JSON.parse(await file.text()); }
    catch(e){diag.errores.push(`${file.name}: ${e.message}`);continue;}
    const entries=har?.log?.entries || [];
    diag.entradas_har+=entries.length; fd.entradas=entries.length;
    for(let ei=0;ei<entries.length;ei++){
      const entry=entries[ei];
      const url=entry?.request?.url || '';
      if(!String(url).toLowerCase().includes('graphql')) continue;
      diag.solicitudes_graphql++;
      const friendly=friendlyName(entry);
      if(friendly.includes('TimelineFeed') || friendly.includes('Timeline')){diag.solicitudes_timeline++;fd.timeline++;}
      const text=responseText(entry);
      for(const payload of jsonChunks(text)){
        diag.chunks_json++;
        for(const story of storyNodes(payload)){
          diag.historias_detectadas++;fd.historias++;
          const row=storyToRow(story,file.name,friendly);
          if(!row.post_id) continue;
          const old=byId.get(row.post_id);
          if(!old) byId.set(row.post_id,row);
          else {diag.duplicados++; if(richerScore(row)>richerScore(old)) byId.set(row.post_id,row);}
        }
      }
      if(progressCb && ei%50===0) progressCb(`${file.name}: ${ei}/${entries.length} entradas revisadas; ${byId.size} publicaciones únicas…`);
      if(ei%100===0) await new Promise(r=>setTimeout(r,0));
    }
  }
  let rows=[...byId.values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  if(startYmd) rows=rows.filter(r=>r.fecha_ymd>=startYmd);
  if(endYmd) rows=rows.filter(r=>r.fecha_ymd<=endYmd);
  diag.publicaciones_finales=rows.length;
  diag.fecha_minima=rows.length?rows[0].fecha_iso:null;diag.fecha_maxima=rows.length?rows[rows.length-1].fecha_iso:null;
  diag.cuentas={};diag.formatos={};
  for(const r of rows){diag.cuentas[r.cuenta||'(sin cuenta)']=(diag.cuentas[r.cuenta||'(sin cuenta)']||0)+1;diag.formatos[r.formato]=(diag.formatos[r.formato]||0)+1;}
  return {rows,diag};
}

global.FBHarExtractor={extractFiles};
if(typeof module!=='undefined' && module.exports) module.exports=global.FBHarExtractor;
})(typeof window!=='undefined'?window:globalThis);
