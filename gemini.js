(function(global){
'use strict';
function createRuntime(){const jobs=new Map(),listeners=new Set();return {onMessage:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},async sendMessage(m){
 if(m.type==='GEMINI_CLASSIFY'){
  let job=jobs.get(m.jobId);if(!job){job=new AbortController();jobs.set(m.jobId,job);}
  const controller=new AbortController(),abort=()=>controller.abort(job.signal.reason);job.signal.addEventListener('abort',abort,{once:true});if(job.signal.aborted)abort();const timer=setTimeout(()=>controller.abort(Error('Se agotó el tiempo del lote de Gemini.')),210000);
  try{return {ok:true,...await global.ExtractorXAI.enrichWithAI(m.posts,m.settings,m.apiKey,null,{...m.options,signal:controller.signal,onStatus:detail=>{for(const listener of listeners)listener({type:'GEMINI_PROGRESS',jobId:m.jobId,detail});}})};}
  catch(e){return {ok:false,error:e.message};}finally{clearTimeout(timer);job.signal.removeEventListener('abort',abort);}
 }
 if(m.type==='GEMINI_CANCEL'||m.type==='GEMINI_END'){jobs.get(m.jobId)?.abort(Error('Clasificación interrumpida.'));if(m.type==='GEMINI_END')jobs.delete(m.jobId);}return {ok:true};
 }};}
const runtime=createRuntime();
global.GeminiClassifier=Object.freeze({runtime,classify:(posts,settings,key,options={})=>global.ExtractorAIClient.classify(posts,settings,key,{...options,runtime}),cancel:jobId=>runtime.sendMessage({type:'GEMINI_CANCEL',jobId})});
})(globalThis);
