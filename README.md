# Extractor Facebook HAR + IA v4.0

Herramienta web de respaldo adaptada al flujo de la extensión institucional v1.29. Conserva la carga de varios HAR y las métricas disponibles en la vista previa. Usa el mismo parser de publicaciones, criterios institucionales, clasificador multimodal y generador Excel que la extensión.

## Uso

1. Descomprime el ZIP completo y abre `index.html` en Chrome. Mantén todos los archivos en la misma carpeta. Si utilizas la versión publicada en GitHub Pages, sustituye sus archivos por los de este paquete.
2. Carga uno o varios HAR y pulsa **Analizar HAR**. Puede ser un HAR reducido generado por la extensión o un HAR de Chrome que incluya los cuerpos de respuesta.
3. Comprueba la cuenta seleccionada, el nombre de la dependencia y las fechas. **Aplicar cuenta y periodo** reconstruye el reporte después de cambiar estos campos. Las fechas vacías utilizan los límites disponibles de esa cuenta; el horario es America/Mexico_City. Se permiten hasta 5,000 publicaciones por reporte.
4. Ingresa tu clave de Gemini y pulsa **Clasificar con IA**. El modelo es `gemini-3.5-flash-lite`, igual que la extensión. Puedes exportar con reglas locales sin una clave; las filas que requieran revisión se señalan.
5. Revisa y corrige directamente en la tabla **formato, pertenencia y tema**. Cada cambio se guarda. Descarga el Excel; si necesitas transferir datos o conservar una copia, descarga también el respaldo JSON.

Al cambiar de cuenta se invalida la vista anterior hasta aplicar la nueva selección. No se mezclan las publicaciones de las distintas dependencias encontradas en un HAR.

## Clasificación

- Formato: **Infografía, Video, Fotografía, Texto**.
- Pertenencia: **Propias, Gobernador, Gobierno del Estado**.
- Tema: asunto o proyecto identificado por separado de la pertenencia; admite corrección libre.

Los identificadores de Puebla y el perfil de la dependencia se proponen automáticamente. Puedes añadir cuentas, hashtags, descripción institucional y un criterio específico. Una actividad propia concreta tiene prioridad; una mención o un hashtag incidental no basta por sí solo. Se conservan las reglas de pertenencia y sus alertas de discrepancia con Gemini.

La IA recibe texto y hasta tres imágenes para publicaciones identificadas técnicamente como carruseles de fotos, o una para los otros casos, conforme a la selección de la extensión. Un video técnicamente verificado mantiene ese formato. Una escena con personas, poco texto y algunos logos puede ser Fotografía; un cartel con tipografía y datos dominantes puede ser Infografía aunque incluya personas. Si la imagen no se puede descargar, la publicación se conserva y la revisión visual queda pendiente. No se garantiza una clasificación exacta.

## Excel entregable

Se utiliza directamente `xlsx.js` de la extensión v1.29, sin una librería remota para Excel. El archivo se nombra con **dependencia, Facebook y periodo**, y contiene exactamente:

- **Publicaciones:** fecha/hora, bloque operativo, texto, formato, pertenencia, tema, red, autor, enlace, revisión y motivos.
- **Estadísticas:** conteos y porcentajes por formato, pertenencia, red, mes y tema, con el mismo diseño de la extensión.

Las celdas son editables. Formato y pertenencia tienen listas de opciones cerradas; tema es texto libre. No hay protección de hoja. Las fórmulas actualizan los conteos al cambiar las filas existentes en una aplicación compatible; para agregar filas es necesario ampliar los rangos. Se puede importar el XLSX en Google Sheets.

Las reacciones, comentarios y compartidos disponibles se muestran en pantalla. Se mantienen fuera del Excel para respetar exactamente el formato institucional de la extensión. Un HAR reducido puede no contener esas métricas; no se inventan valores faltantes.

## Rapidez y conservación

- Dos lotes simultáneos por defecto, de cinco publicaciones cada uno, con descargas de imágenes en paralelo.
- Cada lote terminado se guarda antes de continuar. Una huella permite reutilizar resultados solo con contenido, imágenes/enlaces, contexto, configuración, modelo y versión de criterios iguales. Una imagen ausente impide reutilizar esa clasificación.
- Las tres correcciones manuales completas tienen prioridad y evitan el análisis de esa publicación. Las correcciones parciales de un campo se conservan sin impedir que se analicen los otros.
- Puedes elegir uno, dos o tres lotes y ajustar el máximo de solicitudes por minuto a tu cuota. El valor inicial es 10. La cuota por tokens o por día también puede limitar el trabajo; no se garantiza un tiempo determinado.
- Las descargas tienen un límite de ocho segundos y cada intento de respuesta de Gemini de 25 segundos, incluida su lectura. Los reintentos son limitados. Se respeta la espera por cuota y se detienen nuevos lotes si el límite persiste o solicita más de un minuto.
- **Terminar y descargar Excel** interrumpe la clasificación y genera el archivo con lo disponible. Las publicaciones sin resultado se mantienen con reglas y una marca de revisión.

Mantén la página abierta mientras clasifica. **Abrir guardadas** permite recuperar publicaciones y correcciones después de cerrar o recargar. El guardado pertenece al navegador y a la ubicación desde donde se abre la aplicación; no comparte automáticamente la base de la extensión. Usa JSON para transferir o proteger los datos antes de cambiar de equipo, dirección de la aplicación o borrar datos del navegador.

## Compatibilidad con respaldos y correcciones

**Respaldo JSON** usa el esquema `metadata` + `posts` de la extensión. Puedes restaurar `datos_facebook_*.json` de cualquiera de las dos herramientas. Conserva correcciones y resultados IA; su reutilización exige que la huella de entrada coincida. Si cambia el perfil o la configuración se vuelve a solicitar la clasificación.

Para traer correcciones de Excel o Sheets, guarda **Publicaciones** como CSV e impórtala en **Respaldos y correcciones**. Se vinculan por **Enlace** las filas del reporte seleccionado y se validan las listas de formato/pertenencia. El botón CSV genera las mismas columnas.

## HAR y privacidad

La aplicación lee el HAR localmente y conserva los datos normalizados de publicaciones, no el tráfico completo ni sus cabeceras. No sube el HAR a un servidor. Al usar IA, texto e imágenes accesibles se envían directamente a Google. La clave solo permanece en el campo y las solicitudes de esta sesión; no se guarda, no se incluye en respaldos y se transmite en una cabecera, no en la URL.

Si necesitas un HAR de Chrome: abre el perfil de Facebook, abre las herramientas de desarrollador, selecciona Red/Network, conserva el registro y recorre el periodo. Exporta un HAR **con contenido**. Un HAR sin cuerpos de respuesta no permite reconstruir publicaciones. La captura directa sin estos pasos corresponde a la extensión; este sitio sigue siendo un importador de respaldo.

## Validación

Las pruebas están en `tests`: `node tests/report.cjs`, `node tests/gemini.cjs` y `node tests/interface.cjs`.

Se verificaron 57 comprobaciones con los HAR aportados disponibles: 21 de HAR/reporte, 23 de Gemini y 13 de interfaz. Se recuperaron 21 publicaciones de USEP y 357 de CECyTE; USEP conserva 12 publicaciones del 7 de octubre de 2026 en horario de Puebla. Los HAR de usuario no se distribuyen.

Se verificaron también la sintaxis, las referencias HTML y la estructura XML del XLSX: dos hojas, listas de validación, sin protección y fórmulas estadísticas. Chrome/DOM, IndexedDB y Gemini se simularon. No se probó una clave real ni una sesión de navegador en vivo, ni se publicó en GitHub Pages. La cobertura sigue limitada a lo capturado en los HAR.
