import os
import tempfile
from collections import Counter, defaultdict
from datetime import datetime

import pandas as pd
import streamlit as st

from har_extractor import extract_har_files
from ai_classifier import classify_posts
from exporter_ai import xlsx_bytes, csv_bytes


st.set_page_config(
    page_title="Extractor Facebook HAR + IA",
    page_icon="📘",
    layout="wide",
    initial_sidebar_state="expanded",
)


APP_VERSION = "4.0 Streamlit"
CLASS_OPTIONS = ["Propia", "Gobierno", "Gobernador"]


@st.cache_data(show_spinner=False)
def _extract_from_uploaded(files_payload, start_date_text, end_date_text):
    """Procesa una lista inmutable [(nombre, bytes), ...] usando el extractor probado."""
    with tempfile.TemporaryDirectory(prefix="facebook_har_") as td:
        paths = []
        for idx, (name, content) in enumerate(files_payload):
            safe_name = os.path.basename(name) or f"archivo_{idx + 1}.har"
            path = os.path.join(td, f"{idx:03d}_{safe_name}")
            with open(path, "wb") as fh:
                fh.write(content)
            paths.append(path)
        rows, diagnostics = extract_har_files(
            paths,
            start_date=start_date_text or None,
            end_date=end_date_text or None,
        )
    return rows, diagnostics


def _ensure_ai_fields(rows):
    result = []
    for row in rows:
        r = dict(row)
        r.setdefault("pertenencia_ia", "")
        r.setdefault("confianza_ia", 0)
        r.setdefault("motivo_ia", "")
        r.setdefault("tema_ia", "")
        r.setdefault("metodo_clasificacion", "Sin clasificar")
        result.append(r)
    return result


def _merge_ai(rows, ai_results):
    by_id = {str(x.get("post_id", "")): x for x in ai_results}
    merged = []
    for row in rows:
        r = dict(row)
        ai = by_id.get(str(r.get("post_id", "")))
        if ai:
            r.update(ai)
        merged.append(r)
    return merged


def _rows_to_editor_df(rows):
    cols = [
        "fecha", "hora", "cuenta", "pertenencia_ia", "confianza_ia",
        "tema_ia", "motivo_ia", "publicacion", "url", "formato",
        "reacciones", "comentarios", "compartidos", "menciones", "post_id"
    ]
    df = pd.DataFrame(rows)
    for c in cols:
        if c not in df.columns:
            df[c] = ""
    return df[cols].copy()


def _apply_editor(rows, edited_df):
    edits = {}
    for _, rec in edited_df.iterrows():
        pid = str(rec.get("post_id", ""))
        if not pid:
            continue
        edits[pid] = {
            "pertenencia_ia": str(rec.get("pertenencia_ia", "") or ""),
            "confianza_ia": int(rec.get("confianza_ia", 0) or 0),
            "tema_ia": str(rec.get("tema_ia", "") or ""),
            "motivo_ia": str(rec.get("motivo_ia", "") or ""),
            "metodo_clasificacion": "Revisión manual"
            if str(rec.get("pertenencia_ia", "") or "") else "Sin clasificar",
        }
    out = []
    for row in rows:
        r = dict(row)
        pid = str(r.get("post_id", ""))
        if pid in edits:
            original = str(r.get("pertenencia_ia", "") or "")
            new = edits[pid]["pertenencia_ia"]
            # Mantener el método Gemini cuando no hubo cambio de categoría.
            method = r.get("metodo_clasificacion", "")
            r.update(edits[pid])
            if new == original and method:
                r["metodo_clasificacion"] = method
        out.append(r)
    return out


def _monthly_df(rows):
    month_names = {
        1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril",
        5: "Mayo", 6: "Junio", 7: "Julio", 8: "Agosto",
        9: "Septiembre", 10: "Octubre", 11: "Noviembre", 12: "Diciembre",
    }
    grouped = defaultdict(lambda: {
        "Propia": 0, "Gobierno": 0, "Gobernador": 0,
        "Sin clasificar": 0, "Total de menciones": 0,
    })
    for r in rows:
        raw = str(r.get("fecha") or "").strip()
        dt = None
        for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
            try:
                dt = datetime.strptime(raw, fmt)
                break
            except ValueError:
                pass
        if not dt:
            continue
        key = (dt.year, dt.month)
        belongs = str(r.get("pertenencia_ia") or "").strip()
        if belongs in CLASS_OPTIONS:
            grouped[key][belongs] += 1
        else:
            grouped[key]["Sin clasificar"] += 1
        grouped[key]["Total de menciones"] += 1

    data = []
    for (year, month), rec in sorted(grouped.items()):
        total = rec["Total de menciones"]
        data.append({
            "Mes": f"{month_names[month]} {year}",
            "Propia": rec["Propia"],
            "Gobierno": rec["Gobierno"],
            "Gobernador": rec["Gobernador"],
            "Sin clasificar": rec["Sin clasificar"],
            "Total de menciones": total,
        })
    return pd.DataFrame(data)


def _classification_summary(rows):
    c = Counter(str(r.get("pertenencia_ia") or "Sin clasificar") for r in rows)
    return c


if "rows" not in st.session_state:
    st.session_state.rows = []
if "diagnostics" not in st.session_state:
    st.session_state.diagnostics = {}
if "ai_diagnostics" not in st.session_state:
    st.session_state.ai_diagnostics = {}


st.title("📘 Extractor Facebook HAR + IA")
st.caption(
    "Facebook → HAR → publicaciones reales → clasificación Propia / Gobierno / Gobernador → Excel. "
    f"Versión {APP_VERSION}."
)

st.info(
    "Los archivos HAR se procesan temporalmente dentro de la sesión de Streamlit. "
    "No los subas al repositorio de GitHub. Pueden contener datos de sesión del navegador."
)

with st.sidebar:
    st.header("Configuración de clasificación")
    own_account = st.text_input(
        "Cuenta propia / institución",
        value="",
        placeholder="Ej. TECNM - Tepeaca",
        help="Si se deja vacío, la IA puede inferirla del campo Cuenta de cada publicación.",
    )
    governor_terms = st.text_area(
        "Gobernador / actor principal",
        value="Alejandro Armenta, gobernador Alejandro Armenta, Armenta",
        height=90,
    )
    government_terms = st.text_area(
        "Gobierno / referencias institucionales",
        value=(
            "Gobierno de Puebla, Gobierno del Estado de Puebla, Gobierno del Estado, "
            "#PorAmorAPuebla, #PensarEnGrande"
        ),
        height=105,
    )
    extra_criteria = st.text_area(
        "Criterio adicional",
        value=(
            "Las actividades académicas, convocatorias, inscripciones y eventos realizados "
            "directamente por la institución deben considerarse Propias aunque utilicen imagen "
            "institucional del Gobierno."
        ),
        height=135,
    )
    st.divider()
    model = st.text_input("Modelo Gemini", value="gemini-2.5-flash")
    api_key = st.text_input(
        "API key de Gemini",
        type="password",
        help="Se usa solo durante esta sesión. No la escribas en GitHub.",
    )


st.subheader("1. Cargar archivos HAR")
uploaded = st.file_uploader(
    "Selecciona uno o varios archivos .har guardados desde Network → Save all as HAR with content",
    type=["har"],
    accept_multiple_files=True,
)

filter_dates = st.checkbox("Filtrar por rango de fechas", value=False)
start_text = ""
end_text = ""
if filter_dates:
    c1, c2 = st.columns(2)
    with c1:
        start_date = st.date_input("Fecha inicial")
        start_text = start_date.strftime("%d/%m/%Y")
    with c2:
        end_date = st.date_input("Fecha final")
        end_text = end_date.strftime("%d/%m/%Y")

extract_clicked = st.button(
    "🔎 Analizar HAR",
    type="primary",
    disabled=not uploaded,
    use_container_width=True,
)

if extract_clicked:
    try:
        payload = tuple((f.name, f.getvalue()) for f in uploaded)
        with st.spinner("Leyendo respuestas GraphQL y reconstruyendo publicaciones..."):
            rows, diagnostics = _extract_from_uploaded(payload, start_text, end_text)
        st.session_state.rows = _ensure_ai_fields(rows)
        st.session_state.diagnostics = diagnostics
        st.session_state.ai_diagnostics = {}
        st.success(f"Se recuperaron {len(rows)} publicaciones únicas.")
    except Exception as exc:
        st.exception(exc)


rows = st.session_state.rows
if rows:
    diagnostics = st.session_state.diagnostics
    st.subheader("2. Resultado de extracción")

    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Publicaciones", len(rows))
    m2.metric("Solicitudes GraphQL", diagnostics.get("solicitudes_graphql", 0))
    m3.metric("Timeline", diagnostics.get("solicitudes_timeline", 0))
    m4.metric("Duplicados eliminados", diagnostics.get("duplicados", 0))

    preview = pd.DataFrame(rows)[[
        "fecha", "hora", "cuenta", "publicacion", "formato",
        "reacciones", "comentarios", "compartidos", "url"
    ]].copy()
    preview.columns = [
        "Fecha", "Hora", "Cuenta", "Publicación", "Formato",
        "Reacciones", "Comentarios", "Compartidos", "URL"
    ]
    st.dataframe(preview, use_container_width=True, height=390, hide_index=True)

    st.subheader("3. Clasificar con Gemini")
    st.write(
        "La IA analiza el sujeto central de cada publicación. No clasifica una publicación como Gobierno "
        "solo por contener hashtags institucionales."
    )
    classify_clicked = st.button(
        "✨ Clasificar Propia / Gobierno / Gobernador",
        type="primary",
        disabled=not api_key.strip(),
        use_container_width=True,
    )
    if classify_clicked:
        try:
            auto_own = own_account.strip() or Counter(r.get("cuenta", "") for r in rows).most_common(1)[0][0]
            with st.spinner("Gemini está clasificando las publicaciones..."):
                ai_results, ai_diag = classify_posts(
                    rows,
                    api_key=api_key,
                    model=model,
                    own_account=auto_own,
                    governor_terms=governor_terms,
                    government_terms=government_terms,
                    extra_criteria=extra_criteria,
                    batch_size=8,
                )
            st.session_state.rows = _merge_ai(rows, ai_results)
            st.session_state.ai_diagnostics = ai_diag
            rows = st.session_state.rows
            fallbacks = ai_diag.get("fallbacks", 0)
            if ai_diag.get("errors"):
                st.warning(
                    f"Clasificación terminada con {fallbacks} respaldo(s) por reglas. "
                    "Revisa el diagnóstico de IA."
                )
            else:
                st.success(f"Clasificación terminada. Respaldos por reglas: {fallbacks}.")
        except Exception as exc:
            st.exception(exc)

    st.subheader("4. Revisar y corregir clasificación")
    st.caption("Puedes cambiar manualmente la categoría, confianza, tema y motivo antes de exportar.")

    editor_df = _rows_to_editor_df(st.session_state.rows)
    edited = st.data_editor(
        editor_df,
        use_container_width=True,
        height=520,
        hide_index=True,
        disabled=[
            "fecha", "hora", "cuenta", "publicacion", "url", "formato",
            "reacciones", "comentarios", "compartidos", "menciones", "post_id"
        ],
        column_config={
            "fecha": "Fecha",
            "hora": "Hora",
            "cuenta": "Cuenta",
            "pertenencia_ia": st.column_config.SelectboxColumn(
                "Pertenece a",
                options=CLASS_OPTIONS,
                required=False,
                width="medium",
            ),
            "confianza_ia": st.column_config.NumberColumn(
                "Confianza IA",
                min_value=0,
                max_value=100,
                step=1,
                width="small",
            ),
            "tema_ia": st.column_config.TextColumn("Tema / proyecto", width="large"),
            "motivo_ia": st.column_config.TextColumn("Motivo", width="large"),
            "publicacion": st.column_config.TextColumn("Publicación", width="large"),
            "url": st.column_config.LinkColumn("URL", width="medium"),
            "formato": "Formato",
            "reacciones": "Reacciones",
            "comentarios": "Comentarios",
            "compartidos": "Compartidos",
            "menciones": "Menciones / etiquetas",
            "post_id": "Post ID",
        },
        key="classification_editor",
    )

    if st.button("💾 Aplicar correcciones de la tabla", use_container_width=True):
        st.session_state.rows = _apply_editor(st.session_state.rows, edited)
        rows = st.session_state.rows
        st.success("Correcciones aplicadas.")

    rows = st.session_state.rows
    summary = _classification_summary(rows)
    s1, s2, s3, s4 = st.columns(4)
    s1.metric("Propia", summary.get("Propia", 0))
    s2.metric("Gobierno", summary.get("Gobierno", 0))
    s3.metric("Gobernador", summary.get("Gobernador", 0))
    s4.metric("Sin clasificar", summary.get("Sin clasificar", 0) + summary.get("", 0))

    st.subheader("5. Menciones por mes")
    monthly = _monthly_df(rows)
    if not monthly.empty:
        st.dataframe(monthly, use_container_width=True, hide_index=True)
    else:
        st.info("No fue posible agrupar publicaciones por mes.")

    st.subheader("6. Descargar resultados")
    combined_diag = dict(st.session_state.diagnostics)
    if st.session_state.ai_diagnostics:
        combined_diag["clasificacion_ia"] = st.session_state.ai_diagnostics

    xlsx = xlsx_bytes(rows, combined_diag)
    csv = csv_bytes(rows)

    d1, d2 = st.columns(2)
    with d1:
        st.download_button(
            "⬇️ Descargar Excel",
            data=xlsx,
            file_name="facebook_har_ia_resultado.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            use_container_width=True,
            type="primary",
        )
    with d2:
        st.download_button(
            "⬇️ Descargar CSV",
            data=csv,
            file_name="facebook_har_ia_resultado.csv",
            mime="text/csv",
            use_container_width=True,
        )

    with st.expander("Diagnóstico técnico"):
        st.json({
            "extraccion": st.session_state.diagnostics,
            "ia": st.session_state.ai_diagnostics,
        })

else:
    st.write("Carga al menos un archivo HAR para comenzar.")

st.divider()
st.caption(
    "Consejo de privacidad: el HAR puede contener encabezados y datos de sesión. "
    "Úsalo únicamente dentro de la aplicación y no lo publiques en GitHub."
)
