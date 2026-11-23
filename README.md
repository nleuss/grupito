# Vidioma

Extensión de Chrome para aprender idiomas con dos partes:

- **Vídeos**: subtítulos duales en **YouTube y Netflix** (una recreación funcional de lo que hace RemFluent, escrita desde cero, sin su código ni su marca).
- **Libros**: un lector de **PDF, EPUB y TXT**. Las palabras son clicables, hay traducción por párrafos y la IA conoce el libro entero.

Las palabras guardadas en vídeos y libros van al mismo vocabulario y al mismo mazo de Anki. «Vidioma» es un nombre provisional: se cambia en `src/_locales/*/messages.json` y en `src/ui/i18n.ts`.

## Qué hace

| Función | YouTube | Netflix |
|---|---|---|
| Subtítulos duales (idioma que aprendes + tu idioma) | ✅ | ✅ |
| Traducción: pista oficial en tu idioma → traducción de YouTube (`tlang`) → traducción automática | ✅ | ✅ (sin `tlang`) |
| Subtítulos automáticos (ASR) unidos en frases completas | ✅ | — |
| Sin subtítulos durante los anuncios | ✅ | — |
| Clic en una palabra: traducción, acepciones, definiciones, pronunciación | ✅ | ✅ |
| «Explicar con IA» (Claude): significado en esa frase, gramática, forma base, ejemplos | ✅ | ✅ |
| Furigana + romaji (japonés, sin conexión), pinyin (chino); romanización de coreano, cirílico y griego | ✅ | ✅ |
| Subtítulos generados a partir del audio (útil si el vídeo no tiene subtítulos) | ✅ | ✅ |
| Línea anterior / repetir / siguiente, pausa al final de cada línea, velocidad, ajuste de sincronía | ✅ | ✅ (vía la API del reproductor de Netflix) |
| Transcripción lateral con clic para saltar | ✅ | ✅ |
| Vocabulario con contexto y enlace al minuto exacto; exportación a Anki (`.apkg`, CSV, AnkiConnect) | ✅ | ✅ |

Extras: reproductor de vídeos locales (archivos de subtítulos, transcripción con IA, mazos de Anki con audio y captura de cada línea) y un modo básico para cualquier otra web con `<video>` («Usar en esta página» en el popup). Interfaz en español e inglés. No hay servidor ni cuentas: las funciones de pago usan tus propias claves.

## Lector de libros

Se abre desde el popup («Leer un libro»). Si la pestaña activa es un PDF, el popup ofrece «Abrir este PDF en el lector».

- **Formatos**: PDF con texto (pdf.js), EPUB 2/3 y TXT/Markdown/HTML. Del PDF se reconstruyen los párrafos: se unen las líneas, se quitan guiones de corte de línea, cabeceras repetidas y números de página, y los capítulos salen de los marcadores del PDF o de sus títulos.
- **Biblioteca** guardada en el navegador, que recuerda por dónde ibas en cada libro.
- **Clic en una palabra**: diccionario, traducción y pronunciación. Al seleccionar varias palabras aparecen «Traducir» y «Explicar».
- **Traducción por párrafos** bajo el original (con opción de difuminarla), o solo del párrafo que elijas. 🔊 lee el párrafo en voz alta.
- **IA que conoce el libro** (Claude, con tu clave):
  1. «Analizar el libro entero con IA»: Claude lee el libro completo una vez y escribe notas: premisa sin spoilers, resumen completo (oculto por defecto), personajes, lugares, el vocabulario propio del libro y el estilo. Antes de lanzarlo ves los tokens y el coste estimado. Los libros que no caben en una petición se leen por partes y luego se combinan las notas.
  2. «Explicar en el contexto del libro»: explica la palabra o frase en ese pasaje concreto, usando esas notas más los párrafos de alrededor. Tiene orden de no revelar nada que pase después de ese punto. Las notas van en caché de prompt, así que las consultas siguientes son más baratas.
  - Sin análisis previo también funciona, pero solo con el pasaje.
- Coste orientativo del análisis de una novela de ~150.000 palabras (~200.000 tokens): unos 0,80 $ con Opus 5.5, 0,40 $ con Sonnet 5.5 y 0,10 $ con Haiku 5.5, una sola vez. El modelo se elige en el propio panel.

Limitaciones del lector: los PDF escaneados (imágenes, sin capa de texto) no se pueden leer porque no hay OCR; los EPUB con DRM tampoco. Los PDF a dos columnas (artículos científicos) pueden mezclar líneas de ambas columnas.

## Instalación

```bash
npm install
npm run build          # genera dist/
```

En Chrome: `chrome://extensions` → activa «Modo de desarrollador» → «Cargar descomprimida» → carpeta `dist/`.

`npm run zip` genera `vidioma-<versión>.zip` (≈15 MB; casi todo es el diccionario japonés).

## Uso

1. En el popup elige qué idioma aprendes y cuál es el tuyo.
2. Abre un vídeo de YouTube o Netflix. Si hay subtítulos en el idioma que aprendes, aparecen sobre el vídeo con la traducción debajo. Pasa el ratón por el vídeo para ver la barra de Vidioma (pistas, traducción, transcripción, opciones).
3. Haz clic en una palabra para ver su ficha y guárdala con ☆.

Atajos: <kbd>A</kbd>/<kbd>S</kbd>/<kbd>D</kbd> línea anterior / repetir / siguiente · <kbd>Q</kbd> pausa automática · <kbd>W</kbd> mostrar traducción · <kbd>E</kbd> revelar traducción difuminada · <kbd>R</kbd> romanización · <kbd>G</kbd> transcripción · <kbd>[</kbd> <kbd>]</kbd> retraso de subtítulos · <kbd>Esc</kbd> cerrar ficha · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> subtítulos con IA. En Netflix, <kbd>S</kbd> sustituye a su atajo de «saltar intro» mientras Vidioma muestra subtítulos.

## Cómo consigue los subtítulos

- **YouTube**: lee la lista de pistas de la respuesta del reproductor. YouTube exige un token de prueba de origen (`pot`) para descargar subtítulos, y solo su reproductor sabe generarlo. Por eso Vidioma observa la petición de subtítulos que hace el propio reproductor (token y parámetros de cliente incluidos) y la reutiliza cambiando solo la pista (`lang`, `kind`, `name`, `tlang`), igual que hace YouTube al cambiar de idioma. Si el reproductor aún no ha pedido subtítulos, se los pide por su API y, si eso no basta, pulsa el botón CC. Efecto secundario: los subtítulos nativos quedan activados en YouTube (ocultos mientras Vidioma está activo).
- **Netflix**: añade formatos de subtítulos de texto a la petición del manifiesto y lee la lista de pistas de la respuesta. Busca, pausa y reanuda con la API del reproductor de Netflix, porque cambiar `video.currentTime` directamente hace fallar el reproductor.

## Proveedores (Ajustes)

- **Traducción**
  - *Automático* (por defecto): traductor local de Chrome (Translator API, Chrome 138+) y, si no está disponible para ese par de idiomas, Google Translate. En YouTube, con subtítulos humanos sin pista en tu idioma, se usa la traducción de YouTube; si la traducción automática falla dos veces, cambia sola a la de YouTube.
  - *Google Translate*: gratis, pero usa un endpoint **no oficial** (`translate.googleapis.com/translate_a/single`). Puede limitar peticiones (HTTP 429) o cambiar sin aviso, y sus condiciones de uso no lo contemplan para un producto comercial.
  - *DeepL*: clave de API (la gratuita termina en `:fx`).
  - *Claude*: clave de API de Anthropic; traduce con contexto del vídeo.
- **IA (Claude)**: «Explicar con IA» usa la API de Anthropic con salida estructurada (JSON schema) y `effort: low`. Modelo por defecto **Claude Opus 5.5**; Haiku 5.5 es bastante más barato y rápido. La clave se guarda solo en el dispositivo (`chrome.storage.local`) y solo se envía a `api.anthropic.com`.
- **Voz a texto** (subtítulos con IA): cualquier endpoint compatible con `/audio/transcriptions` de OpenAI: OpenAI `whisper-1`, Groq `whisper-large-v3-turbo` (más barato) o un servidor Whisper local. Los hosts que no vienen en el manifiesto piden permiso al pulsar «Probar».

## Estructura

```
src/
  content/main-world.ts   Hooks en la página (fetch, XHR, JSON.parse) que ven los subtítulos que descarga el propio reproductor
  content/adapters/       youtube.ts, netflix.ts y generic.ts (cualquier otra web)
  content/index.ts        Monta la capa sobre el <video> (shadow DOM cerrado) y la conecta con el controlador
  ui/                     Controlador compartido (pistas, sincronía, traducción por lotes, pausa automática, IA) e interfaz (Preact)
  subtitles/              Parsers: WebVTT, SRT, TTML/DFXP/IMSC, YouTube json3/srv3, ASS, HLS; alineación y unión de fragmentos
  background/             Service worker: traducción + caché IndexedDB, diccionario (Google + Wiktionary), Claude, captura de pestaña
  offscreen/              Análisis de japonés/chino y captura de audio (AudioWorklet → trozos por silencios → Whisper)
  export/                 .apkg (SQLite con sql.js + zip), CSV, AnkiConnect, clips MP3 y capturas JPEG
  pages/                  Popup, ajustes, vocabulario y reproductor local
```

## Pruebas

```bash
npm test                 # 39 tests unitarios
npm run typecheck
npm run test:e2e         # build de test + 11 pruebas en Chromium real con la extensión cargada
npm run check:youtube    # comprobación contra el YouTube real (requiere una conexión normal, no de centro de datos)
```

Las pruebas end-to-end levantan un servidor que **imita** lo que la extensión necesita de cada plataforma:

- Un YouTube que solo entrega subtítulos si la petición lleva el token y los parámetros de cliente del reproductor. Comprueba que se reutiliza esa petición para la traducción de YouTube, que los subtítulos automáticos se unen en frases, que desaparecen durante un anuncio y el respaldo del botón CC.
- Un Netflix con su manifiesto y una API de reproductor falsa. Comprueba los formatos añadidos a la petición, que se ignora el manifiesto del episodio siguiente y que se busca, pausa y reanuda por la API.

- El lector: un PDF generado en la propia prueba (con marcadores, cabecera repetida, números de página y guiones blandos) y un EPUB. Comprueba capítulos, párrafos limpios, ficha de palabra, explicación con contexto, traducciones, análisis (con una IA simulada) y que recuerda la posición.

Con `VIDIOMA_ANKI_PYTHON=/ruta/a/python` (un entorno con `pip install anki`) además importan los `.apkg` generados con la librería oficial de Anki.

## Limitaciones (sin adornos)

- **No está probado contra YouTube ni Netflix reales.** Las pruebas usan imitaciones locales. Al intentarlo desde el servidor donde se construyó, Google bloqueó su IP («tráfico inusual», HTTP 429). La integración sigue cómo funcionan hoy sus reproductores, y cambian por dentro con frecuencia: es lo primero que hay que validar a mano (o con `npm run check:youtube` desde tu conexión) y lo que más mantenimiento pedirá.
- **La IA de libros no se ha probado con la API real** (no hay clave en el entorno de desarrollo); las pruebas usan respuestas simuladas.
- **Netflix**: la detección del manifiesto depende de nombres internos (`timedtexttracks`, `ttDownloadables`, perfiles como `webvtt-lssdh-ios8`) que Netflix puede cambiar.
- **Capturas de pantalla y audio para Anki** solo en el reproductor local: el vídeo de Netflix está protegido con DRM.
- Los subtítulos con IA tienen unos segundos de retraso la primera vez que se reproduce un fragmento; al rebobinar ya aparecen sincronizados.
- El traductor local de Chrome necesita descargar el modelo la primera vez y no cubre todos los pares de idiomas.

## Privacidad

No hay servidor de Vidioma. Ajustes y vocabulario se guardan en el navegador (los ajustes, sin claves, se sincronizan con tu cuenta de Chrome). Al traducir, buscar o transcribir se envía el texto o el audio necesario al proveedor que elijas, y solo a ese.
