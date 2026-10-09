'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto').webcrypto;
const root=path.resolve(__dirname,'..');let checks=0;
function ok(value,message){assert.ok(value,message);checks++;}
function ctx(extra={},files=['ai-client.js']){const c=vm.createContext({console,crypto,TextEncoder,Uint8Array,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,Date,Math,URL,btoa,...extra});for(const file of files)vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),c,{filename:file});if(c.ExtractorAIClient&&c.chrome){const original=c.ExtractorAIClient;c.ExtractorAIClient={...original,classify:(p,s,k,o={})=>original.classify(p,s,k,{...o,runtime:c.chrome.runtime})};}return c;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const posts=n=>Array.from({length:n},(_,i)=>({id:String(i+1),platform:'x',author:'usep',text:`Texto ${i+1}`,hasPhoto:false}));
const verdict=p=>({id:p.id,format:'Texto',belonging:'Propias',topic:'Inscripciones',confidence:.95,reasoning:'Oferta propia'});
function runtime(handler){const listeners=new Set();return {runtime:{onMessage:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},sendMessage:async m=>handler(m),_listeners:listeners}};}
(async()=>{
 let active=0,peak=0,calls=0,saved=0,progress=[],firstSaved=false;
 let c=ctx({chrome:runtime(async m=>{if(m.type!=='GEMINI_CLASSIFY')return {ok:true};calls++;active++;peak=Math.max(peak,active);await pause(m.posts[0].id==='1'?8:3);active--;if(calls>2)assert.ok(firstSaved);return {ok:true,results:Object.fromEntries(m.posts.map(p=>[p.id,verdict(p)]))};})});
 let result=await c.ExtractorAIClient.classify(posts(16),{},'test',{concurrency:2,onBatch:async entries=>{saved+=entries.length;firstSaved=true;},onProgress:p=>progress.push(p)});
 ok(peak===2&&calls===4&&saved===16,'Dos lotes simultáneos, guardado antes de avanzar');
 ok(Object.keys(result.results).length===16&&progress.at(-1).completed===16,'Progreso contabiliza resultados reales');
 ok(c.chrome.runtime._listeners.size===0,'Limpieza de escuchas');
 const p=posts(1)[0],hash=await c.ExtractorAIClient.fingerprint(p,{});calls=0;
 const cached={...p,aiFingerprint:hash,aiResult:verdict(p)};
 result=await c.ExtractorAIClient.classify([p],{},'test',{stored:[cached]});ok(result.reused===1&&calls===0,'Reutiliza una clasificación idéntica');
 result=await c.ExtractorAIClient.classify([{...p,text:'Cambió el contenido'}],{},'test',{stored:[cached]});ok(result.reused===0&&calls===1,'Cambio de texto invalida caché');
 calls=0;result=await c.ExtractorAIClient.classify([p],{institutionProfile:{name:'Otra'}},'test',{stored:[cached]});ok(calls===1,'Cambio del perfil invalida caché');
 calls=0;await c.ExtractorAIClient.classify([p],{},'test',{stored:[cached],force:true});ok(calls===1,'Reanalizar fuerza una llamada');
 calls=0;await c.ExtractorAIClient.classify([p],{},'test',{stored:[{...cached,aiResult:{...cached.aiResult,imageAnalysisMissing:true}}]});ok(calls===1,'Reintenta clasificaciones sin evidencia visual');
 calls=0;result=await c.ExtractorAIClient.classify([p],{},'test',{stored:[{...cached,overrides:{format:'Fotografía',belonging:'Propias',topic:'Evento'}}],force:true});ok(calls===0&&result.manual===1,'Las tres correcciones manuales evitan IA incluso con reanálisis');
 c=ctx({chrome:runtime(async m=>m.type==='GEMINI_CLASSIFY'?{ok:true,quotaExhausted:true,error:'429'}:{ok:true})});
 result=await c.ExtractorAIClient.classify(posts(30),{},'test',{concurrency:2});ok(result.pending>=20&&result.stopped.includes('Cuota'),'Cuota agotada detiene nuevos lotes y deja pendientes');
 let finish=false,classified=0;
 c=ctx({chrome:runtime(async m=>{if(m.type!=='GEMINI_CLASSIFY')return {};classified+=m.posts.length;return {ok:true,results:Object.fromEntries(m.posts.map(p=>[p.id,verdict(p)]))};})});
 result=await c.ExtractorAIClient.classify(posts(15),{},'test',{concurrency:1,onBatch:()=>{finish=true;},shouldFinish:()=>finish});ok(classified===5&&result.pending===10&&result.stopped,'Exportar ahora conserva el lote y deja de enviar');
 let cancelled=false;
 await assert.rejects(()=>c.ExtractorAIClient.classify(posts(10),{},'test',{concurrency:1,isCancelled:()=>cancelled,onBatch:()=>{cancelled=true;}}),/cancelada/);checks++;
 // Transporte real con fetch simulado: imágenes en paralelo, asociación, caché, abortos y timeout.
 active=0;peak=0;calls=0;
 c=ctx({fetch:async(url)=>{calls++;active++;peak=Math.max(peak,active);await pause(url.endsWith('1')?10:2);active--;return {ok:true,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>new Uint8Array([Number(url.at(-1))]).buffer};}},['ai-transport.js','ai.js']);
 const imagePosts=posts(3).map((p,i)=>({...p,hasPhoto:true,postKind:'photo',mediaUrls:[`https://example.test/${i+1}`]}));
 const built=await c.ExtractorXAI._test.buildParts(imagePosts);ok(peak>1&&built.analyzedWithImages===3,'Descarga imágenes en paralelo');
 const labels=built.parts.filter(p=>p.text?.startsWith('Imagen')).map(p=>p.text);ok(labels.every((label,i)=>label.includes(`ID ${i+1}:`)),'Orden y asociación por ID pese a descargas fuera de orden');
 await c.ExtractorXAI._test.buildParts(imagePosts);ok(calls===3,'Caché temporal evita redescargar la misma imagen');
 await assert.rejects(()=>c.ExtractorAITransport.deadline(()=>new Promise(()=>{}),12),/tiempo/);checks++;
 const controller=new AbortController();const pending=c.ExtractorAITransport.deadline(()=>new Promise(()=>{}),1000,controller.signal);controller.abort(Error('cancelado'));await assert.rejects(()=>pending,/cancelado/);checks++;
 const delay=c.ExtractorAITransport.retryDelay({status:429,headers:new Headers({'retry-after':'70'})},{},0);ok(delay>=70000,'Respeta Retry-After');
 // No modificar criterios o esquema. Cuota prolongada/fatal no produce reintentos infinitos.
 const sha=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 assert.equal(sha(c.ExtractorXAI.buildSystemInstruction({})),'d58ebdcf95bab64b65396cd5b85b3aacbb639f8bed0c0d9a6fd1cd46f0a06692');checks++;
 assert.equal(sha(JSON.stringify(c.ExtractorXAI.RESPONSE_SCHEMA)),'d452dc59c62a24159d87bd31ccbd64a7655890b6cb77dd7e683ba787535f8e27');checks++;
 const transport={check(){},slot:async()=>{},deadline:async f=>f(),sleep:async()=>{},retryDelay:()=>70000,quota(){}};
 calls=0;c=ctx({ExtractorAITransport:transport,fetch:async()=>{calls++;return {status:429,ok:false,headers:new Headers(),json:async()=>({error:{message:'Quota'}})};}},['ai.js']);
 result=await c.ExtractorXAI.enrichWithAI(posts(15),{},'test');ok(calls===1&&result.quotaExhausted&&result.failedBatches.length===1,'429 prolongado termina y reporta lote fallido');
 calls=0;c.fetch=async()=>{calls++;return {status:403,ok:false,headers:new Headers(),json:async()=>({error:{message:'Forbidden'}})};};
 result=await c.ExtractorXAI.enrichWithAI(posts(10),{},'test');ok(calls===1&&result.fatal,'403 no se reintenta');
 calls=0;c.fetch=async()=>{calls++;return calls===1?{status:503,ok:false,headers:new Headers(),json:async()=>({error:{message:'Unavailable'}})}:{status:200,ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify([verdict(p)])}]}}]})};};
 result=await c.ExtractorXAI.enrichWithAI([p],{},'test');ok(calls===2&&result.results['1'],'503 transitorio recuperado');
 console.log(`${checks} comprobaciones Gemini: concurrencia, caché, correcciones, progreso, parada, imágenes, plazos y reintentos: OK.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
