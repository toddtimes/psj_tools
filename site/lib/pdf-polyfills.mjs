/* Exact fallbacks for built-ins pdf.js 6 calls that some supported browsers don't have yet.
   Map/WeakMap upsert (getOrInsert, getOrInsertComputed) is used when pdf.js merges page resources.
   Imported first by pdf-worker.mjs; lib/pdf-reader.js applies the same fallbacks on the page. */
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsert) {
    Object.defineProperty(C.prototype, 'getOrInsert', {
      configurable: true, writable: true,
      value(key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); }
    });
  }
  if (!C.prototype.getOrInsertComputed) {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', {
      configurable: true, writable: true,
      value(key, callback) { if (!this.has(key)) this.set(key, callback(key)); return this.get(key); }
    });
  }
}
