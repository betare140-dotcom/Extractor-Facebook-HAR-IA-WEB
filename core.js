(function initExtractorCore(global) {
  "use strict";

  const CSV_HEADERS = [
    "Fecha y Hora",
    "Bloque Operativo",
    "Texto de la publicación",
    "Tipo de publicación",
    "Pertenencia",
    "Tema o proyecto",
  ];

  const DEFAULT_GOVERNMENT_HANDLES = ["Gob_Puebla", "GobiernoDePuebla"];
  const DEFAULT_GOVERNOR_HANDLES = ["armentapuebla_", "alejandroarmenta"];
  const BELONGINGS = ["Propias", "Gobernador", "Gobierno del Estado"];
  const FORMATS = ["Infografía", "Video", "Fotografía", "Texto"];
  const DEFAULT_GOVERNMENT_HASHTAGS = ["#NuevaEscuelaMexicana", "#PensarEnGrande", "#TransformarEnGrande", "#AnticorrupciónyBuenGobierno", "#SecretaríaAnticorrupciónyBuenGobierno"];
  const DEFAULT_GOVERNOR_HASHTAGS = ["#ArmentaContigo", "#MañanerAA", "#AlejandroArmenta"];

  const MONTHS_MAP = {
    enero: 0, ene: 0, jan: 0, january: 0,
    febrero: 1, feb: 1, february: 1,
    marzo: 2, mar: 2, march: 2,
    abril: 3, abr: 3, apr: 3, april: 3,
    mayo: 4, may: 4,
    junio: 5, jun: 5, june: 5,
    julio: 6, jul: 6, july: 6,
    agosto: 7, ago: 7, aug: 7, august: 7,
    septiembre: 8, sep: 8, sept: 8, september: 8,
    octubre: 9, oct: 9, october: 9,
    noviembre: 10, nov: 10, november: 10,
    diciembre: 11, dic: 11, dec: 11, december: 11
  };

  function normalizeText(value) {
    return String(value || "")
      .replace(/https?:\/\/t\.co\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function fold(value) {
    return normalizeText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function normalizeHandle(value) {
    return String(value || "")
      .trim()
      .replace(/^https?:\/\/(?:www\.)?(?:x|twitter|tiktok|instagram|facebook)\.com\//i, "")
      .replace(/^@/, "")
      .replace(/[/?#].*$/, "");
  }

  function parseHandles(value, fallback = []) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[\s,;|]+/);
    const handles = [...new Set(source.map(normalizeHandle).filter(Boolean))];
    return handles.length ? handles : [...fallback];
  }

  function handlesToText(handles) {
    return (handles || []).map((handle) => `@${normalizeHandle(handle)}`).filter((item) => item !== "@").join(", ");
  }
  function parseHashtags(value, fallback = []) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[\s,;|]+/);
    const tags = [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean).map((item) => item.startsWith("#") ? item : `#${item}`))];
    return tags.length ? tags : [...fallback];
  }
  function hashtagsToText(tags) { return (tags || []).join(", "); }

  function parseDateRange(fromValue, toValue) {
    const from = String(fromValue || "").trim();
    const to = String(toValue || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error("Las fechas deben usar el formato YYYY-MM-DD.");
    }
    const start = new Date(`${from}T00:00:00-06:00`);
    const end = new Date(`${to}T23:59:59.999-06:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error("Las fechas indicadas no son válidas.");
    }
    if (start > end) throw new Error("La fecha inicial no puede ser posterior a la fecha final.");
    return { from, to, start, end };
  }

  function getTikTokDateFromId(videoId) {
    try {
      if (!videoId || !/^\d{15,22}$/.test(String(videoId))) return null;
      const idBig = BigInt(videoId);
      const tsSec = Number(idBig >> 32n);
      if (tsSec > 1500000000 && tsSec < 2200000000) {
        return new Date(tsSec * 1000).toISOString();
      }
    } catch (e) {}
    return null;
  }

  function parseSpanishDate(text, refDate = new Date()) {
    if (!text) return null;
    const s = String(text).trim().toLowerCase()
      .replace(/[()·•|]/g, " ")
      .replace(/\s+/g, " ");

    // 1. ISO estándar (ej. 2026-08-20T17:42:01Z o 2026-08-20)
    const isoMatch = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/i);
    if (isoMatch) {
      const [, y, m, d] = isoMatch.map(Number);
      // La hora 0 (medianoche) es válida: antes `hh || 12` la convertía en 12:00.
      const hasTime = isoMatch[4] !== undefined;
      const [hh, mm, ss] = hasTime ? [Number(isoMatch[4]), Number(isoMatch[5] || 0), Number(isoMatch[6] || 0)] : [12, 0, 0];
      return new Date(Date.UTC(y, m - 1, d, hh, mm, ss)).toISOString();
    }

    // 2. Facebook / Español explícito: "13 de agosto a las 12:00", "13 de agosto", "9 de ago. a las 10:15 pm"
    const fbMatch = s.match(/(\d{1,2})\s+(?:de\s+)?([a-zñ.]+)(?:\s+(?:de\s+)?(\d{4}))?(?:(?:\s+a\s+las|\s+a\s+la|\s+a)\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?/i);
    if (fbMatch) {
      const day = parseInt(fbMatch[1], 10);
      const rawMonth = fbMatch[2].replace(/\./g, "").toLowerCase();
      if (MONTHS_MAP[rawMonth] !== undefined) {
        const month = MONTHS_MAP[rawMonth];
        let year = fbMatch[3] ? parseInt(fbMatch[3], 10) : refDate.getFullYear();
        if (!fbMatch[3] && month > refDate.getMonth()) {
          year -= 1;
        }
        let hour = fbMatch[4] ? parseInt(fbMatch[4], 10) : 12;
        const min = fbMatch[5] ? parseInt(fbMatch[5], 10) : 0;
        const ampm = fbMatch[6] ? fbMatch[6].toLowerCase() : null;
        if (ampm === "pm" && hour < 12) hour += 12;
        if (ampm === "am" && hour === 12) hour = 0;
        // Una hora escrita en texto es hora local de México (UTC-6, sin horario de verano).
        return new Date(Date.UTC(year, month, day, hour, min, 0) + (fbMatch[4] ? 6 * 3600000 : 0)).toISOString();
      }
    }

    // 3. Semanas: "1 sem", "1 sem.", "1sem", "2 semanas", "1w"
    const weekMatch = s.match(/(?:hace\s+)?(\d+)\s*(?:sem\b|sem\.|semanas?|w\b|weeks?)/i);
    if (weekMatch) {
      const weeks = parseInt(weekMatch[1], 10);
      return new Date(refDate.getTime() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    // 4. Días: "4 d", "4d", "4 d.", "4 días", "hace 4 días", "4 days"
    const dayMatch = s.match(/(?:hace\s+)?(\d+)\s*(?:d[ií]as?|days?|d(?![a-z])|d\.)/i);
    if (dayMatch) {
      const days = parseInt(dayMatch[1], 10);
      return new Date(refDate.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    }

    // 5. Horas: "5 h", "5h", "5 horas", "5 hrs"
    const hourMatch = s.match(/(?:hace\s+)?(\d+)\s*(?:horas?|hours?|hrs?\b|h(?![a-z]))/i);
    if (hourMatch) {
      const hours = parseInt(hourMatch[1], 10);
      return new Date(refDate.getTime() - hours * 60 * 60 * 1000).toISOString();
    }

    // 6. Minutos: "45 min", "45m", "45 mins"
    const minMatch = s.match(/(?:hace\s+)?(\d+)\s*(?:minutos?|mins?\b|min\b|m(?![a-z]))/i);
    if (minMatch) {
      const mins = parseInt(minMatch[1], 10);
      return new Date(refDate.getTime() - mins * 60 * 1000).toISOString();
    }

    // 7. Ayer / Hoy
    if (/\b(?:hoy|justo ahora|hace un momento)\b/i.test(s)) return refDate.toISOString();
    if (/\bayer\b/i.test(s)) {
      return new Date(refDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
    }

    return null;
  }

  function detectPlatform(hostname = location.hostname) {
    if (/tiktok\.com/i.test(hostname)) return "tiktok";
    if (/instagram\.com/i.test(hostname)) return "instagram";
    if (/facebook\.com/i.test(hostname)) return "facebook";
    return "x";
  }

  function detectHandleFromUrl(url = location.href) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname;

      if (host.includes("tiktok.com")) {
        const match = path.match(/@([A-Za-z0-9_.-]+)/i);
        return match ? match[1] : "";
      }
      if (host.includes("instagram.com")) {
        const match = path.match(/^\/([A-Za-z0-9_.]+)(?:\/.*)?$/i);
        const reserved = new Set(["explore", "reels", "stories", "direct", "accounts", "p", "reel"]);
        return match && !reserved.has(match[1].toLowerCase()) ? match[1] : "";
      }
      if (host.includes("facebook.com")) {
        if(path.toLowerCase()==="/profile.php")return /^\d+$/.test(parsed.searchParams.get("id")||"")?parsed.searchParams.get("id"):"";
        const match = path.match(/^\/([A-Za-z0-9_.-]+)(?:\/.*)?$/i);
        const reserved = new Set(["home", "watch", "marketplace", "groups", "gaming", "messages", "profile.php", "photo", "permalink.php"]);
        return match && !reserved.has(match[1].toLowerCase()) ? match[1] : "";
      }
      const match = path.match(/^\/([A-Za-z0-9_]{1,15})(?:\/.*)?$/i);
      const reserved = new Set(["home", "explore", "search", "notifications", "messages", "settings", "compose", "i"]);
      return match && !reserved.has(match[1].toLowerCase()) ? match[1] : "";
    } catch {
      return "";
    }
  }

  function localParts(isoDate, timeZone = "America/Mexico_City") {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) throw new Error(`Fecha inválida: ${isoDate}`);
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const pieces = Object.fromEntries(
      formatter.formatToParts(date)
        .filter((piece) => piece.type !== "literal")
        .map((piece) => [piece.type, piece.value]),
    );
    return {
      date: `${pieces.year}-${pieces.month}-${pieces.day}`,
      time: `${pieces.hour}:${pieces.minute}`,
      hour: Number(pieces.hour),
      monthKey: `${pieces.year}-${pieces.month}`,
    };
  }

  function assignBlock(hour) {
    const value = Number(hour);
    if (value >= 23 || value < 7) return "A";
    if (value < 12) return "B";
    if (value < 17) return "C";
    return "D";
  }

  function summarizeText(value, maxLength = 180) {
    const text = normalizeText(value);
    if (!text) return "Publicación sin texto";
    if (text.length <= maxLength) return text;
    const candidate = text.slice(0, maxLength + 1);
    const boundary = candidate.lastIndexOf(" ");
    return `${candidate.slice(0, boundary > 80 ? boundary : maxLength).trim()}…`;
  }
  function hasAny(text, values) { const target = fold(text); return (values || []).some((value) => target.includes(fold(value))); }
  function ruleFormat(post, text) {
    if (post.hasVideo && post.postKind !== "photo") return ["Video", 0.99, "Se detectó un video o reproductor."];
    if (!post.hasPhoto) return ["Texto", 0.97, "No se detectó imagen ni video."];
    if (/convocatoria|inscripciones?|requisitos?|pasos?|sab[ií]as que|prevenci[oó]n|admisi[oó]n|oferta acad[eé]mica|aviso|comunicado/i.test(text)) return ["Infografía", 0.60, "Posible infografía por el texto; sin inspección visual confirmada, revisar."];
    return ["Fotografía", 0.60, "Posible fotografía; las reglas locales no distinguen visualmente un cartel, revisar."];
  }
  function ruleBelonging(post, text, settings) {
    return global.ExtractorIdentity.classify({...post, fullText:text}, settings);
  }

  function ruleTopic(text) {
    if (/\b600\s*d[ií]as\b/i.test(text)) return "600 Días";
    if (/d[ií]a\s*naranja|#dianaranja/i.test(text)) return "Día Naranja";
    if (/inscripciones?|admisi[oó]n/i.test(text) && /nuevo ingreso/i.test(text)) return "Inscripciones de nuevo ingreso";
    if (/curso de inducci[oó]n/i.test(text)) return /tercer semestre/i.test(text) ? "Curso de inducción dirigido a estudiantes de tercer semestre" : "Curso de inducción";
    if (/lactancia materna/i.test(text)) return "Lactancia materna";
    if (/nueva escuela mexicana/i.test(text)) return "La Nueva Escuela Mexicana";
    if (/conflictos? de inter[eé]s/i.test(text)) return "Prevención de conflictos de interés";
    if (/anticorrupci[oó]n/i.test(text)) return "Anticorrupción y buen gobierno";
    if (/admisi[oó]n|inscripciones?|nuevo ingreso/i.test(text)) return /primavera\s*2026/i.test(text) ? "Admisión Primavera 2026" : "Admisión y nuevo ingreso";
    if (/oferta acad[eé]mica|carreras?|contador p[uú]blico/i.test(text)) return "Oferta académica y admisión";
    return "Tema por revisar";
  }

  function enrichPost(rawPost, settings = {}, timeZone = "America/Mexico_City") {
    const isoDate = rawPost.publishedAt || new Date().toISOString();
    const parts = localParts(isoDate, timeZone);
    const fullText = normalizeText(rawPost.text);
    const format = ruleFormat(rawPost, fullText);
    const belonging = ruleBelonging(rawPost, fullText, settings);
    const confidence = Math.min(format[1], belonging.confidence);
    return {
      id: rawPost.id || String(Date.now()),
      author: rawPost.author || "",
      platform: rawPost.platform || "",
      postKind:rawPost.postKind || "",
      mediaVerified:Boolean(rawPost.mediaVerified),
      captureSource:rawPost.captureSource || "",
      formatReason:format[2],
      belongingVerdict: belonging,
      belongingReason: belonging.rule + " " + belonging.signals.join(", "),
      publishedAt: isoDate,
      dateSource: rawPost.dateSource || "",
      dateApproximate: Boolean(rawPost.dateApproximate),
      dateTime: `${parts.date} ${parts.time}`,
      date: parts.date,
      monthKey: parts.monthKey,
      block: assignBlock(parts.hour),
      textSummary: summarizeText(fullText),
      fullText,
      format: format[0],
      belonging: belonging.bucket,
      topic: ruleTopic(fullText),
      url: rawPost.url || "",
      mediaUrls: rawPost.mediaUrls || [],
      mediaAltTexts: rawPost.mediaAltTexts || [],
      quotedAuthor: rawPost.quotedAuthor || "",
      quotedText: normalizeText(rawPost.quotedText),
      hasVideo: Boolean(rawPost.hasVideo),
      hasPhoto: Boolean(rawPost.hasPhoto),
      photoCount: Number(rawPost.photoCount) || 0,
      videoPoster: rawPost.videoPoster || "",
      classificationSource: "Reglas locales",
      confidence,
      reasoning: `${format[2]} ${belonging.rule}`,
      needsReview: Boolean(rawPost.dateApproximate) || belonging.needsReview || confidence < 0.8 || ruleTopic(fullText) === "Tema por revisar",
    };
  }

  function buildSummary(posts) {
    const formats = Object.fromEntries(FORMATS.map((item) => [item, 0]));
    const blocks = Object.fromEntries(["A", "B", "C", "D"].map((item) => [item, 0]));
    const belongings = Object.fromEntries(BELONGINGS.map((item) => [item, 0]));
    const months = {};
    const topics = {};
    for (const post of posts) {
      formats[post.format] = (formats[post.format] || 0) + 1;
      blocks[post.block] = (blocks[post.block] || 0) + 1;
      belongings[post.belonging] = (belongings[post.belonging] || 0) + 1;
      months[post.monthKey] = (months[post.monthKey] || 0) + 1;
      topics[post.topic] = (topics[post.topic] || 0) + 1;
    }
    return {
      total: posts.length,
      formats,
      blocks,
      belongings,
      months,
      topics,
      review: posts.filter((post) => post.needsReview).length,
    };
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(posts) {
    const rows = posts.map((post) => [post.dateTime, post.block, post.textSummary, post.format, post.belonging, post.topic]);
    return `\uFEFF${[CSV_HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  }

  global.ExtractorXCore = Object.freeze({
    BELONGINGS,
    CSV_HEADERS,
    DEFAULT_GOVERNMENT_HANDLES,
    DEFAULT_GOVERNMENT_HASHTAGS,
    DEFAULT_GOVERNOR_HANDLES,
    DEFAULT_GOVERNOR_HASHTAGS,
    FORMATS,
    assignBlock,
    buildSummary,
    detectHandleFromUrl,
    detectPlatform,
    enrichPost,
    fold,
    getTikTokDateFromId,
    handlesToText,
    hashtagsToText,
    localParts,
    normalizeHandle,
    normalizeText,
    parseDateRange,
    parseHandles,
    parseHashtags,
    parseSpanishDate,
    summarizeText,
    toCsv,
  });
})(globalThis);
