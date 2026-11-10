import { test } from 'node:test';
import assert from 'node:assert/strict';

/* Node has the real ReadableStream async iterator; remove it so the fallback installs, then check
   it behaves like the real thing: yields every chunk, releases the reader when done, and cancels
   the stream on an early exit unless preventCancel is set. */
delete ReadableStream.prototype.values;
delete ReadableStream.prototype[Symbol.asyncIterator];
await import('../site/lib/pdf-polyfills.mjs');

function chunks(list, onCancel) {
  return new ReadableStream({
    pull(c) { if (list.length) c.enqueue(list.shift()); else c.close(); },
    cancel(reason) { if (onCancel) onCancel(reason); }
  });
}

test('fallback installs both values() and Symbol.asyncIterator', () => {
  assert.equal(typeof ReadableStream.prototype.values, 'function');
  assert.equal(ReadableStream.prototype[Symbol.asyncIterator], ReadableStream.prototype.values);
});

test('for await yields every chunk in order and releases the lock', async () => {
  const s = chunks(['a', 'b', 'c']), got = [];
  for await (const x of s) got.push(x);
  assert.deepEqual(got, ['a', 'b', 'c']);
  assert.equal(s.locked, false);
});

test('breaking out early cancels the stream', async () => {
  let cancelled = false;
  const s = chunks([1, 2, 3], () => { cancelled = true; });
  for await (const x of s) { if (x === 1) break; }
  assert.equal(cancelled, true);
  assert.equal(s.locked, false);
});

test('preventCancel leaves the stream readable', async () => {
  let cancelled = false;
  const s = chunks([1, 2, 3], () => { cancelled = true; });
  for await (const x of s.values({ preventCancel: true })) { if (x === 1) break; }
  assert.equal(cancelled, false);
  assert.equal(s.locked, false);
  const rest = [];
  for await (const x of s) rest.push(x);
  assert.deepEqual(rest, [2, 3]);
});

test('a read error releases the lock and rejects', async () => {
  const s = new ReadableStream({ pull() { throw new Error('boom'); } });
  await assert.rejects(async () => { for await (const x of s) void x; }, /boom/);
  assert.equal(s.locked, false);
});
