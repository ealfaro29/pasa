# pasa.

Una mini app para compartir texto, links y archivos entre tus equipos o con otra persona, sin registro. **Input** permite pegar texto; **Output** muestra el historial y los links; **Archivos compartidos** conserva las descargas del espacio.

**App:** https://ealfaro29.github.io/pasa/

## Uso

1. Abre tu enlace privado completo de Pasa en ambos PCs y guárdalo en favoritos.
2. Para conectar otro equipo, pulsa **Conectar otro PC** y copia el enlace.
3. Pega para enviar automáticamente, o desmarca **Enviar al pegar** y pulsa **Enviar** / `Ctrl+Enter` / `⌘+Enter`.
4. Copia el texto recibido con un botón o abre su tarjeta de enlace.
5. Pulsa **Cargar anteriores** para recorrer el historial guardado en el servidor.
6. Usa **Archivar** debajo de cada link para retirarlo de Activos. Si un envío incluye varios links, puedes archivar cada uno por separado. **Archivados** permite recuperarlos con **Restaurar**; ambos cambios se sincronizan entre equipos.
7. En **Archivos compartidos**, arrastra archivos o pulsa **Subir archivos**. Tú y la otra persona pueden descargarlos con su nombre original. El máximo es **250 MB (250 MiB) por archivo**; los archivos no caducan automáticamente.
8. Pulsa **Ver 3D** en un `.stl` o `.3mf` para girar y acercar el modelo, centrarlo o activar **Malla**. El visor muestra dimensiones y número de triángulos. **Ver** abre imágenes, PDF y texto; **Descargar** sigue disponible dentro del visor.

La dirección base recupera el último espacio usado en ese navegador. En un navegador nuevo solicita el enlace de conexión, que contiene la clave privada después de `#`. El backend admite únicamente los espacios habilitados por el propietario; abrir la dirección base no crea espacios públicos.

## Funciones

- Conexión directa al backend propio de Pasa, alojado en la cuenta del propietario en Cloudflare.
- Sincronización en tiempo real y recuperación de mensajes mientras el otro equipo está cerrado.
- Historial persistente sin caducidad automática ni contador diario de envíos en la app.
- Archivado y restauración por link o por mensaje de texto, sincronizados y recuperables aunque el original ya esté fuera de la última página del historial.
- Archivos compartidos de hasta 250 MiB, con progreso, descarga y reintento desde las partes guardadas durante la sesión. Mantén la página abierta mientras subes; al cerrarla, vuelve a seleccionar un archivo que no terminó de subirse.
- Visor local de STL binario/ASCII y 3MF, incluidas piezas con transformaciones y referencias internas de proyectos de Bambu. Los 3MF conservan sus unidades y colores básicos; el STL se muestra en unidades del archivo porque el formato no define una unidad física.
- Vista previa de imágenes, PDF y texto. HTML y SVG se muestran como texto, sin ejecutar su contenido. Los documentos se descifran en el navegador; el visor no usa servicios de conversión externos.
- Paginación para recorrer conversaciones largas sin descargar todo el historial al abrir.
- Tarjetas con foto, título y descripción para productos de Amazon, artículos y páginas públicas; reconocimiento de YouTube, GitHub, X, Instagram, TikTok, Notion, Figma, Google Docs/Sheets/Slides/Drive, Canva, LinkedIn, Spotify y Wikipedia.
- Las vistas previas las obtiene nuestro propio backend desde la página original: Open Graph, Twitter Cards, datos estructurados y, en Amazon, la imagen y el título del producto. Los precios solo se muestran si aparecen en los datos de la página. Si la web impide la consulta, se conserva una tarjeta de enlace limpia.
- AES-256-GCM en el navegador antes de enviar. La clave de cifrado permanece en el fragmento `#`, que no se incluye en las peticiones al servidor.
- Historial y borrador locales cifrados, deduplicación, recuperación de conexión y reintentos acotados.
- Hasta 128 KiB de texto por envío, con compresión cuando está disponible y un límite técnico de tamaño para proteger los recursos del servidor.
- Diseño adaptable, controles con teclado y respeto por el movimiento reducido.

## Backend y persistencia

GitHub Pages sirve los archivos estáticos. El backend usa un Cloudflare Worker, un Durable Object con SQLite por espacio autorizado y el bucket R2 privado `pasa-files`. Guarda sobres cifrados y transmite cambios mediante WebSockets. El texto, los nombres de archivo y los estados de archivado permanecen cifrados. El código del backend está en `backend/`; la dirección se configura en `config.js`.

Los archivos se cifran en el navegador por partes de 8 MiB con AES-256-GCM. Cada parte autentica el identificador del archivo y su posición. El servidor guarda únicamente partes cifradas en R2 y publica el archivo cuando todas están almacenadas. Cada petición transmite como máximo una parte; el navegador no carga el archivo completo para subirlo. La descarga recupera y verifica las partes antes de guardar el archivo original. Los catálogos de archivos y archivados se consultan por separado del historial para conservar su acceso entre páginas y navegadores. Los archivos de la versión inicial siguen siendo compatibles.

Las subidas incompletas se limpian después de 24 horas sin actividad. Esta limpieza no afecta a los archivos que ya terminaron de subirse.

El visor 3D usa Three.js, empaquetado en `vendor/model-viewer.js` y cargado al abrir el primer modelo. La lectura 3MF verifica el contenedor ZIP, sus tamaños y CRC antes de interpretar los modelos XML; las referencias quedan dentro del propio archivo. La vista previa admite hasta dos millones de triángulos, 128 MiB de STL y 256 MiB de XML de modelo descomprimido. No interpreta G-code, texturas ni instrucciones del laminador como geometría. Un proyecto con solo instrucciones de impresión o que exceda estos límites conserva su descarga original. Estos límites de vista previa no cambian los 250 MiB permitidos para compartir archivos.

La aplicación no aplica cuotas diarias ni borra automáticamente los mensajes por antigüedad. La infraestructura sigue sujeta a la capacidad y al plan de la cuenta de alojamiento; esto no constituye almacenamiento o capacidad física ilimitados.

El navegador mantiene una caché de hasta 100 mensajes y unos 3 MB para abrir rápido y recuperar envíos pendientes. Ese límite de caché no elimina el historial del servidor: los mensajes anteriores se consultan con **Cargar anteriores**. Los mensajes ya conservados por versiones anteriores se importan desde la caché cifrada al backend propio cuando es posible, sin contactar al relay anterior.

**Limpiar** en Output oculta el historial activo solo en ese navegador. No borra el servidor, los archivos ni el estado compartido de archivado. **Ver historial guardado** permite volver a mostrarlo. Los envíos pendientes y fallidos se conservan para reintentar. Si borras los datos del navegador, abre el enlace completo guardado en favoritos para entrar al mismo espacio.

El historial se almacena cifrado y acepta solo espacios autorizados. Para crear vistas previas, el navegador envía separadamente al backend la URL pública del enlace; nuestro servidor consulta esa página y sirve su imagen mediante un proxy firmado. El resto del mensaje sigue cifrado. El enlace completo permite leer y enviar en su espacio: mantenlo privado. No hay analítica, scripts de terceros ni servicios externos de vistas previas. Los enlaces privados, las credenciales en URLs y los destinos de red local no se consultan. Los enlaces externos se abren con `noopener noreferrer`.

## Desarrollo

Requiere Node 22+ para las pruebas y Python 3 para servir el frontend local.

```sh
npm run dev
npm run check
npm test
```

Si cambias `model-viewer-source.js` o `model-format.js`, ejecuta `npm run build:viewer` antes de publicar. El bundle y la licencia de Three.js se incluyen en el repositorio para servirlos directamente desde GitHub Pages, sin CDN.

Abre http://127.0.0.1:4173 con el fragmento de un espacio autorizado. Para probar dos navegadores con almacenamiento independiente, abre el mismo fragmento en `http://localhost:4173`.

GitHub Pages publica la raíz de `main`. El backend se despliega por separado con Wrangler y `backend/wrangler.jsonc`; `backend/entry.js` exporta únicamente el Worker y la clase Durable Object que admite el runtime. El binding `FILES` accede a `pasa-files`, que debe permanecer privado. `PREVIEW_SIGNING_KEY` firma el acceso a imágenes públicas de las tarjetas; se mantiene como secreto en el Worker. `ROOM_IDS` es un secreto de despliegue con los espacios permitidos, separados por comas. No se deben incluir claves de conexión, tokens ni datos privados en el repositorio.
