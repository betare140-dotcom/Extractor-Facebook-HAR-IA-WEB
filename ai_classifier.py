import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, List

VALID = {"Propia", "Gobierno", "Gobernador"}


def _csv_terms(value):
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    return [x.strip() for x in re.split(r"[,;\n]+", str(value or "")) if x.strip()]


def _fallback(row, governor_terms, government_terms, reason="Respaldo por reglas"):
    text = " ".join([
        row.get("publicacion", ""), row.get("menciones", ""), row.get("cuenta", "")
    ]).casefold()
    govr = [x.casefold() for x in _csv_terms(governor_terms)]
    govt = [x.casefold() for x in _csv_terms(government_terms)]
    hits_govr = [x for x in govr if len(x) >= 4 and x in text]
    hits_govt = [x for x in govt if len(x) >= 4 and x in text]

    # A governor mention/name is stronger than generic government branding.
    if hits_govr:
        belongs = "Gobernador"
        confidence = 62
        why = f"{reason}: coincidencia con {hits_govr[0]}."
    elif hits_govt:
        belongs = "Gobierno"
        confidence = 55
        why = f"{reason}: coincidencia con {hits_govt[0]}."
    else:
        belongs = "Propia"
        confidence = 58
        why = f"{reason}: el contenido se mantiene centrado en la cuenta que publica."
    topic = (row.get("publicacion") or "").strip().split("\n")[0][:140]
    return {
        "post_id": str(row.get("post_id", "")),
        "pertenencia_ia": belongs,
        "confianza_ia": confidence,
        "motivo_ia": why,
        "tema_ia": topic,
        "metodo_clasificacion": "Reglas de respaldo",
    }


def _extract_text(payload):
    try:
        parts = payload["candidates"][0]["content"]["parts"]
        return "\n".join(str(p.get("text", "")) for p in parts if isinstance(p, dict)).strip()
    except Exception:
        return ""


def _parse_json_answer(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and isinstance(obj.get("resultados"), list):
            obj = obj["resultados"]
        return obj if isinstance(obj, list) else []
    except Exception:
        # Last chance: isolate the outer JSON array.
        m = re.search(r"\[.*\]", text, flags=re.S)
        if m:
            try:
                obj = json.loads(m.group(0))
                return obj if isinstance(obj, list) else []
            except Exception:
                pass
    return []


def _call_gemini(api_key, model, prompt, timeout=90):
    model = (model or "gemini-2.5-flash").strip()
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + urllib.parse.quote(model, safe="-._")
        + ":generateContent?key="
        + urllib.parse.quote(api_key.strip(), safe="")
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.05,
            "responseMimeType": "application/json",
        },
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "Facebook-HAR-IA/2.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1500]
        raise RuntimeError(f"Gemini respondió HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"No se pudo conectar con Gemini: {exc.reason}") from exc


def _build_prompt(batch, own_account, governor_terms, government_terms, extra_criteria):
    posts = []
    for r in batch:
        posts.append({
            "post_id": str(r.get("post_id", "")),
            "cuenta": r.get("cuenta", ""),
            "texto": (r.get("publicacion") or "")[:7000],
            "menciones": r.get("menciones", ""),
            "formato": r.get("formato", ""),
        })

    return f"""
Eres un analista institucional de redes sociales. Clasifica cada publicación de Facebook según A QUIÉN PERTENECE PRINCIPALMENTE EL CONTENIDO.

CUENTA QUE ESTAMOS MONITOREANDO:
{own_account or '(detéctala por el campo cuenta de cada publicación)'}

REFERENCIAS DEL GOBERNADOR / ACTOR PRINCIPAL:
{', '.join(_csv_terms(governor_terms)) or 'Sin referencias configuradas'}

REFERENCIAS DEL GOBIERNO:
{', '.join(_csv_terms(government_terms)) or 'Sin referencias configuradas'}

CATEGORÍAS OBLIGATORIAS:
1. "Propia": la publicación trata principalmente de actividades, servicios, logros, convocatorias, personal, eventos, campañas o acciones propias de la cuenta/institución que publica. Puede llevar hashtags, logos, agradecimientos o menciones del Gobierno/Gobernador y seguir siendo Propia si ellos NO son el sujeto central.
2. "Gobierno": la publicación reproduce, difunde o centra el contenido en una acción, programa, estrategia, anuncio o mensaje del Gobierno del Estado/dependencias gubernamentales. No uses esta categoría únicamente por hashtags institucionales.
3. "Gobernador": el Gobernador/actor configurado es el protagonista central: agenda, declaración, acción, imagen, instrucción, logro, mensaje o participación del Gobernador. Una mención incidental no basta.

REGLAS IMPORTANTES:
- Determina el SUJETO CENTRAL, no una palabra aislada.
- Si una institución publica su propia convocatoria y solo usa #PorAmorAPuebla o #PensarEnGrande, normalmente es "Propia".
- Si la nota anuncia una acción del Gobernador y la institución solo la replica, es "Gobernador".
- Si difunde un programa general del Gobierno sin centrarlo en el Gobernador, es "Gobierno".
- En casos ambiguos elige la categoría dominante y baja la confianza.
- confianza debe ser un entero de 0 a 100.
- motivo debe ser breve y específico (máximo 28 palabras).
- tema debe resumir el tema/proyecto institucional en máximo 12 palabras.
{('CRITERIO ADICIONAL DEL USUARIO: ' + extra_criteria) if extra_criteria else ''}

Devuelve EXCLUSIVAMENTE un arreglo JSON, sin Markdown, con un objeto por post y exactamente estas claves:
post_id, pertenencia, confianza, motivo, tema

Los únicos valores permitidos para pertenencia son: "Propia", "Gobierno", "Gobernador".
Conserva exactamente el post_id recibido.

PUBLICACIONES:
{json.dumps(posts, ensure_ascii=False)}
""".strip()


def classify_posts(rows: List[Dict], api_key: str, model: str, own_account: str,
                   governor_terms, government_terms, extra_criteria="", batch_size=10):
    if not api_key or not api_key.strip():
        raise ValueError("Escribe tu API key de Gemini para usar la clasificación con IA.")
    if not rows:
        return [], {"ai_batches": 0, "fallbacks": 0}

    out_by_id = {}
    errors = []
    batch_count = 0

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        batch_count += 1
        prompt = _build_prompt(batch, own_account, governor_terms, government_terms, extra_criteria)
        try:
            payload = _call_gemini(api_key, model, prompt)
            answer = _parse_json_answer(_extract_text(payload))
            for item in answer:
                if not isinstance(item, dict):
                    continue
                pid = str(item.get("post_id", ""))
                belongs = str(item.get("pertenencia", "")).strip().title()
                if belongs not in VALID or not pid:
                    continue
                try:
                    conf = int(round(float(item.get("confianza", 0))))
                except Exception:
                    conf = 0
                conf = max(0, min(100, conf))
                out_by_id[pid] = {
                    "post_id": pid,
                    "pertenencia_ia": belongs,
                    "confianza_ia": conf,
                    "motivo_ia": str(item.get("motivo", "")).strip()[:500],
                    "tema_ia": str(item.get("tema", "")).strip()[:300],
                    "metodo_clasificacion": "Gemini",
                }
        except Exception as exc:
            errors.append(f"Lote {batch_count}: {exc}")

    results = []
    fallback_count = 0
    for row in rows:
        pid = str(row.get("post_id", ""))
        item = out_by_id.get(pid)
        if not item:
            fallback_count += 1
            item = _fallback(row, governor_terms, government_terms,
                             "Gemini no devolvió una clasificación válida")
        results.append(item)

    return results, {
        "ai_batches": batch_count,
        "fallbacks": fallback_count,
        "errors": errors,
        "model": model,
    }
