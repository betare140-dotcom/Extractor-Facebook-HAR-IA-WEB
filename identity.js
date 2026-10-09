(function (global) {
  "use strict";
  const fold = value => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const unique = values => [...new Map(values.filter(Boolean).map(v => [fold(v), v])).values()];
  const list = value => Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/).filter(Boolean);
  const defaults = {
    governmentHandles: ["Gob_Puebla", "GobiernoDePuebla"],
    governorHandles: ["armentapuebla_", "alejandroarmenta"],
    governmentHashtags: ["#NuevaEscuelaMexicana", "#PensarEnGrande", "#TransformarEnGrande", "#AnticorrupciónyBuenGobierno", "#SecretaríaAnticorrupciónyBuenGobierno"],
    governorHashtags: ["#ArmentaContigo", "#MañanerAA", "#AlejandroArmenta"],
  };
  function profile(context = {}) {
    const handle = String(context.handle || "").replace(/^@/, "");
    const name = context.institutionName || context.profileInfo?.name || handle;
    const description = context.profileInfo?.description || "";
    const contextText = fold(`${handle} ${name} ${description}`);
    const isUsep = /\busep(?:_puebla)?\b|universidad de la salud/.test(contextText);
    let sector = "general";
    if (isUsep || /universidad|tecnologico|educacion|colegio|conalep|instituto.*educativ/.test(contextText)) sector = "educación";
    else if (/salud|hospital|servicios medicos/.test(contextText)) sector = "salud";
    else if (/movilidad|transporte/.test(contextText)) sector = "movilidad";
    else if (/seguridad|policia|fiscalia/.test(contextText)) sector = "seguridad";
    return {handle, name: isUsep ? "Universidad de la Salud" : name, description, sector, isUsep, platform: context.platform || "", aliases: unique([handle, isUsep ? "USEP" : "", isUsep ? "Universidad de la Salud" : "", name !== handle && name.length > 5 ? name : ""])};
  }
  function settings(context, extras = {}) {
    const result = {institutionProfile: profile(context)};
    for (const key of Object.keys(defaults)) {
      const handles = key.endsWith("Handles");
      const values = unique([...defaults[key], ...list(extras[key])].map(v => handles ? v.replace(/^@/, "") : (v.startsWith("#") ? v : "#" + v)));
      result[key] = handles ? values : values.join(", ");
    }
    return result;
  }
  function exactTokens(text, values, prefix) {
    const signals = [];
    for (const value of list(values)) {
      const token = fold(value).replace(/^[@#]/, "");
      if (!token) continue;
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9_])${prefix}${escaped}(?![a-z0-9_])`, "i").test(text)) signals.push(prefix + value.replace(/^[@#]/, ""));
    }
    return signals;
  }
  function classify(post, supplied = {}) {
    const institution = supplied.institutionProfile || profile({handle:post.author});
    const value = fold(`${post.fullText || post.text || ""}\n${post.quotedText || ""}\n${post.quotedAuthor ? "@" + post.quotedAuthor : ""}`);
    const main = fold(post.fullText || post.text || "");
    const ownSignals = [];
    const governor = unique([...exactTokens(value,supplied.governorHandles || defaults.governorHandles,"@"),...exactTokens(value,supplied.governorHashtags || defaults.governorHashtags,"#")]);
    const government = unique([...exactTokens(value,supplied.governmentHandles || defaults.governmentHandles,"@"),...exactTokens(value,supplied.governmentHashtags || defaults.governmentHashtags,"#")]);
    if (/\balejandro armenta\b/.test(value)) governor.push("Alejandro Armenta");
    const foreignGovernor = /\b(?:gobernador|mandatario)\s+(?:de|del)\s+(?!puebla\b)[a-z]+/.test(value);
    if (/\bgobernador\b|\bmandatario\b/.test(value) && (!foreignGovernor || governor.length)) governor.push("Gobernador o mandatario");
    if (/\bgobierno (?:del estado(?: de puebla)?|de puebla)\b/.test(value)) government.push("Gobierno del Estado/Puebla");
    const identified = institution.aliases.some(alias => {
      const token=fold(alias).replace(/^@/,"");
      if (token.length<3) return false;
      const escaped=token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      return new RegExp(`(^|[^a-z0-9_])${escaped}(?![a-z0-9_])`).test(main);
    });
    const ownVoice = /\b(?:nuestra|nuestro)\s+(?:universidad|institucion|dependencia|comunidad)|\b(?:promovemos|agradecemos|ofrecemos|realizamos|fortalecemos|invitamos)\b/.test(main);
    const activities = /\b(?:convocatoria|inscripciones?|admision|cursos?|taller|tramites?|servicios?|convenio|atencion|capacitacion|formacion|comunidad universitaria|rector|docentes?|licenciatura|servicio social|practicas clinicas|departamento)\b/.test(main);
    let specific = false;
    if (institution.sector === "educación") {
      specific = /\brector\b|comunidad universitaria|cuerpo docente|servicio social|practicas clinicas|sedes? regional(?:es)?|departamento de atencion psicologica|futuros profesionales|medico cirujano|enfermeria y obstetricia/.test(main);
      if (institution.isUsep && /\b(?:jose manuel )?hernandez ramon\b/.test(main)) {specific=true;ownSignals.push("Rector identificado de la USEP");}
    } else if (institution.sector === "salud") specific = /\b(?:nuestros?|nuestras?)\s+(?:hospitales?|centros? de salud|servicios? medicos)|consulta (?:medica|externa)|citas? medicas?/.test(main);
    else if (institution.sector === "movilidad") specific = /\b(?:nuestros?|nuestras?)\s+(?:servicios?|rutas?)|tramite de licencia|licencias? de conducir/.test(main);
    else if (institution.sector === "seguridad") specific = /\b(?:nuestros?|nuestras?)\s+(?:elementos|policias)|\b(?:detuvimos|aseguramos|investigamos)\b/.test(main);
    const own = (identified && activities) || (specific && (identified || ownVoice || (!governor.length && !government.length))) || (ownVoice && activities);
    if (identified && activities) ownSignals.push("Dependencia identificada y actividad institucional");
    if (specific) ownSignals.push(`Actividad específica del perfil de ${institution.sector}`);
    if (ownVoice && activities) ownSignals.push("Actividad narrada en voz de la dependencia");
    const mixed = own && (governor.length>0 || government.length>0);
    if (own) return {bucket:"Propias",confidence:mixed?0.74:0.9,needsReview:mixed,decisive:!mixed,signals:unique(ownSignals),rule:mixed?"La actividad propia tiene prioridad; también hay señales externas, revisar el protagonismo.":"Actividad propia de la dependencia detectada antes de las referencias externas."};
    if (governor.length) return {bucket:"Gobernador",confidence:0.9,needsReview:false,decisive:true,signals:unique(governor),rule:"Referencia al Gobernador o a un programa suyo, sin actividad propia identificada."};
    if (government.length) return {bucket:"Gobierno del Estado",confidence:0.87,needsReview:false,decisive:true,signals:unique(government),rule:"Referencia al Gobierno del Estado, sin señales del Gobernador ni actividad propia identificada."};
    return {bucket:"Propias",confidence:0.5,needsReview:true,decisive:false,signals:[],rule:"Asignación provisional por descarte; no hay evidencia suficiente. Revisar. #EnVivo no define pertenencia."};
  }
  function extras(auto, current) {
    const result={};
    for(const key of Object.keys(defaults)) {
      const base=new Set(list(auto[key]).map(v=>fold(v).replace(/^[@#]/,"")));
      result[key]=list(current[key]).filter(v=>!base.has(fold(v).replace(/^[@#]/,"")));
    }
    return result;
  }
  global.ExtractorIdentity = Object.freeze({profile,settings,classify,extras});
})(globalThis);
