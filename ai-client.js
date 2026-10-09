(function(global){
  'use strict';
  const MODEL='gemini-3.5-flash-lite',VERSION='classification-1.29-1';
  function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])]));return value;}
  async function fingerprint(p,settings){const data={version:VERSION,model:MODEL,settings,post:{id:String(p.id),platform:p.platform,author:p.author,text:p.fullText||p.text||'',quotedText:p.quotedText||'',quotedAuthor:p.quotedAuthor||'',postKind:p.postKind||'',hasVideo:Boolean(p.hasVideo),hasPhoto:Boolean(p.hasPhoto),photoCount:Number(p.photoCount)||0,mediaVerified:Boolean(p.mediaVerified),mediaUrls:p.mediaUrls||[],mediaAltTexts:p.mediaAltTexts||[],videoPoster:p.videoPoster||'',belongingVerdict:p.belongingVerdict||null}};const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable(data))));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
  async function classify(posts,settings,apiKey,options={}){
    const runtime=options.runtime;if(!runtime)throw Error('No se inicializó el cliente de IA.');
    const jobId=crypto.randomUUID(),concurrency=Math.max(1,Math.min(3,Number(options.concurrency)||2)),rpm=Math.max(1,Math.min(120,Number(options.rpm)||10)),stored=new Map((options.stored||[]).map(p=>[String(p.id),p]));
    const merged={ok:true,results:{},failedBatches:[],model:MODEL,analyzedWithImages:0,reused:0,manual:0,pending:0,stopped:''};let completed=0,failed=0,next=0,stop=false,active=0,stage='',queue=[],timer;
    let lastPing=Date.now();const started=Date.now();options.onJob?.(jobId);
    function emit(){const elapsed=Math.max(0,Date.now()-started);options.onProgress?.({completed,total:posts.length,reused:merged.reused,manual:merged.manual,failed,active,elapsed,stage,pending:Math.max(0,posts.length-completed),remainingMs:completed>merged.reused+merged.manual?elapsed/(completed-merged.reused-merged.manual)*Math.max(0,posts.length-completed):null});}
    function stopped(){return stop||options.isCancelled?.()||options.shouldFinish?.();}
    const progress=(m)=>{if(m?.type==='GEMINI_PROGRESS'&&m.jobId===jobId){stage=String(m.detail||'');emit();}return false;};
    if(runtime.onMessage)runtime.onMessage.addListener(progress);
    try{
      const prepared=await Promise.all(posts.map(async p=>({post:p,fingerprint:await fingerprint(p,settings)})));
      for(const entry of prepared){const id=String(entry.post.id),previous=stored.get(id);if(previous?.overrides?.format&&previous.overrides.belonging&&previous.overrides.topic){merged.manual++;completed++;continue;}
        if(!options.force&&previous?.aiFingerprint===entry.fingerprint&&previous.aiResult&&!previous.aiResult.imageAnalysisMissing){merged.results[id]=previous.aiResult;merged.reused++;completed++;if(previous.aiResult.imagesAnalyzed)merged.analyzedWithImages++;continue;}queue.push(entry);
      }
      emit();timer=setInterval(()=>{emit();if(Date.now()-lastPing>=10000){lastPing=Date.now();runtime.sendMessage({type:"GEMINI_PING",jobId}).catch(()=>{});}},1000);
      async function worker(){while(next<queue.length&&!stopped()){
        const batch=queue.slice(next,next+5);next+=batch.length;active++;emit();let response;
        try{response=await runtime.sendMessage({type:'GEMINI_CLASSIFY',jobId,posts:batch.map(e=>e.post),settings,apiKey,options:{rpm}});}
        catch(e){response={ok:false,error:e.message};}
        active--;if(options.isCancelled?.())break;
        const results=response?.results||{},success=[];let missing=0;
        for(const entry of batch){const result=results[String(entry.post.id)];if(result){merged.results[String(entry.post.id)]=result;success.push({...entry,result});}else missing++;}
        if(success.length)await options.onBatch?.(success);
        merged.analyzedWithImages+=Number(response?.analyzedWithImages)||0;
        if(missing){failed+=missing;merged.failedBatches.push({ids:batch.filter(e=>!results[String(e.post.id)]).map(e=>String(e.post.id)),error:response?.error||response?.failedBatches?.[0]?.error||'Gemini no devolvió una clasificación.'});}
        completed+=batch.length;
        if(response?.quotaExhausted||response?.fatal){stop=true;merged.stopped=response.quotaExhausted?'Cuota de Gemini alcanzada':'Gemini rechazó la solicitud';}
        stage='';emit();
      }}
      const settled=await Promise.allSettled(Array.from({length:Math.min(concurrency,Math.ceil(queue.length/5))},worker));
      const failure=settled.find(r=>r.status==='rejected');if(failure)throw failure.reason;
      if(options.isCancelled?.())throw Error('Extracción cancelada.');
      if(options.shouldFinish?.())merged.stopped='Exportación solicitada durante la clasificación';
      merged.pending=posts.length-completed;emit();return merged;
    }finally{if(timer)clearInterval(timer);runtime.onMessage?.removeListener?.(progress);await runtime.sendMessage({type:'GEMINI_END',jobId}).catch(()=>{});options.onJob?.(null);}
  }
  global.ExtractorAIClient=Object.freeze({MODEL,VERSION,fingerprint,classify});
})(globalThis);
