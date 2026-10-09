(function(global){
'use strict';
  function mergeAIResult(p,result) {
  const wrongPhotoVideo = p.postKind === "photo" && result.format === "Video";
  const formatResult = wrongPhotoVideo ? p.format : (p.hasVideo && p.mediaVerified ? "Video" : result.format || p.format);
  const local = p.belongingVerdict;
  const keepLocal = local && (local.decisive || (local.signals?.length || 0) > 0);
  const disagreement = keepLocal && result.belonging !== local.bucket;
  return { ...p, belongingReason: keepLocal ? p.belongingReason + (disagreement ? " IA y reglas discrepan; revisar." : "") : result.reasoning, textSummary: result.textSummary || p.textSummary, format: formatResult, formatReason: wrongPhotoVideo ? "Carrusel de imágenes confirmado; la IA devolvió Video. Revisar si es infografía o fotografía." : (result.imageAnalysisMissing ? "No se pudo analizar la imagen. Revisar Infografía/Fotografía. " : "") + result.reasoning, belonging: keepLocal ? local.bucket : (result.belonging || p.belonging), topic: result.topic || p.topic, classificationSource: keepLocal ? "Reglas de pertenencia + Gemini" : "Gemini", confidence: result.imageAnalysisMissing || wrongPhotoVideo ? Math.min(0.79,Number(result.confidence)||0) : Number(result.confidence) || 0, reasoning: result.reasoning || "Sin justificación devuelta.", needsReview: wrongPhotoVideo || result.imageAnalysisMissing || p.dateApproximate || disagreement || (keepLocal && local.needsReview) || (Number(result.confidence) || 0) < 0.8 || (result.topic || p.topic) === "Tema por revisar" };
  }

 global.ExtractorReportAI=Object.freeze({mergeAIResult});
})(globalThis);
