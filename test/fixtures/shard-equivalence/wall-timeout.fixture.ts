import { test } from 'bun:test';

// Blocks the main thread, so no in-process timer can end it: only the
// runner's external wall-clock group kill can.
test('blocks past the wall deadline', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
