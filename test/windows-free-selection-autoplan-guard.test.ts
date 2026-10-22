import { expect, test } from 'bun:test';
import { curateWindowsSafe } from '../scripts/test-free-shards';

// The /autoplan guard's path folding needs real win32 coverage: these suites
// must stay in the curated windows-free-tests subset (no POSIX-only pattern).
test('the windows-free-tests lane selects the autoplan guard hook and reader suites', () => {
  const files = ['test/autoplan-publication-hook.test.ts', 'test/autoplan-publication-guard.test.ts',
    'test/plan-count-transcript.test.ts', 'test/plan-count-cross-cwd-ancestry.test.ts', 'test/plan-count-session-cwd.test.ts'];
  const { safe, excluded } = curateWindowsSafe(files);
  expect(excluded).toEqual([]);
  expect(safe).toEqual(files);
});
