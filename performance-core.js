// Private session-only optimizations. No localStorage/IndexedDB message persistence.
export const SEARCH_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

export class SearchPageCache {
  constructor({ maxBytes = SEARCH_CACHE_MAX_BYTES, ttlMs = SEARCH_CACHE_TTL_MS, now = Date.now } = {}) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
    this.generation = 0;
  }
  clear() { this.entries.clear(); this.bytes = 0; this.generation += 1; }
  remove(cursor) {
    const key = cursor || '';
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  get(cursor) {
    const key = cursor || '';
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.at >= this.ttlMs) { this.remove(cursor); return null; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.rows;
  }
  set(cursor, rows, pageSize) {
    const bytes = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    this.remove(cursor);
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes && this.entries.size) this.remove(this.entries.keys().next().value);
    this.entries.set(cursor || '', { rows, bytes, at:this.now(), low:rows[0]?.key || '', complete:rows.length < pageSize, cursor:cursor || null });
    this.bytes += bytes;
  }
  invalidate(messageKey) {
    this.generation += 1;
    if (!messageKey) { this.clear(); return; }
    for (const [cursor, entry] of this.entries) {
      // A page covers everything below its cursor down to its oldest key.
      // A final (short/empty) page also covers future backdated inserts.
      if ((!entry.cursor || messageKey < entry.cursor) && (entry.complete || !entry.low || messageKey >= entry.low)) this.remove(cursor);
    }
  }
}

export function albumTileSignature(item) {
  // Favorites are patched independently, and gallery click handlers use current data.
  return JSON.stringify([item.type, item.url, item.thumbnail || '', item.thumbnailUrl || '', item.durationMs || 0, item.messageKey || '', item.ts || 0]);
}
