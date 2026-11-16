import { MAX_FILE_BYTES, FILE_CHUNK_BYTES, encryptFileChunk, encryptMessage, startFileUpload, uploadFilePart, completeFileUpload, loadFiles, loadFileDeletions, deleteSharedFile } from './protocol.js?v=3.3.0';
import { previewType, readSharedFile } from './file-content.js?v=3.3.0';
import { FileViewer } from './file-viewer.js?v=3.3.0';

const $ = id => document.getElementById(id);
const formatSize = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toLocaleString('es', { maximumFractionDigits: 1 })} KB` : `${(size / 1024 / 1024).toLocaleString('es', { maximumFractionDigits: 1 })} MB`;

export class FileShelf {
  constructor({ device, icon, toast, onEvent }) {
    Object.assign(this, { device, icon, toast, onEvent });
    this.files = new Map();
    this.tasks = [];
    this.downloading = new Set();
    this.downloadControllers = new Map();
    this.deleted = new Set();
    this.deleting = new Set();
    this.deletionsReady = false;
    this.deletionCursor = 0;
    this.before = null;
    this.hasMore = false;
    this.loading = false;
    this.catalogLoaded = false;
    this.uploading = false;
    this.viewer = new FileViewer({ read: (message, options) => readSharedFile(this.room, message, options), download: message => this.download(message) });
    this.deleteDialog = $('delete-file-dialog');
    $('cancel-file-delete').addEventListener('click', () => this.deleteDialog.close());
    $('confirm-file-delete').addEventListener('click', () => this.confirmDelete());
    this.deleteDialog.addEventListener('close', () => { this.deleteTarget = null; this.deleteEnvelope = null; });
    this.deleteDialog.addEventListener('cancel', event => { if (this.deleting.size) event.preventDefault(); });
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
    if (this.deleted.has(message.id)) return false;
    this.files.set(message.id, message);
    this.render();
    return true;
  }

  remove(id) {
    this.deleted.add(id);
    this.files.delete(id);
    this.downloadControllers.get(id)?.abort();
    if (this.viewer.message?.id === id) {
      this.viewer.clear();
      this.viewer.dialog.close();
    }
    if (this.deleteTarget?.id === id && this.deleteDialog.open) this.deleteDialog.close();
    this.render();
  }

  syncDeletions() {
    if (!this.room) return Promise.resolve();
    if (this.syncingDeletions) return this.syncingDeletions;
    this.deletionsReady = false;
    this.render();
    this.syncingDeletions = (async () => {
      while (true) {
        const page = await loadFileDeletions(this.room.topic, { after: this.deletionCursor, limit: 50 });
        for (const event of page.messages) await this.onEvent(event);
        if (page.nextAfter > this.deletionCursor) this.deletionCursor = page.nextAfter;
        else if (page.hasMore) throw new Error('No se pudo sincronizar la lista de archivos. Reintenta.');
        if (!page.hasMore) break;
      }
      this.deletionsReady = true;
    })().finally(() => { this.syncingDeletions = null; this.render(); });
    return this.syncingDeletions;
  }

  async refreshDeletions() {
    try {
      await this.syncDeletions();
      if ((!this.catalogLoaded || this.loadFailed) && !this.loading) await this.load(true, false);
      else if (!this.loadFailed) $('files-error').hidden = true;
    }
    catch (error) {
      this.loadFailed = true;
      $('files-error').textContent = error.message || 'No se pudo sincronizar la lista de archivos.';
      $('files-error').hidden = false;
      this.render();
    }
  }

  requestDelete(message) {
    if (!this.room || !this.deletionsReady || this.deleted.has(message.id) || this.deleting.size) return;
    this.deleteTarget = message;
    this.deleteEnvelope = null;
    $('delete-file-name').textContent = message.file.name;
    $('delete-file-error').textContent = '';
    $('confirm-file-delete').textContent = 'Eliminar definitivamente';
    $('confirm-file-delete').disabled = false;
    $('cancel-file-delete').disabled = false;
    this.deleteDialog.showModal();
    $('cancel-file-delete').focus();
  }

  async confirmDelete() {
    const message = this.deleteTarget;
    if (!this.room || !message || this.deleting.has(message.id)) return;
    this.deleting.add(message.id);
    $('confirm-file-delete').disabled = true;
    $('confirm-file-delete').textContent = 'Eliminando…';
    $('cancel-file-delete').disabled = true;
    $('delete-file-error').textContent = '';
    this.render();
    try {
      this.deleteEnvelope ||= await encryptMessage(this.room.key, { v: 1, kind: 'file-delete', id: crypto.randomUUID(), device: this.device,
        text: '', created: Date.now(), target: { id: message.id } });
      const event = await deleteSharedFile(this.room.topic, message.id, this.deleteEnvelope);
      await this.onEvent(event);
      if (!this.deleted.has(message.id)) throw new Error('No se pudo confirmar la eliminación. Reintenta.');
      if (this.deleteDialog.open && this.deleteTarget?.id === message.id) this.deleteDialog.close();
      this.toast('Archivo eliminado del espacio compartido.');
    } catch (error) {
      if (this.deleted.has(message.id)) this.toast('Archivo eliminado del espacio compartido.');
      else if (this.deleteTarget?.id === message.id && this.deleteDialog.open) {
        $('delete-file-error').textContent = error.message || 'No se pudo eliminar el archivo. Inténtalo de nuevo.';
      }
    } finally {
      this.deleting.delete(message.id);
      $('confirm-file-delete').disabled = false;
      $('confirm-file-delete').textContent = 'Eliminar definitivamente';
      $('cancel-file-delete').disabled = false;
      this.render();
    }
  }

  async load(reset = false, verifyDeletions = true) {
    if (!this.room || this.loading) return;
    this.loading = true;
    $('files-error').hidden = true;
    this.render();
    try {
      if (verifyDeletions) await this.syncDeletions();
      const page = await loadFiles(this.room.topic, reset || !this.before ? { limit: 30 } : { before: this.before, limit: 30 });
      for (const event of page.messages) await this.onEvent(event);
      this.before = page.nextBefore;
      this.hasMore = page.hasMore;
      this.loadFailed = false;
      this.catalogLoaded = true;
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
    if (!this.room || !this.deletionsReady || this.deleted.has(message.id) || this.downloading.has(message.id)) return;
    const controller = new AbortController();
    this.downloadControllers.set(message.id, controller);
    this.downloading.add(message.id);
    this.render();
    try {
      const blob = this.viewer.message?.id === message.id && this.viewer.blob?.size === message.file.size
        ? this.viewer.blob : await readSharedFile(this.room, message, { signal: controller.signal });
      if (this.deleted.has(message.id) || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = message.file.name.replace(/[/\\\u0000-\u001f\u007f]/g, '_');
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      if (!this.deleted.has(message.id)) this.toast(error.message || 'No se pudo descargar el archivo.', 6000);
      if (error.status === 410) this.refreshDeletions();
    }
    finally { this.downloading.delete(message.id); this.downloadControllers.delete(message.id); this.render(); }
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
    const visibleFiles = this.deletionsReady ? [...this.files.values()].filter(message => !this.deleted.has(message.id)).sort((a, b) => b.created - a.created) : [];
    for (const message of visibleFiles) {
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
      button.disabled = !this.room || this.deleting.has(message.id) || this.downloading.has(message.id);
      button.append(this.icon('download'), document.createTextNode(this.downloading.has(message.id) ? 'Descargando…' : 'Descargar'));
      button.setAttribute('aria-label', `Descargar ${message.file.name}`);
      button.addEventListener('click', () => this.download(message));
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const type = previewType(message.file);
      if (type) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'copy-message preview-file';
        preview.disabled = !this.room || this.deleting.has(message.id);
        preview.append(this.icon(type.kind === 'model' ? 'cube' : 'eye'), document.createTextNode(type.kind === 'model' ? 'Ver 3D' : 'Ver'));
        preview.setAttribute('aria-label', `Ver ${message.file.name}`);
        preview.addEventListener('click', () => { if (!this.deleted.has(message.id)) this.viewer.open(message); });
        actions.append(preview);
      }
      actions.append(button);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'copy-message delete-file';
      remove.disabled = !this.room || this.deleting.has(message.id);
      remove.append(this.icon('trash'), document.createTextNode(this.deleting.has(message.id) ? 'Eliminando…' : 'Eliminar'));
      remove.setAttribute('aria-label', `Eliminar ${message.file.name}`);
      remove.addEventListener('click', () => this.requestDelete(message));
      actions.append(remove);
      row.append(this.icon('file'), info, actions);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    $('files-count').textContent = visibleFiles.length;
    $('files-empty').hidden = Boolean(visibleFiles.length || this.tasks.length || this.loading || this.loadFailed || !this.deletionsReady);
    $('files-status').textContent = this.uploading ? 'Subiendo archivos. Mantén esta página abierta.' : this.loading || this.syncingDeletions ? 'Cargando archivos…' : '';
    const more = $('load-files');
    more.hidden = !this.hasMore && !this.loadFailed;
    more.disabled = this.loading;
    more.textContent = this.loadFailed ? 'Reintentar carga' : this.loading ? 'Cargando…' : 'Cargar más archivos';
  }
}
