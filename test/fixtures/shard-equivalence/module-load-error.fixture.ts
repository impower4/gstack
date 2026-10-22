import { test } from 'bun:test';

throw new Error('module load failure fixture');

test('never registered', () => {});
