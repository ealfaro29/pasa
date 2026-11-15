// Keep the latest authenticated archive action for every independent target.
// Server sequence numbers determine order even when history pages arrive late.
export function archiveKey(target) {
  return JSON.stringify([target.id, target.url ?? null]);
}

export class ArchiveState {
  #records = new Map();

  apply(message, seq, envelope) {
    if (message?.kind !== 'archive' || !Number.isSafeInteger(seq) || seq < 0) return false;
    const key = archiveKey(message.target);
    const previous = this.#records.get(key);
    if (previous && previous.seq >= seq) return false;
    this.#records.set(key, { message, seq, envelope });
    return true;
  }

  isMessageArchived(id) {
    return this.#records.get(archiveKey({ id }))?.message.archived === true;
  }

  isArchived(id, url) {
    if (this.isMessageArchived(id)) return true;
    return url !== undefined && this.#records.get(archiveKey({ id, url }))?.message.archived === true;
  }

  entries() {
    // Retain restore actions too: discarding them could revive an older archive
    // action when a previous history page is read after loading this cache.
    return [...this.#records.values()].sort((a, b) => a.seq - b.seq);
  }
}
