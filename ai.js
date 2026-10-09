(function initExtractorAI(global) {
  "use strict";
  const GEMINI_MODEL = "gemini-3.5-flash-lite";
  const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
  const BATCH_SIZE = 5;
  const MAX_IMAGE_BYTES = 2500000;
  const FORMATS = ["Infografía", "Video", "Fotografía", "Texto"];
  const BELONGINGS = ["Propias", "Gobernador", "Gobierno del Estado"];
  const RESPONSE_SCHEMA = { type: "array", items: { type: "object", additionalProperties: false, properties: {
    id: { type: "string" }, textSummary: { type: "string" }, format: { type: "string", enum: FORMATS },
    belonging: { type: "string", enum: BELONGINGS }, topic: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 }, reasoning: { type: "string" }
  }, required: ["id", "textSummary", "format", "belonging", "topic", "confidence", "reasoning"] } };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  async function fetchImagePart(url,signal){if(!url||!/^https:\/\//i.test(url))return null;return global.ExtractorAITransport.image(url,signal,bytesToBase64);}
  function buildSystemInstruction(settings) {
    const gov = (settings.governmentHandles || []).map((v) => `@${v}`).join(", ") || "sin cuentas configuradas";
    const governor = (settings.governorHandles || []).map((v) => `@${v}`).join(", ") || "sin cuentas configuradas";
    const govTags = settings.governmentHashtags || "#NuevaEscuelaMexicana, #PensarEnGrande, #TransformarEnGrande, #AnticorrupciónyBuenGobierno, #SecretaríaAnticorrupciónyBuenGobierno";
    const governorTags = settings.governorHashtags || "#ArmentaContigo, #MañanerAA, #AlejandroArmenta";
    return `Eres analista de comunicación institucional. Usa texto e imagen cuando esté disponible.
FORMATO: Si postKind=photo es una publicación de imágenes/carrusel: la música o el cambio automático de diapositivas no la convierten en Video. Decide Infografía o Fotografía con la imagen. Video si hasVideo=true y postKind no es photo, hay reproductor, duración, reel o transmisión; esta señal técnica tiene prioridad absoluta. Infografía si es diseño, cartel, convocatoria, requisitos, pasos, datos, tipografía dominante o logotipos. Fotografía si muestra personas, eventos, instalaciones o actividades reales con poco texto incorporado. Texto si no hay imagen ni video.
PERFIL DE LA DEPENDENCIA: ${JSON.stringify(settings.institutionProfile || {})}. ORDEN OBLIGATORIO: primero identifica actividad propia concreta de esta dependencia; después Gobernador; después Gobierno del Estado. No basta mencionar estudiantes, docentes, rector o #EnVivo. Las citas externas no establecen voz propia. Ante conflicto de protagonismo, explica y usa confianza menor de 0.80. Si no hay evidencia externa ni propia, asigna Propias provisionalmente con confianza menor de 0.80. PERTENENCIA: indica de quién es principalmente el mensaje, no quién lo publicó. Gobernador si protagoniza/comunica el gobernador, sus actividades, cuentas ${governor} o etiquetas ${governorTags}. Gobierno del Estado si es campaña, programa, política o mensaje transversal del Gobierno/secretarías, cuentas ${gov} o etiquetas ${govTags}. Propias si trata vida, servicios, trámites, oferta, convocatorias, cursos o actividades propias. #PorAmorAPuebla y la etiqueta de la propia dependencia son señales complementarias, nunca decisivas por sí solas.
EJEMPLOS VALIDADOS: lactancia materna propia → Infografía|Propias; cartel Armenta Contigo → Infografía|Gobernador; video Armenta Contigo → Video|Gobernador; video citado Derecho de Réplica → Video|Gobierno del Estado; galería curso de inducción tercer semestre → Fotografía|Propias; admisión TecNM → Infografía|Propias; entrevista carreras TecNM → Video|Propias; #NuevaEscuelaMexicana → Gobierno del Estado; #AnticorrupciónyBuenGobierno → Infografía|Gobierno del Estado.
TEMA: identifica el asunto o proyecto por separado de PERTENENCIA. Usa nombres consistentes, por ejemplo 600 Días, Día Naranja o Inscripciones de nuevo ingreso, solo si existe evidencia. Día Naranja puede ser Propias o Gobierno del Estado: no determines pertenencia únicamente por el nombre del tema. No inventes proyectos ni copies una frase del texto como etiqueta; si no hay evidencia suficiente devuelve Tema por revisar. Una fotografía con logo o texto breve sigue siendo Fotografía. Si en la imagen se observan tres o más personas en una escena real de reunión, evento o actividad, con poca edición y unos cuantos logos, es una señal fuerte de Fotografía. Evalúa la imagen, no solo que el texto mencione personas. El número de personas por sí solo no decide el formato: si predominan la tipografía, los datos o la composición de un cartel, clasifica como Infografía aunque incluya una foto grupal. No inventes el número de personas cuando no puedas ver la imagen; si falta evidencia visual, explica esa limitación y marca confianza menor de 0.80; un cartel con fotografía de fondo y tipografía informativa dominante es Infografía. Si hay carrusel mixto o no puedes distinguir el formato, explica la duda y usa confianza menor de 0.80. RAZONAMIENTO: máximo 240 caracteres y solo señales observables. CONFIANZA: 0 a 1; menor de 0.80 si es ambiguo, falta evidencia o hay conflicto.`;
  }
  function normalizedPost(p) { return { localBelongingVerdict:p.belongingVerdict || null, id: String(p.id), platform: p.platform || "", author: p.author || "", text: p.fullText || p.text || "", quotedAuthor: p.quotedAuthor || "", quotedText: p.quotedText || "", postKind:p.postKind || "", mediaVerified:Boolean(p.mediaVerified), hasVideo: Boolean(p.hasVideo), hasPhoto: Boolean(p.hasPhoto), photoCount: Number(p.photoCount) || 0, mediaAltTexts: p.mediaAltTexts || [] }; }
  async function buildParts(posts,options={}) {
    const parts=[{text:`Clasifica estas publicaciones:\n${JSON.stringify(posts.map(normalizedPost))}`}],imageCounts={};let analyzedWithImages=0;
    const images=await Promise.all(posts.map(async post=>{const urls=[...new Set([...(post.mediaUrls||[]),post.videoPoster].filter(Boolean))].slice(0,post.postKind==='photo'?3:1);return Promise.all(urls.map(async(url,index)=>{try{const image=await fetchImagePart(url,options.signal);return image?[{text:`Imagen ${index+1} de la publicación ID ${post.id}:`},image]:[];}catch(error){global.ExtractorAITransport.check(options.signal);return [];}}));}));
    for(let i=0;i<posts.length;i++){const post=posts[i];imageCounts[post.id]=images[i].filter(p=>p.length>0).length;for(const image of images[i])parts.push(...image);if(imageCounts[post.id])analyzedWithImages++;else if(post.hasPhoto)parts.push({text:`ID ${post.id}: no se pudo adjuntar la imagen. La distinción Infografía/Fotografía requiere revisión y confianza menor de 0.80.`});}
    return {parts,analyzedWithImages,imageCounts};
  }
  function parseResponse(data) {
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!text) throw new Error("Gemini no devolvió una clasificación.");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("La respuesta de Gemini no es una lista.");
    return parsed.filter((i) => i?.id && FORMATS.includes(i.format) && BELONGINGS.includes(i.belonging)).map((i) => ({ id: String(i.id), textSummary: String(i.textSummary || "").slice(0, 180), format: i.format, belonging: i.belonging, topic: String(i.topic || "Tema por revisar").slice(0, 160), confidence: Math.max(0, Math.min(1, Number(i.confidence) || 0)), reasoning: String(i.reasoning || "Sin justificación devuelta.").slice(0, 240) }));
  }
  async function callGemini(parts,systemInstruction,apiKey,options={}) {
    const transport=global.ExtractorAITransport,body={contents:[{role:'user',parts}],systemInstruction:{parts:[{text:systemInstruction}]},generationConfig:{responseMimeType:'application/json',responseJsonSchema:RESPONSE_SCHEMA,temperature:0.1}};
    for(let attempt=0;attempt<3;attempt++){
      transport.check(options.signal);await transport.slot(options.rpm,options.signal,options.onStatus);
      let response,error;
      try{const result=await transport.deadline(async signal=>{const response=await fetch(`${API_ROOT}/${GEMINI_MODEL}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(body),signal});return {response,data:await response.json().catch(()=>({}))};},25000,options.signal);response=result.response;error=result.data;if(response.ok)return parseResponse(error);}
      catch(e){transport.check(options.signal);if((e.name==='TimeoutError'||e instanceof TypeError)&&attempt<2){options.onStatus?.('Reintentando una solicitud que tardó demasiado…');await transport.sleep(1000*2**attempt,options.signal);continue;}throw e;}
      const e=new Error(`Error en Gemini (${response.status}): ${error.error?.message||response.statusText}`);e.fatal=[400,401,402,403,404].includes(response.status);e.quotaExhausted=response.status===429;
      if(response.status===429){const delay=transport.retryDelay(response,error,attempt);transport.quota(delay);if(attempt>=1||delay>60000){throw e;}options.onStatus?.(`Límite de Gemini: esperando ${Math.ceil(delay/1000)} segundos…`);await transport.sleep(delay,options.signal);continue;}
      if(![408,500,502,503,504].includes(response.status)||attempt===2)throw e;
      options.onStatus?.('Gemini no respondió; reintentando…');await transport.sleep(Math.min(60000,transport.retryDelay(response,error,attempt)),options.signal);
    }
  }
  async function enrichWithAI(posts, settings, apiKey, onProgress, options={}) {
    const results = {}; const failedBatches = []; let analyzedWithImages = 0;
    if (!apiKey) return { results, failedBatches, model: GEMINI_MODEL, analyzedWithImages };
    const instruction = buildSystemInstruction(settings || {}) + (settings?.extraCriteria ? '\nCRITERIO ADICIONAL DEL USUARIO: '+String(settings.extraCriteria).slice(0,4000) : '');
    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const chunk = posts.slice(i, i + BATCH_SIZE);
      try {
        global.ExtractorAITransport.check(options.signal);
        const built = await buildParts(chunk,options); analyzedWithImages += built.analyzedWithImages;
        for (const item of await callGemini(built.parts, instruction, apiKey,options)) {
          const source=chunk.find(p=>String(p.id)===item.id);
          if(!source)continue;
          results[item.id] = {...item,imagesAnalyzed:built.imageCounts[item.id] || 0,imageAnalysisMissing:Boolean(source.hasPhoto && !built.imageCounts[item.id])};
        }
      } catch(error){failedBatches.push({ids:chunk.map(p=>String(p.id)),error:error.message});if(error.quotaExhausted||error.fatal||options.signal?.aborted){return {results,failedBatches,model:GEMINI_MODEL,analyzedWithImages,quotaExhausted:Boolean(error.quotaExhausted),fatal:Boolean(error.fatal),error:error.message};}}
      if (onProgress) onProgress(Math.min(i + BATCH_SIZE, posts.length), posts.length);
    }
    return { results, failedBatches, model: GEMINI_MODEL, analyzedWithImages };
  }
  global.ExtractorXAI = Object.freeze({ GEMINI_MODEL, RESPONSE_SCHEMA, buildSystemInstruction, enrichWithAI, _test: Object.freeze({ buildParts, callGemini, fetchImagePart, parseResponse }) });
})(globalThis);
