# Extractor Facebook HAR + IA — Streamlit v4.0

Aplicación web para recuperar publicaciones reales de Facebook desde archivos HAR y clasificarlas con Gemini en:

- **Propia**
- **Gobierno**
- **Gobernador**

También genera un Excel con las hojas **Publicaciones**, **Resumen**, **Diagnóstico** y **Menciones por mes**.

## Despliegue en Streamlit Community Cloud

1. Sube estos archivos a la **raíz** de tu repositorio de GitHub:
   - `app.py`
   - `har_extractor.py`
   - `ai_classifier.py`
   - `exporter_ai.py`
   - `requirements.txt`
   - `.gitignore`
   - `.streamlit/config.toml`
   - `README.md`
2. Entra a `https://share.streamlit.io/` e inicia sesión con GitHub.
3. Elige **Create app / New app**.
4. Selecciona tu repositorio y configura:
   - Branch: `main`
   - Main file path: `app.py`
5. Pulsa **Deploy**.
6. Streamlit generará una URL `https://...streamlit.app`.

No es necesario instalar Python en las computadoras que usarán la aplicación.

## Uso

1. En Facebook abre Herramientas de desarrollador (`F12`).
2. Abre **Network / Red** y activa **Preserve log / Conservar registro**.
3. Filtra por `graphql` y desplázate por el perfil hasta cargar el periodo deseado.
4. Guarda: **Save all as HAR with content**.
5. En la app Streamlit carga uno o varios `.har`.
6. Pulsa **Analizar HAR**.
7. Introduce tu API key de Gemini y clasifica.
8. Revisa/corrige la categoría de cada publicación.
9. Descarga Excel o CSV.

## Seguridad

- **Nunca subas archivos `.har` al repositorio.** Pueden contener datos de sesión.
- **Nunca escribas la API key de Gemini en el código o en GitHub.** La app tiene un campo privado para introducirla durante cada sesión.
- Si prefieres guardar la API key como un secreto de Streamlit, modifica `app.py` para leer `st.secrets`, pero ten en cuenta que una app pública podría consumir esa clave.

## Requisitos del servidor

Streamlit instala automáticamente lo indicado en `requirements.txt`. No hay instalador local.
