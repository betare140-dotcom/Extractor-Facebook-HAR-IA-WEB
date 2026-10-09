(function (global) {
  "use strict";
  const NETWORKS = ["X", "Facebook", "Instagram", "TikTok", "YouTube"];
  function network(value) {
    const key = String(value || "").toLowerCase().trim();
    return ({ x: "X", twitter: "X", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" })[key] || "Sin determinar";
  }
  function prepare(posts, metadata = {}) {
    return posts.map(p => {
      if (!p.publishedAt || !Number.isFinite(Date.parse(p.publishedAt))) throw new Error("Hay una publicación sin fecha válida.");
      const parts = global.ExtractorXCore.localParts(p.publishedAt, metadata.timeZone || "America/Mexico_City");
      return { ...p, belonging: p.belonging === "Dependencia" ? "Propias" : p.belonging, platform: network(p.platform || metadata.platform), author: p.author || metadata.handle || "", date: parts.date, monthKey: parts.monthKey, dateTime: `${parts.date} ${parts.time}` };
    });
  }
  function report(posts, metadata = {}) {
    const counts = (field, labels = []) => {
      const result = Object.fromEntries(labels.map(l => [l, 0]));
      posts.forEach(p => { const key = p[field] || "Sin determinar"; result[key] = (result[key] || 0) + 1; });
      return result;
    };
    const platforms = counts("platform", NETWORKS);
    const belongings = counts("belonging", global.ExtractorXCore.BELONGINGS);
    const formats = counts("format", global.ExtractorXCore.FORMATS);
    const topics = counts("topic");
    const months = counts("monthKey");
    if (/^\d{4}-\d{2}-\d{2}$/.test(metadata.from || "") && /^\d{4}-\d{2}-\d{2}$/.test(metadata.to || "")) {
      let [year, month] = metadata.from.slice(0, 7).split("-").map(Number);
      const end = metadata.to.slice(0, 7);
      for (let i = 0; i < 1200; i++) {
        const key = `${year}-${String(month).padStart(2, "0")}`;
        if (key > end) break;
        if (!(key in months)) months[key] = 0;
        if (++month === 13) { month = 1; year++; }
      }
    }
    const total = posts.length;
    const percent = n => total ? n / total : 0;
    const ranking = Object.entries(platforms).filter(([,n]) => n > 0).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
    const fmt = n => (percent(n)*100).toFixed(1) + "%";
    const narrative = [`${total} publicaciones contabilizadas.`];
    ranking.slice(0,2).forEach(([label,n],i) => narrative.push(`${i === 0 ? "Primer lugar" : "Segundo lugar"}: ${label}, ${n} publicaciones (${fmt(n)}).`));
    if (ranking.length > 1) narrative.push(`${ranking[0][0]} + ${ranking[1][0]} concentran ${fmt(ranking[0][1]+ranking[1][1])} del volumen.`);
    narrative.push(`Pertenencia: ${Object.entries(belongings).map(([l,n]) => `${l === "Dependencia" ? "Propias" : l}: ${n} (${fmt(n)})`).join("; ")}.`);
    narrative.push(`Formatos: ${Object.entries(formats).map(([l,n]) => `${l}: ${n} (${fmt(n)})`).join("; ")}.`);
    const observed = new Set((metadata.sources || []).map(s => network(s.platform)));
    if (metadata.platform && metadata.platform !== "multired") observed.add(network(metadata.platform));
    posts.forEach(p => observed.add(p.platform));
    return { total, platforms, belongings, formats, topics, months, percent, narrative, observed: [...observed], review: posts.filter(p => p.needsReview).length };
  }
  function consolidate(documents, from, to) {
    const {start, end} = global.ExtractorXCore.parseDateRange(from, to);
    const unique = new Map();
    const sources = [];
    let duplicates = 0, excluded = 0;
    for (const doc of documents) {
      if (!doc.metadata || !Array.isArray(doc.posts)) throw new Error("Selecciona archivos datos_*.json generados por la extensión.");
      sources.push(...(doc.metadata.sources || [doc.metadata]).map(s => ({ platform: s.platform, handle: s.handle, from: s.from, to: s.to })));
      for (const p of prepare(doc.posts, doc.metadata)) {
        const time = Date.parse(p.publishedAt);
        if (time < +start || time > +end) { excluded++; continue; }
        // Una misma nota en dos redes son dos publicaciones. IDs no son globales.
        const identity = p.id || p.url;
        if (!identity) throw new Error("Una publicación no tiene ID ni enlace para deduplicar.");
        const key = `${p.platform}|${identity}`;
        if (unique.has(key)) { duplicates++; continue; }
        unique.set(key, p);
      }
    }
    const metadata = { platform: "multired", handle: "consolidado", from, to, timeZone: "America/Mexico_City", sources, duplicates, excluded };
    const posts = [...unique.values()].sort((a,b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
    return { metadata, posts, summary: global.ExtractorXCore.buildSummary(posts), classification: {}, statistics: report(posts, metadata) };
  }
  function csv(stats) {
    const rows = [["Sección", "Categoría", "Publicaciones", "Porcentaje del total (%)", "Estado"]];
    for (const [section, values] of [["Red", stats.platforms], ["Pertenencia", stats.belongings], ["Formato", stats.formats], ["Mes", stats.months], ["Tema o proyecto", stats.topics]]) {
      Object.entries(values).forEach(([label,n]) => rows.push([section, label === "Dependencia" ? "Propias" : label, section === "Red" && !stats.observed.includes(label) ? "" : n, section === "Red" && !stats.observed.includes(label) ? "" : Number((stats.percent(n) * 100).toFixed(1)), section === "Red" && !stats.observed.includes(label) ? "Sin datos" : ""]));
    }
    return "\uFEFF" + rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  }
  global.ExtractorStatistics = Object.freeze({ NETWORKS, network, prepare, report, consolidate, csv });
})(globalThis);
