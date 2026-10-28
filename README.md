# pasa.

Una mini app personal para pasar texto y links entre tus equipos sin registro. Dos paneles: **Input** para pegar y **Output** con un hilo de historial y tarjetas de enlaces.

**App:** https://ealfaro29.github.io/pasa/

## Uso

1. Abre tu enlace privado completo de Pasa en ambos PCs y guárdalo en favoritos.
2. Para conectar otro equipo, pulsa **Conectar otro PC** y copia el enlace.
3. Pega para enviar automáticamente, o desmarca **Enviar al pegar** y pulsa **Enviar** / `Ctrl+Enter` / `⌘+Enter`.
4. Copia el texto recibido con un botón o abre su tarjeta de enlace.
5. Pulsa **Cargar anteriores** para recorrer el historial guardado en el servidor.

La dirección base recupera el último espacio usado en ese navegador. En un navegador nuevo solicita el enlace de conexión, que contiene la clave privada después de `#`. El backend admite únicamente los espacios habilitados por el propietario; abrir la dirección base no crea espacios públicos.

## Funciones

- Conexión directa al backend propio de Pasa, alojado en la cuenta del propietario en Cloudflare.
- Sincronización en tiempo real y recuperación de mensajes mientras el otro equipo está cerrado.
- Historial persistente sin caducidad automática ni contador diario de envíos en la app.
- Paginación para recorrer conversaciones largas sin descargar todo el historial al abrir.
- Tarjetas locales para YouTube, GitHub, X, Instagram, TikTok, Notion, Figma, Google Docs/Sheets/Slides/Drive, Canva, LinkedIn, Spotify y Wikipedia.
- El reconocimiento de tarjetas usa la URL para identificar plataforma y tipo de contenido; no consulta servicios externos de metadatos.
- AES-256-GCM en el navegador antes de enviar. La clave de cifrado permanece en el fragmento `#`, que no se incluye en las peticiones al servidor.
- Historial y borrador locales cifrados, deduplicación, recuperación de conexión y reintentos acotados.
- Hasta 128 KiB de texto por envío, con compresión cuando está disponible y un límite técnico de tamaño para proteger los recursos del servidor.
- Diseño adaptable, controles con teclado y respeto por el movimiento reducido.

## Backend y persistencia

GitHub Pages sirve los archivos estáticos. El backend propio usa un Cloudflare Worker y un Durable Object con SQLite por espacio autorizado. Guarda sobres cifrados de forma persistente y transmite los nuevos mensajes mediante WebSockets. No utiliza relays de notificaciones ni archivos con vencimiento. El código del backend está en `backend/`; la dirección se configura en `config.js`.

La aplicación no aplica cuotas diarias ni borra automáticamente los mensajes por antigüedad. La infraestructura sigue sujeta a la capacidad y al plan de la cuenta de alojamiento; esto no constituye almacenamiento o capacidad física ilimitados.

El navegador mantiene una caché de hasta 100 mensajes y unos 3 MB para abrir rápido y recuperar envíos pendientes. Ese límite de caché no elimina el historial del servidor: los mensajes anteriores se consultan con **Cargar anteriores**. Los mensajes ya conservados por versiones anteriores se importan desde la caché cifrada al backend propio cuando es posible, sin contactar al relay anterior.

**Limpiar** en Output oculta el historial solo en ese navegador. No borra el servidor ni los otros equipos. **Ver historial guardado** permite volver a mostrarlo. Los envíos pendientes y fallidos se conservan para reintentar. Si borras los datos del navegador, abre el enlace completo guardado en favoritos para entrar al mismo espacio.

El servidor guarda únicamente sobres cifrados y acepta solo espacios autorizados. El enlace completo permite leer y enviar en su espacio: mantenlo privado. No hay analítica, scripts de terceros ni servicios externos de vistas previas. Los enlaces externos se abren con `noopener noreferrer`.

## Desarrollo

Requiere Node 22+ para las pruebas y Python 3 para servir el frontend local.

```sh
npm run dev
npm run check
npm test
```

Abre http://127.0.0.1:4173 con el fragmento de un espacio autorizado. Para probar dos navegadores con almacenamiento independiente, abre el mismo fragmento en `http://localhost:4173`.

GitHub Pages publica la raíz de `main`. El backend se despliega por separado con Wrangler y su configuración `backend/wrangler.jsonc`. `ROOM_IDS` es un secreto de despliegue con la lista de identificadores de espacios permitidos, separados por comas. No se deben incluir claves de conexión, tokens ni datos privados en el repositorio.
