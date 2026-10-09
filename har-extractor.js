(function(global){
'use strict';
const legacy=global.FBHarExtractor;
async function extractFiles(files,start='',end='',progress=null){
 if(start&&end)global.ExtractorXCore.parseDateRange(start,end);
 const unique=new Map(),diag={archivos:[],entradas_har:0,respuestas:0,documentos:0,duplicados:0,errores:[]};
 for(let i=0;i<files.length;i++){
  const file=files[i];progress?.(`Leyendo ${file.name} (${i+1}/${files.length})…`);
  try{
   if(file.size>150*1024*1024)throw Error('El archivo supera 150 MB. Divídelo en capturas más cortas.');
   const text=(await file.text()).replace(/^\uFEFF/,''),har=JSON.parse(text);
   if(!Array.isArray(har?.log?.entries))throw Error('No tiene una estructura HAR válida.');
   const parsed=global.ExtractorFacebookData.fromHAR(har);
   // El parser anterior conserva únicamente sus métricas complementarias.
   // Autor, fecha, texto y medios proceden del mismo parser que la extensión.
   const metrics=new Map((await legacy.extractFiles([{name:file.name,text:async()=>text}])).rows.map(p=>[String(p.post_id),p]));
   diag.entradas_har+=har.log.entries.length;diag.respuestas+=parsed.responses;diag.documentos+=parsed.documents;diag.archivos.push({nombre:file.name,publicaciones:parsed.posts.length,respuestas:parsed.responses});
   for(const raw of parsed.posts){const old=metrics.get(String(raw.id)),post={...raw,captureSource:'HAR importado',sourceFile:file.name,reacciones:old?.reacciones??null,comentarios:old?.comentarios??null,compartidos:old?.compartidos??null},key=post.authorId+':'+post.id;if(unique.has(key))diag.duplicados++;unique.set(key,global.ExtractorFacebookData.merge(unique.get(key),post));}
  }catch(e){diag.errores.push(`${file.name}: ${e.message}`);}
  await new Promise(r=>setTimeout(r,0));
 }
 if(!diag.archivos.length)throw Error(diag.errores.join('\n')||'No se pudo leer ningún HAR.');
 let posts=[...unique.values()].sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt));
 if(start)posts=posts.filter(p=>global.ExtractorXCore.localParts(p.publishedAt).date>=start);
 if(end)posts=posts.filter(p=>global.ExtractorXCore.localParts(p.publishedAt).date<=end);
 diag.publicaciones_finales=posts.length;
 return {posts,diag,profiles:profiles(posts)};
}
function profiles(posts){const by=new Map();for(const p of posts){const v=by.get(p.authorId)||{id:p.authorId,handle:p.author,name:p.institutionName||p.authorName||p.author,count:0};v.count++;by.set(p.authorId,v);}return [...by.values()].sort((a,b)=>b.count-a.count);}
global.FBHarExtractor=Object.freeze({extractFiles,profiles});
})(globalThis);
