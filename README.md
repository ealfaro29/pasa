# pasa.

Una mini app para pasar texto y links entre tus equipos sin registro. Dos paneles: **Input** para pegar y **Output** con un hilo de historial y tarjetas de enlaces.

**App:** https://ealfaro29.github.io/pasa/

## Uso

1. Abre la app en un PC.
2. Pulsa **Conectar otro PC** y abre ese mismo enlace completo en el otro equipo.
3. Guarda el enlace en favoritos en ambos equipos. Al volver, solo tienes que abrirlo.
4. Pega para enviar automáticamente, o desmarca **Enviar al pegar** y pulsa **Enviar** / `Ctrl+Enter` / `⌘+Enter`.
5. Copia el texto recibido con un botón o abre su tarjeta de enlace.

Cada enlace completo identifica un espacio distinto. La dirección base recupera el último espacio usado en ese navegador; en un navegador nuevo crea otro. No publiques tu enlace de conexión: quien lo tenga puede leer y enviar a ese espacio.

## Funciones

- Sincronización en tiempo real y recuperación de mensajes mientras el otro equipo está cerrado.
- Hilo con los mensajes más recientes arriba; texto y links en un mismo envío.
- Tarjetas que reconocen YouTube, GitHub, X, Instagram, TikTok, Notion, Figma, Google Docs/Sheets/Slides/Drive, Canva, LinkedIn, Spotify y Wikipedia.
- El reconocimiento de tarjetas es local: usa la URL para identificar plataforma y tipo de contenido. No descarga títulos, imágenes ni metadatos externos.
- AES-256-GCM en el navegador antes de enviar. La clave viaja en el fragmento `#` de tu enlace, nunca en las peticiones al servidor.
- Historial y borrador locales cifrados; deduplicación, recuperación de conexión y reintentos acotados.
- Hasta 128 KiB de texto por envío, con compresión cuando está disponible.
- Diseño adaptable, navegación con teclado y respeto por el movimiento reducido.

## Transporte y límites

GitHub Pages sirve los archivos estáticos. [ntfy.sh](https://ntfy.sh) transporta únicamente sobres cifrados. La app no necesita tokens de GitHub, un backend propio ni configuración de cuentas.

El servicio público tiene límites y puede cambiar sus condiciones. Según la [documentación oficial](https://docs.ntfy.sh/publish/#limitations), el nivel gratuito permite 250 publicaciones diarias por IP. Los sobres de hasta 4096 bytes permanecen disponibles en el servidor durante 12 horas. Los sobres mayores se envían como un único archivo cifrado, disponible durante 3 horas. El historial ya descargado se conserva en el navegador durante un máximo de 12 horas, sujeto a 100 mensajes y al espacio local disponible. No es almacenamiento permanente ni un servicio con disponibilidad garantizada.

**Limpiar** en Output oculta el historial solo en ese navegador. No borra los mensajes del servidor ni de otros equipos. Los envíos fallidos se conservan para que puedas reintentarlos. Al borrar datos del navegador, abre de nuevo el enlace completo guardado en favoritos para recuperar el mismo espacio.

No hay analítica, cookies de seguimiento, scripts de terceros ni servicios de vistas previas. Los enlaces externos se abren con `noopener noreferrer`. El enlace de conexión es la credencial de acceso; protege tus equipos y compártelo únicamente con quien deba acceder.

## Desarrollo

Sin dependencias ni compilación. Requiere Node 22+ para los tests y Python 3 para el servidor de desarrollo.

```sh
npm run dev
npm run check
npm test
```

Abre http://127.0.0.1:4173. Para probar dos navegadores con almacenamiento independiente en el mismo equipo, abre el mismo fragmento de conexión en `http://localhost:4173`.

GitHub Pages publica la raíz de la rama `main`.
