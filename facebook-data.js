(function(global){
  'use strict';
  const normalize=v=>String(v||'').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').replace(/\s+/g,' ').trim();
  function facebookUrl(value){try{const u=new URL(value);if(!/(^|\.)facebook\.com$/i.test(u.hostname))return '';['__cft__','__tn__','ref','mibextid','comment_id','reply_comment_id'].forEach(k=>u.searchParams.delete(k));return u.href;}catch{return '';}}
  function actorHandle(url){try{const u=new URL(url);return u.pathname==='/profile.php'?u.searchParams.get('id')||'':u.pathname.split('/').filter(Boolean)[0]||'';}catch{return '';}}
  function documents(text){const result=[],lines=String(text||'').replace(/^\uFEFF/,'').replace(/^for\s*\(;;\);\s*/,'').split(/\r?\n/);for(let line of lines){line=line.trim().replace(/^for\s*\(;;\);\s*/,'');if(!line)continue;try{result.push(JSON.parse(line));}catch{}}if(!result.length){try{result.push(JSON.parse(String(text||'').trim().replace(/^for\s*\(;;\);\s*/,'')));}catch{}}return result;}
  const skip=new Set(['feedback','trackingdata','encrypted_tracking','debug_info','creation_story','comment_rendering_instance','top_level_comments','display_comments']);
  function walk(root,callback,max=150000){const stack=[root];let n=0;while(stack.length&&n++<max){const v=stack.pop();if(!v||typeof v!=='object')continue;callback(v);for(const [key,child]of Object.entries(v))if(!skip.has(key)&&child&&typeof child==='object')stack.push(child);}}
  function message(story){
    const content=story.comet_sections?.content?.story;
    const direct=story.message?.text||content?.message?.text||content?.comet_sections?.message?.story?.message?.text||content?.comet_sections?.message_container?.story?.message?.text;
    if(typeof direct==='string'&&direct.trim())return normalize(direct);
    // Adaptado del generador HAR: limitar la búsqueda a contenido, sin comentarios.
    const texts=[];walk(story.comet_sections?.content||{},value=>{
      if(typeof value.message?.text==='string'&&value.message.text.trim())texts.push(value.message.text);
      if(typeof value.text==='string'&&value.text.trim().length>=8)texts.push(value.text);
    });
    return normalize(texts.sort((a,b)=>b.length-a.length)[0]||'');
  }
  function media(story){
    const found=new Map(),content=story.comet_sections?.content?.story;
    const roots=[story.attachments,content?.attachments,story.attached_story?.attachments,content?.attached_story?.attachments].filter(Boolean);
    for(const root of roots)walk(root,value=>{
      const type=value.__typename;
      if(type!=='Photo'&&type!=='Video')return;
      const image=type==='Photo'?(value.photo_image||value.image||value.viewer_image):(value.preferred_thumbnail?.image||value.thumbnailImage||value.image||value.thumbnail);
      const uri=typeof image==='string'?image:image?.uri||image?.url||'';
      const key=type+':'+(value.id||uri);
      const prior=found.get(key);
      if(!prior||(!prior.uri&&uri))found.set(key,{type,id:String(value.id||''),uri,alt:normalize(value.accessibility_caption||'')});
    });
    const values=[...found.values()],videos=values.filter(v=>v.type==='Video'),photos=values.filter(v=>v.type==='Photo');
    return {mediaItems:values.slice(0,100),hasVideo:videos.length>0,hasPhoto:photos.length>0,photoCount:photos.length,mediaUrls:[...new Set(values.map(v=>v.uri).filter(v=>/^https:\/\//.test(v)))].slice(0,24),mediaAltTexts:values.map(v=>v.alt).filter(Boolean),videoPoster:videos.find(v=>v.uri)?.uri||'',mediaVerified:true};
  }
  function record(story){
    const id=String(story.post_id||'');const seconds=Number(story.creation_time);const actor=story.actors?.[0];
    if(!id||!Number.isFinite(seconds)||seconds<1000000000||seconds>2200000000||!actor?.id)return null;
    const authorId=String(actor.id),authorUrl=facebookUrl(actor.url),author=actorHandle(authorUrl);
    const url=facebookUrl(story.permalink_url||story.url)||`https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(id)}&id=${encodeURIComponent(authorId)}`;
    const attached=story.attached_story||story.comet_sections?.content?.story?.attached_story;
    const detectedMedia=media(story);
    if(/\/(?:reel|videos)\//i.test(url))detectedMedia.hasVideo=true;
    return {id,platform:'facebook',author,authorId,authorName:normalize(actor.name),authorUrl,publishedAt:new Date(seconds*1000).toISOString(),text:message(story),url,...detectedMedia,quotedText:attached?message(attached):'',quotedAuthor:actorHandle(attached?.actors?.[0]?.url||''),isOwn:true,dateApproximate:false,dateSource:'creation_time de la respuesta de Facebook',captureSource:'Respuesta de Facebook',postKind:'',};
  }
  function merge(previous,next){if(!previous)return next;const urls=[...new Set([...(previous.mediaUrls||[]),...(next.mediaUrls||[])])].slice(0,24);return {...previous,...next,text:next.text||previous.text,quotedText:next.quotedText||previous.quotedText,hasVideo:previous.hasVideo||next.hasVideo,hasPhoto:previous.hasPhoto||next.hasPhoto,photoCount:Math.max(previous.photoCount||0,next.photoCount||0),mediaUrls:urls,mediaItems:(next.mediaItems?.length||0)>=(previous.mediaItems?.length||0)?next.mediaItems:previous.mediaItems,videoPoster:next.videoPoster||previous.videoPoster};}
  function storyId(value){
    if(/^\d+$/.test(String(value.post_id||'')))return String(value.post_id);
    try{const decoded=atob(value.id||''),m=decoded.match(/^S:_I\d+:(\d+)(?::|$)/);if(m)return m[1];}catch{}
    return '';
  }
  function createReader(){
    const pieces=new Map();
    function parse(text){
      const docs=documents(text),profileIds=new Set(),types=new Map();let stories=0;
      for(const doc of docs)walk(doc,value=>{
        if(value.__typename)types.set(value.__typename,(types.get(value.__typename)||0)+1);
        if(value.timeline_list_feed_units&&/^\d+$/.test(String(value.id||'')))profileIds.add(String(value.id));
        if(value.__typename!=='Story'&&!value.__isFeedUnit)return;
        stories++;const id=storyId(value);if(!id)return;
        const previous=pieces.get(id)||{post_id:id,__typename:'Story'};
        const content=value.comet_sections?.content?.story,header=value.comet_sections?.header?.story,timestamp=value.comet_sections?.timestamp?.story;
        const actor=value.actors?.[0]||header?.actors?.[0]||content?.actors?.[0];
        const date=value.creation_time||timestamp?.creation_time||content?.creation_time;
        const textValue=message(value),current=media(value);
        const items=new Map((previous._media||[]).map(m=>[m.type+':'+(m.id||m.uri),m]));
        for(const m of current.mediaItems||[]){const key=m.type+':'+(m.id||m.uri);if(!items.has(key)||m.uri)items.set(key,m);}
        const joined={...previous,creation_time:date||previous.creation_time,actors:actor?.id?[actor]:previous.actors,message:{text:textValue||previous.message?.text||''},permalink_url:facebookUrl(value.permalink_url||value.url)||previous.permalink_url,attached_story:value.attached_story||content?.attached_story||previous.attached_story,_media:[...items.values()].slice(0,100)};
        joined.attachments=joined._media.map(m=>({media:{__typename:m.type,id:m.id,accessibility_caption:m.alt, ...(m.type==='Photo'?{image:{uri:m.uri}}:{preferred_thumbnail:{image:{uri:m.uri}}})}}));
        pieces.set(id,joined);if(pieces.size>5000)pieces.delete(pieces.keys().next().value);
      });
      const posts=[],incomplete=[];
      for(const [id,piece] of pieces){const p=record(piece);if(p)posts.push(p);else if(incomplete.length<20)incomplete.push({id,hasDate:Boolean(piece.creation_time),hasActor:Boolean(piece.actors?.[0]?.id),authorName:piece.actors?.[0]?.name||'',authorUrl:piece.actors?.[0]?.url||''});}
      return {posts,documents:docs.length,profileIds:[...profileIds],stories,incomplete,types:[...types].sort((a,b)=>b[1]-a[1]).slice(0,20)};
    }
    return {parse};
  }
  function parse(text){return createReader().parse(text);}
  function matches(post,handle){const key=String(handle||'').replace(/^@/,'').toLowerCase();return key&&[post.author,post.authorId,actorHandle(post.authorUrl)].some(v=>String(v||'').toLowerCase()===key);}
  function fromHAR(har){const posts=new Map(),reader=createReader();let responses=0,parsed=0;for(const entry of har?.log?.entries||[]){let u;try{u=new URL(entry.request?.url);}catch{continue;}if(!/(^|\.)facebook\.com$/.test(u.hostname)||!u.pathname.includes('/api/graphql'))continue;let text=entry.response?.content?.text||'';if(entry.response?.content?.encoding==='base64')try{text=decodeURIComponent(escape(atob(text)));}catch{continue;}responses++;const result=reader.parse(text);parsed+=result.documents;for(const p of result.posts)posts.set(p.authorId+':'+p.id,merge(posts.get(p.authorId+':'+p.id),p));}return {posts:[...posts.values()],responses,documents:parsed};}
  function toHAR(posts,metadata){
    const edges=posts.map(p=>{
      const media=p.mediaItems?.length?p.mediaItems:[...(p.hasVideo?[{type:"Video",id:p.id+"_video",uri:p.videoPoster}]:[]),...Array.from({length:p.photoCount||Number(p.hasPhoto)},(_,i)=>({type:"Photo",id:p.id+"_photo_"+i,uri:p.mediaUrls?.[i]||""}))];
      return {node:{__typename:'Story',post_id:p.id,creation_time:Math.floor(Date.parse(p.publishedAt)/1000),permalink_url:p.url,actors:[{id:p.authorId,name:p.authorName,url:p.authorUrl}],message:{text:p.text},attached_story:p.quotedText?{message:{text:p.quotedText},actors:[{url:p.quotedAuthor?`https://www.facebook.com/${p.quotedAuthor}`:''}]}:null,attachments:media.map((m,i)=>({media:{__typename:m.type,id:m.id||`${p.id}_media_${i}`,accessibility_caption:m.alt||'',...(m.type==='Video'?{preferred_thumbnail:{image:{uri:m.uri||''}}}:{image:{uri:m.uri||''}})}}))}};
    });
    const text=JSON.stringify({data:{node:{timeline_list_feed_units:{edges}}}});
    return {log:{version:'1.2',creator:{name:'Extractor Institucional — HAR reducido',version:'1.25'},comment:'Solo publicaciones normalizadas. No es una copia completa de tráfico; no contiene cookies, cabeceras de autenticación ni cuerpos de solicitudes.',pages:[],entries:[{startedDateTime:metadata.generatedAt||new Date().toISOString(),time:0,request:{method:'POST',url:'https://www.facebook.com/api/graphql/',httpVersion:'HTTP/1.1',cookies:[],headers:[],queryString:[],headersSize:-1,bodySize:0},response:{status:200,statusText:'OK',httpVersion:'HTTP/1.1',cookies:[],headers:[],content:{size:new TextEncoder().encode(text).length,mimeType:'application/json',text},redirectURL:'',headersSize:-1,bodySize:new TextEncoder().encode(text).length},cache:{},timings:{send:0,wait:0,receive:0},_extractor:{handle:metadata.handle,from:metadata.from,to:metadata.to}}]}};
  }
  global.ExtractorFacebookData=Object.freeze({parse,createReader,fromHAR,toHAR,matches,merge,record});
})(globalThis);
