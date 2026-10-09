(function(global){
'use strict';
function apply(post){const changes=post.overrides||{},complete=changes.format&&changes.belonging&&changes.topic;return {...post,...changes,...(Object.keys(changes).length?{classificationSource:'Corrección manual guardada',reasoning:complete?'Formato, pertenencia y tema corregidos manualmente.':post.reasoning,...(changes.format?{formatReason:'Formato corregido manualmente.'}:{}),...(changes.belonging?{belongingReason:'Pertenencia corregida manualmente.'}:{}),needsReview:complete?false:post.needsReview}:{})};}
function select(posts,profile,options={}){
 const owned=posts.filter(p=>String(p.authorId)===String(profile.id)||(!p.authorId&&p.author===profile.handle));
 if(!owned.length)throw Error('No hay publicaciones verificables de la cuenta seleccionada.');
 const dates=owned.map(p=>global.ExtractorXCore.localParts(p.publishedAt).date).sort(),from=options.from||dates[0],to=options.to||dates.at(-1),range=global.ExtractorXCore.parseDateRange(from,to);
 const limit=Number(options.maxPosts)||5000;if(!Number.isInteger(limit)||limit<1||limit>5000)throw Error('El máximo debe estar entre 1 y 5000.');
 const filtered=owned.filter(p=>Date.parse(p.publishedAt)>=+range.start&&Date.parse(p.publishedAt)<=+range.end).sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)),raw=filtered.slice(0,limit);
 if(!raw.length)throw Error('No hay publicaciones de esta cuenta en el periodo solicitado.');
 const metadata={platform:'facebook',handle:profile.handle,institutionName:String(options.institutionName||profile.name).trim(),from,to,timeZone:'America/Mexico_City',generatedAt:new Date().toISOString(),facebookDiagnostics:{source:'HAR importado',detected:owned.length,inRange:filtered.length,unresolved:0,stop:raw.length<filtered.length?'Máximo solicitado':'Fin de los HAR disponibles'},profileInfo:{description:options.description||''}};
 const settings=global.ExtractorIdentity.settings(metadata,options.settings||{});if(String(options.extraCriteria||'').trim())settings.extraCriteria=String(options.extraCriteria).trim();
 return {metadata,settings,posts:raw.map(p=>apply({...p,...global.ExtractorXCore.enrichPost({...p,text:p.text??p.fullText},settings,metadata.timeZone)}))};
}
async function dispatch(action,options={}){return global.ExtractorArchiveStore.dispatch({action,...options});}
async function save(metadata,posts){let count=0;for(let i=0;i<posts.length;i+=100)count+=(await dispatch('put',{platform:'facebook',handle:metadata.handle,institutionName:metadata.institutionName,posts:posts.slice(i,i+100)})).count;return count;}
async function stored(handle){return (await dispatch('query',{platform:'facebook',handle,maxPosts:0})).posts;}
function validateBackup(doc){if(doc?.metadata?.platform!=='facebook'||!Array.isArray(doc.posts)||!doc.metadata.handle)throw Error('Selecciona un respaldo datos_facebook_*.json.');const info=global.ExtractorArchiveStore.identity('facebook',doc.metadata.handle);const posts=doc.posts.map(p=>{const safe=global.ExtractorArchiveStore.safePost(p,info);if(!safe)throw Error('El respaldo contiene una publicación sin fecha o enlace verificables.');if(p.overrides){const o=p.overrides;if(o.format&&!global.ExtractorXCore.FORMATS.includes(o.format)||o.belonging&&!global.ExtractorXCore.BELONGINGS.includes(o.belonging)||o.topic!==undefined&&!String(o.topic).trim())throw Error('El respaldo contiene una corrección inválida.');}return {...safe,authorId:safe.authorId||doc.metadata.handle,authorName:safe.authorName||doc.metadata.institutionName||doc.metadata.handle,overrides:p.overrides};});return {metadata:doc.metadata,posts};}
global.FBReport=Object.freeze({apply,select,dispatch,save,stored,validateBackup});
})(globalThis);
