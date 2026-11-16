import { previewType } from './file-content.js?v=3.3.0';

const $ = id => document.getElementById(id);
const TEXT_PREVIEW_BYTES = 256 * 1024;
const formatBytes = size => size < 1024 ? `${size} B` : `${(size / (size < 1024 * 1024 ? 1024 : 1024 * 1024)).toLocaleString('es', { maximumFractionDigits: 1 })} ${size < 1024 * 1024 ? 'KB' : 'MB'}`;

export class FileViewer {
  constructor({ read, download }) {
    Object.assign(this, { read, download });
    this.dialog = $('file-viewer');
    this.viewport = $('viewer-viewport');
    this.generation = 0;
    $('viewer-close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => this.clear());
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.dialog.close(); });
    $('viewer-download').addEventListener('click', () => { if (this.message) this.download(this.message); });
    $('viewer-reset').addEventListener('click', () => this.model?.reset());
    $('viewer-wireframe').addEventListener('click', () => {
      this.wireframe = !this.wireframe;
      this.model?.setWireframe(this.wireframe);
      $('viewer-wireframe').setAttribute('aria-pressed', String(this.wireframe));
    });
  }

  clear() {
    this.generation++;
    this.controller?.abort();
    this.model?.dispose();
    this.model = null;
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.objectURL = null;
    this.message = null;
    this.blob = null;
    this.viewport.replaceChildren();
    document.body.classList.remove('viewer-open');
  }

  async open(message) {
    this.clear();
    this.message = message;
    const generation = this.generation;
    const current = () => generation === this.generation && this.dialog.open;
    const type = previewType(message.file);
    if (!type) return;
    this.controller = new AbortController();
    this.wireframe = false;
    $('viewer-title').textContent = message.file.name;
    $('viewer-meta').textContent = `${type.extension.toUpperCase()} · ${formatBytes(message.file.size)}`;
    $('viewer-status').textContent = 'Cargando y descifrando archivo…';
    $('viewer-status').hidden = false;
    $('viewer-model-tools').hidden = true;
    $('viewer-hint').hidden = true;
    $('viewer-wireframe').setAttribute('aria-pressed', 'false');
    this.viewport.dataset.kind = type.kind;
    this.viewport.setAttribute('aria-busy', 'true');
    if (!this.dialog.open) this.dialog.showModal();
    document.body.classList.add('viewer-open');
    try {
      const blob = await this.read(message, { signal: this.controller.signal,
        ...(type.kind === 'text' ? { maxBytes: TEXT_PREVIEW_BYTES } : {}),
        onProgress: (loaded, total) => {
          if (current()) $('viewer-status').textContent = `Cargando y descifrando… ${total ? Math.round(loaded / total * 100) : 100}%`;
        } });
      if (!current()) return;
      this.blob = blob;
      if (type.kind === 'model') {
        $('viewer-status').textContent = 'Preparando modelo 3D…';
        const [{ mountModel }, bytes] = await Promise.all([import('./vendor/model-viewer.js?v=3.3.0'), blob.arrayBuffer()]);
        if (!current()) return;
        const model = await mountModel(this.viewport, bytes, type.extension, { signal: this.controller.signal, onError: error => {
          if (!current()) return;
          this.model?.dispose();
          this.model = null;
          this.viewport.replaceChildren();
          $('viewer-status').hidden = false;
          $('viewer-status').textContent = error.message;
          $('viewer-model-tools').hidden = true;
          $('viewer-hint').hidden = true;
        }, onInfo: info => {
          if (!current()) return;
          const dimensions = info.dimensions.map(value => value.toLocaleString('es', { maximumFractionDigits: 2 })).join(' × ');
          $('viewer-meta').textContent = `${type.extension.toUpperCase()} · ${dimensions} ${info.unit} · ${info.triangles.toLocaleString('es')} triángulos`;
        } });
        if (!current()) { model.dispose(); return; }
        this.model = model;
        $('viewer-model-tools').hidden = false;
        $('viewer-hint').hidden = false;
      } else if (type.kind === 'image') {
        const image = document.createElement('img');
        image.alt = message.file.name;
        image.className = 'viewer-image';
        this.objectURL = URL.createObjectURL(new Blob([blob], { type: type.mime }));
        image.src = this.objectURL;
        await image.decode();
        if (!current()) return;
        this.viewport.append(image);
        $('viewer-meta').textContent += ` · ${image.naturalWidth} × ${image.naturalHeight} px`;
      } else if (type.kind === 'pdf') {
        const header = new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer());
        if (!header.includes('%PDF-')) throw new Error('Este archivo no contiene un PDF válido.');
        if (!current()) return;
        this.objectURL = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        const frame = document.createElement('iframe');
        frame.title = `Vista previa de ${message.file.name}`;
        frame.className = 'viewer-pdf';
        frame.referrerPolicy = 'no-referrer';
        frame.src = this.objectURL;
        this.viewport.append(frame);
        $('viewer-meta').textContent += ' · Si tu navegador no lo muestra, usa Descargar';
      } else {
        const text = document.createElement('pre');
        text.className = 'viewer-text';
        text.textContent = await blob.text();
        if (!current()) return;
        this.viewport.append(text);
        if (message.file.size > TEXT_PREVIEW_BYTES) $('viewer-meta').textContent += ' · Mostrando los primeros 256 KB';
      }
      if (current()) $('viewer-status').hidden = true;
    } catch (error) {
      if (!current()) return;
      this.model?.dispose();
      this.model = null;
      this.viewport.replaceChildren();
      $('viewer-status').hidden = false;
      $('viewer-status').textContent = error.message || 'No se pudo abrir la vista previa. Puedes descargar el archivo original.';
      if (!['Error', 'RelayError'].includes(error.name)) $('viewer-status').textContent = 'No se pudo interpretar este archivo. Puedes descargar el original.';
    } finally { if (current()) this.viewport.setAttribute('aria-busy', 'false'); }
  }
}
