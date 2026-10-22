import { test } from 'bun:test';

test('first', () => {});
// Rejects outside any test: bun prints "# Unhandled error between tests".
Promise.reject(new Error('unhandled between tests fixture'));
test('second', () => {});
