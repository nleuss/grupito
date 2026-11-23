# Vidioma

Extensión de Chrome para aprender idiomas con **subtítulos duales** en Netflix, YouTube, Disney+, Prime Video y tus propios vídeos. Es una recreación funcional de lo que hace RemFluent, escrita desde cero (ni código ni marca suyos). «Vidioma» es un nombre provisional: se cambia en `src/_locales/*/messages.json` y en `src/ui/i18n.ts`.

## Qué hace

| Función | Estado |
|---|---|
| Subtítulos duales (idioma que aprendes + tu idioma) en Netflix, YouTube, Disney+ y Prime Video | ✅ |
| Usa la pista oficial en tu idioma si existe; si no, traducción automática | ✅ |
| Traducción automática de YouTube (`tlang`) cuando está disponible | ✅ |
| Clic en cualquier palabra → ficha: traducción, acepciones por categoría, definiciones, pronunciación (TTS) | ✅ |
| «Explicar con IA» (Claude): significado en esa frase, gramática, forma base, ejemplos | ✅ (requiere clave propia) |
| Furigana + romaji (japonés, con kuromoji, sin conexión) y pinyin (chino) | ✅ |
| Romanización de coreano, cirílico y griego | ✅ (coreano simplificado, sin todas las reglas de asimilación) |
| Subtítulos generados a partir del audio («subtítulos con IA»), útil para series dobladas | ✅ (requiere clave de voz a texto) |
| Guardar palabras y frases con su contexto, enlace al minuto exacto del vídeo | ✅ |
| Vocabulario: búsqueda, filtros, estado (nueva / aprendiendo / conocida), edición | ✅ |
| Exportar a Anki: `.apkg`, CSV o envío directo con AnkiConnect | ✅ |
| Reproductor de vídeos locales: archivos de subtítulos, transcripción con IA, mazo de Anki con **audio y captura** de cada línea | ✅ |
| Transcripción lateral, pausa automática al final de cada línea, repetir línea, velocidad, ajuste de sincronía | ✅ |
| Cualquier otra web con `<video>` (botón «Usar en esta página») | ✅ (básico) |
| Interfaz en español e inglés | ✅ |
| Cuentas, pagos, servidor propio | ❌ No hay backend: cada usuario pone sus propias claves (o usa las opciones gratuitas) |

## Instalación (desarrollo)

```bash
npm install
npm run build          # genera dist/
```

En Chrome: `chrome://extensions` → activa «Modo de desarrollador» → «Cargar descomprimida» → elige la carpeta `dist/`.

`npm run zip` genera `vidioma-<versión>.zip` (≈15 MB; la mayor parte es el diccionario japonés).

## Uso

1. Abre un vídeo en Netflix, YouTube, Disney+ o Prime Video. Elige en el popup qué idioma aprendes y cuál es el tuyo.
2. Los subtítulos aparecen sobre el vídeo. Pasa el ratón para ver la barra de Vidioma (pistas, traducción, transcripción, opciones).
3. Haz clic en una palabra para ver su ficha y guárdala con ☆.

Atajos: <kbd>A</kbd>/<kbd>S</kbd>/<kbd>D</kbd> línea anterior / repetir / siguiente · <kbd>Q</kbd> pausa automática · <kbd>W</kbd> mostrar traducción · <kbd>E</kbd> revelar traducción difuminada · <kbd>R</kbd> romanización · <kbd>G</kbd> transcripción · <kbd>[</kbd> <kbd>]</kbd> retraso de subtítulos · <kbd>Esc</kbd> cerrar ficha · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> subtítulos con IA.

## Proveedores (Ajustes)

- **Traducción**
  - *Automático* (por defecto): traductor local de Chrome (Translator API, Chrome 138+) y, si no está disponible para ese par de idiomas, Google Translate.
  - *Google Translate*: gratis, pero usa un endpoint **no oficial** (`translate.googleapis.com/translate_a/single`). Puede limitar peticiones (HTTP 429) o cambiar sin aviso, y sus condiciones de uso no lo contemplan para un producto comercial.
  - *DeepL*: clave de API (la gratuita termina en `:fx`).
  - *Claude*: clave de API de Anthropic; traduce con contexto del vídeo.
- **IA (Claude)**: «Explicar con IA» usa la API de Anthropic con salida estructurada (JSON schema) y `effort: low`. Modelo por defecto **Claude Opus 5.5**; Haiku 5.5 es bastante más barato y rápido. La clave se guarda solo en el dispositivo (`chrome.storage.local`) y solo se envía a `api.anthropic.com`.
- **Voz a texto** (subtítulos con IA): cualquier endpoint compatible con `/audio/transcriptions` de OpenAI: OpenAI `whisper-1`, Groq `whisper-large-v3-turbo` (más barato) o un servidor Whisper local. Los hosts que no vienen en el manifiesto piden permiso al pulsar «Probar».

## Cómo funciona por dentro

```
src/
  content/main-world.ts   Hooks en la página (fetch, XHR, JSON.parse) que detectan los subtítulos que descarga el propio reproductor
  content/adapters/       Netflix (manifiesto + API del reproductor para buscar), YouTube (token "pot" reutilizado),
                          Disney+ (listas HLS con segmentos WebVTT), Prime Video (GetPlaybackResources + TTML), genérico
  content/index.ts        Monta la capa sobre el <video> (shadow DOM cerrado) y la conecta con el controlador
  ui/                     Controlador compartido (pistas, sincronía, traducción por lotes, pausa automática, IA) y la interfaz (Preact)
  subtitles/              Parsers: WebVTT, SRT, TTML/DFXP/IMSC, YouTube json3/srv3, ASS, HLS; alineación entre pistas
  background/             Service worker: traducción + caché IndexedDB, diccionario (Google + Wiktionary), Claude, captura de pestaña
  offscreen/              Análisis de japonés/chino y captura de audio de la pestaña (AudioWorklet → trozos por silencios → Whisper)
  export/                 .apkg (SQLite con sql.js + zip), CSV, AnkiConnect, clips MP3 y capturas JPEG
  pages/                  Popup, ajustes, vocabulario y reproductor local
```

Los subtítulos con IA en Netflix/Disney+/Prime capturan el **audio** de la pestaña (`chrome.tabCapture`), lo cortan en las pausas y lo transcriben. Funcionan casi en tiempo real (unos segundos de retraso) y las líneas quedan colocadas en su minuto exacto, así que al rebobinar aparecen sincronizadas. Para iniciarlos, Chrome exige un gesto sobre la extensión (el botón del popup o el atajo de teclado).

## Pruebas

```bash
npm test                 # 30 tests unitarios (parsers, alineación, troceado de audio, japonés con kuromoji, chino, parsers de diccionario)
npm run typecheck
npm run test:e2e         # build de test + 9 pruebas en Chromium real con la extensión cargada
```

Las pruebas end-to-end levantan un servidor que **imita** lo que la extensión necesita de cada plataforma (manifiesto de Netflix, API de subtítulos de YouTube que exige token, listas HLS de Disney+, respuesta de Prime, API de voz a texto) y comprueban subtítulos duales, ficha de palabra, guardado, navegación, pausa automática, furigana, reproductor local, transcripción y exportación. Con `VIDIOMA_ANKI_PYTHON=/ruta/a/python` (un entorno con `pip install anki`) además importan los `.apkg` generados con la librería oficial de Anki y verifican notas, campos y archivos multimedia.

## Limitaciones (sin adornos)

- **No está probado contra los servicios reales.** Las pruebas usan imitaciones locales; en el entorno donde se construyó no había acceso a Netflix, YouTube, Disney+, Prime, Google Translate, DeepL, Anthropic ni OpenAI. La integración con cada plataforma se basa en cómo funcionan hoy sus reproductores, y estas webs cambian por dentro con frecuencia: es lo primero que hay que validar a mano, y lo que más mantenimiento va a pedir.
- **Prime Video**: algunos títulos tienen un desfase entre el tiempo del `<video>` y el de los subtítulos. La extensión lo estima leyendo el reloj del reproductor; si no lo consigue, se corrige con <kbd>[</kbd> <kbd>]</kbd>.
- **Disney+**: los selectores para ocultar sus subtítulos nativos son aproximados; si se ven duplicados, desactívalos en el menú de Disney+.
- **Capturas de pantalla y audio para Anki** solo en el reproductor local: el vídeo de Netflix/Disney+/Prime está protegido con DRM.
- La transcripción de archivos locales decodifica todo el audio en memoria (≈230 MB por hora de vídeo).
- El traductor local de Chrome necesita descargar el modelo la primera vez (Chrome lo pide con un clic) y no cubre todos los pares de idiomas.

## Privacidad

No hay servidor de Vidioma. Ajustes y vocabulario se guardan en el navegador (los ajustes, sin claves, se sincronizan con tu cuenta de Chrome). Al traducir, buscar o transcribir se envía el texto o el audio necesario al proveedor que elijas, y solo a ese.
