import { MAX_FILE_BYTES, FILE_CHUNK_BYTES, encryptFileChunk, decryptFileChunk, decryptFile, encryptMessage, startFileUpload, uploadFilePart, completeFileUpload, downloadFilePart, downloadFile, loadFiles } from './protocol.js?v=3.1.0';

const $ = id => document.getElementById(id);
const formatSize = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toLocaleString('es', { maximumFractionDigits: 1 })} KB` : `${(size / 1024 / 1024).toLocaleString('es', { maximumFractionDigits: 1 })} MB`;

export class FileShelf {
  constructor({ device, icon, toast, onEvent }) {
    Object.assign(this, { device, icon, toast, onEvent });
    this.files = new Map();
    this.tasks = [];
    this.downloading = new Set();
    this.before = null;
    this.hasMore = false;
    this.loading = false;
    this.uploading = false;
    $('choose-files').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', () => {
      this.addFiles([...$('file-input').files]);
      $('file-input').value = '';
    });
    $('load-files').addEventListener('click', () => this.load());
    const drop = $('file-drop');
    drop.addEventListener('dragover', event => {
      event.preventDefault();
      if (this.room) drop.classList.add('is-dragging');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
    drop.addEventListener('drop', event => {
      event.preventDefault();
      drop.classList.remove('is-dragging');
      if (this.room) this.addFiles([...event.dataTransfer.files]);
    });
  }

  connect(room) {
    this.room = room;
    $('choose-files').disabled = false;
    return this.load(true);
  }

  accept(message) {
    this.files.set(message.id, message);
    this.render();
  }

  async load(reset = false) {
    if (!this.room || this.loading) return;
    this.loading = true;
    $('files-error').hidden = true;
    this.render();
    try {
      const page = await loadFiles(this.room.topic, reset || !this.before ? { limit: 30 } : { before: this.before, limit: 30 });
      for (const event of page.messages) await this.onEvent(event);
      this.before = page.nextBefore;
      this.hasMore = page.hasMore;
      this.loadFailed = false;
    } catch (error) {
      this.loadFailed = true;
      $('files-error').textContent = error.message || 'No se pudieron cargar los archivos.';
      $('files-error').hidden = false;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  addFiles(files) {
    if (!this.room || !files.length) return;
    // Queue only File handles. Encrypt one file at a time to bound memory use.
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { this.toast(`${file.name}: el máximo es 250 MB por archivo.`, 6000); continue; }
      if (this.tasks.length >= 20) { this.toast('Sube estos archivos antes de añadir más.'); break; }
      this.tasks.push({ id: crypto.randomUUID(), file, state: 'pending' });
    }
    this.pump();
  }

  async pump() {
    if (this.uploading) return;
    this.uploading = true;
    try {
      for (const task of this.tasks) {
        if (task.state !== 'pending') continue;
        if (!navigator.onLine) {
          task.state = 'failed';
          task.error = 'Sin conexión. Reintenta cuando vuelvas a estar en línea.';
          continue;
        }
        task.state = 'uploading';
        this.render();
        try {
          if (!task.envelope) {
            let name = task.file.name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255).trim();
            if (!name || ['.', '..'].includes(name)) name = 'archivo';
            task.chunks = Math.max(1, Math.ceil(task.file.size / FILE_CHUNK_BYTES));
            const message = { v: 1, kind: 'file', id: task.id, device: this.device, text: '', created: Date.now(),
              file: { id: task.id, name, type: task.file.type.slice(0, 255), size: task.file.size,
                format: 'chunks-v1', chunkSize: FILE_CHUNK_BYTES, chunks: task.chunks } };
            task.envelope = await encryptMessage(this.room.key, message);
          }
          const session = await startFileUpload(this.room.topic, task.id, task.envelope, task.chunks, task.file.size + task.chunks * 28);
          if (!session.event) {
            const uploaded = new Set(session.uploaded);
            for (let index = 0; index < task.chunks; index++) {
              if (uploaded.has(index)) continue;
              // At most one encrypted chunk stays in memory between retries.
              if (task.partIndex !== index || !task.partBytes) {
                task.partBytes = await encryptFileChunk(this.room.key, task.id, index,
                  await task.file.slice(index * FILE_CHUNK_BYTES, Math.min(task.file.size, (index + 1) * FILE_CHUNK_BYTES)).arrayBuffer());
                task.partIndex = index;
              }
              await uploadFilePart(this.room.topic, task.id, index, task.partBytes);
              task.partBytes = null;
              task.progress = Math.round((index + 1) / task.chunks * 100);
              this.render();
            }
          }
          const event = session.event || await completeFileUpload(this.room.topic, task.id);
          await this.onEvent(event);
          task.state = 'done';
          task.partBytes = null;
          this.toast(`${task.file.name} ya está disponible para descargar.`);
        } catch (error) {
          if (this.files.has(task.id)) { task.state = 'done'; task.partBytes = null; }
          else {
            task.state = 'failed';
            task.error = error.message || 'No se pudo subir el archivo.';
            if (error.retryable) {
              for (const next of this.tasks) if (next.state === 'pending') {
                next.state = 'failed';
                next.error = 'La subida se detuvo por la conexión. Pulsa Reintentar.';
              }
            }
          }
        }
        this.render();
      }
      this.tasks = this.tasks.filter(task => task.state !== 'done');
    } finally {
      this.uploading = false;
      this.render();
      if (this.tasks.some(task => task.state === 'pending')) this.pump();
    }
  }

  async download(message) {
    if (!this.room || this.downloading.has(message.id)) return;
    this.downloading.add(message.id);
    this.render();
    try {
      const parts = [];
      if (message.file.format === 'chunks-v1') {
        for (let index = 0; index < message.file.chunks; index++) {
          const encrypted = await downloadFilePart(this.room.topic, message.file.id, index);
          const expected = Math.min(FILE_CHUNK_BYTES, message.file.size - index * FILE_CHUNK_BYTES);
          parts.push(new Blob([await decryptFileChunk(this.room.key, message.file.id, index, encrypted, expected)]));
        }
      } else {
        const encrypted = await downloadFile(this.room.topic, message.file.id);
        parts.push(new Blob([await decryptFile(this.room.key, message.file.id, encrypted, message.file.size)]));
      }
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = message.file.name.replace(/[/\\\u0000-\u001f\u007f]/g, '_');
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { this.toast(error.message || 'No se pudo descargar el archivo.', 6000); }
    finally { this.downloading.delete(message.id); this.render(); }
  }

  render() {
    const list = $('files-list');
    const fragment = document.createDocumentFragment();
    for (const task of this.tasks.filter(value => value.state !== 'done')) {
      const row = document.createElement('li');
      row.className = `file-row file-task${task.state === 'failed' ? ' file-failed' : ''}`;
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = task.file.name;
      const detail = document.createElement('span');
      detail.textContent = task.state === 'failed' ? task.error : task.state === 'uploading' ? `Cifrando y subiendo… ${task.progress || 0}%` : 'En espera…';
      info.append(name, detail);
      row.append(this.icon('file'), info);
      if (task.state === 'failed') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'copy-message';
        retry.textContent = 'Reintentar';
        retry.addEventListener('click', () => { task.state = 'pending'; this.pump(); });
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'text-button';
        dismiss.textContent = 'Quitar';
        dismiss.addEventListener('click', () => { this.tasks = this.tasks.filter(value => value !== task); this.render(); });
        row.append(retry, dismiss);
      }
      fragment.append(row);
    }
    for (const message of [...this.files.values()].sort((a, b) => b.created - a.created)) {
      const row = document.createElement('li');
      row.className = 'file-row';
      row.dataset.fileId = message.id;
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = message.file.name;
      const detail = document.createElement('span');
      const date = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(message.created);
      detail.textContent = `${formatSize(message.file.size)} · ${message.device === this.device ? 'Tú' : 'Otro equipo'} · ${date}`;
      info.append(name, detail);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-message download-file';
      button.disabled = !this.room || this.downloading.has(message.id);
      button.append(this.icon('download'), document.createTextNode(button.disabled ? 'Descargando…' : 'Descargar'));
      button.setAttribute('aria-label', `Descargar ${message.file.name}`);
      button.addEventListener('click', () => this.download(message));
      row.append(this.icon('file'), info, button);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    $('files-count').textContent = this.files.size;
    $('files-empty').hidden = Boolean(this.files.size || this.tasks.length || this.loading || this.loadFailed);
    $('files-status').textContent = this.uploading ? 'Subiendo archivos. Mantén esta página abierta.' : this.loading ? 'Cargando archivos…' : '';
    const more = $('load-files');
    more.hidden = !this.hasMore && !this.loadFailed;
    more.disabled = this.loading;
    more.textContent = this.loadFailed ? 'Reintentar carga' : this.loading ? 'Cargando…' : 'Cargar más archivos';
  }
}
