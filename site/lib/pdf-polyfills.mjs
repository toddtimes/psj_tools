/* Exact fallbacks for built-ins pdf.js 6 calls that some supported browsers don't have yet.
   Map/WeakMap upsert (getOrInsert, getOrInsertComputed) is used when pdf.js merges page resources.
   ReadableStream async iteration (for await ... of stream) is used when pdf.js reads the file's
   bytes; Safari, and so every browser on iOS, has no ReadableStream.prototype.values or
   [Symbol.asyncIterator] as of Safari 26.6, and without this every PDF fails there with
   "undefined is not a function (near '...t of e...')".
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

if (typeof ReadableStream !== 'undefined' && typeof ReadableStream.prototype.values !== 'function') {
  /* The WHATWG Streams async iterator: read until done, then release the reader; an early exit
     cancels the stream unless preventCancel is set. */
  const values = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    let finished = false;
    return {
      async next() {
        if (finished) return { value: undefined, done: true };
        let result;
        try { result = await reader.read(); }
        catch (e) { finished = true; reader.releaseLock(); throw e; }
        if (result.done) { finished = true; reader.releaseLock(); }
        return result;
      },
      async return(value) {
        if (!finished) {
          finished = true;
          if (preventCancel) reader.releaseLock();
          else await reader.cancel(value).finally(() => reader.releaseLock());
        }
        return { value, done: true };
      },
      [Symbol.asyncIterator]() { return this; }
    };
  };
  Object.defineProperty(ReadableStream.prototype, 'values', { configurable: true, writable: true, value: values });
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { configurable: true, writable: true, value: values });
}
