/**
 * W2 runner equivalence: the free and paid lanes, now on the shared shard
 * engine, classify a fixture corpus (pass, fail, skip, wall-timeout,
 * module-load error, zero executed tests, unhandled error between tests)
 * exactly as the pre-engine runners did. expected.json was recorded by the
 * same recorder against base commit 96764e80; one real suite shard is run
 * too. Re-record only for a deliberate, reviewed lane-policy change.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectFreeTestFiles } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const CORPUS = path.join(ROOT, 'test/fixtures/shard-equivalence');

describe('shard engine runner equivalence (fixture corpus)', () => {
  test('both lanes keep the base runners\' per-file classifications and lane exit codes', () => {
    const run = spawnSync(process.execPath, [path.join(CORPUS, 'record.ts'), ROOT], {
      cwd: ROOT, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, EVALS: '', EVALS_TIER: '', EVALS_ALL: '' },
    });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const line = run.stdout.split('\n').find(entry => entry.startsWith('SHARD_EQUIVALENCE:'));
    expect(line, run.stdout + run.stderr).toBeDefined();
    const actual = JSON.parse(line!.slice('SHARD_EQUIVALENCE:'.length));
    const expected = JSON.parse(fs.readFileSync(path.join(CORPUS, 'expected.json'), 'utf8'));

    expect(actual.free).toEqual(expected.free);
    expect(actual.paid).toEqual(expected.paid);
    // The real shard's test count moves as that file grows; its verdict and
    // complete file accounting must not.
    expect(actual.realShard).toMatchObject(expected.realShard);
    expect(actual.realShard.testsRan).toBeGreaterThan(0);
  }, 120_000);

  test('the corpus covers every outcome kind and stays outside the free census', () => {
    const fixtures = fs.readdirSync(CORPUS).filter(name => name.endsWith('.fixture.ts')).sort();
    expect(fixtures).toEqual([
      'fail.fixture.ts', 'module-load-error.fixture.ts', 'pass.fixture.ts', 'skip.fixture.ts',
      'unhandled-between-tests.fixture.ts', 'wall-timeout.fixture.ts', 'zero-executed.fixture.ts',
    ]);
    const expected = JSON.parse(fs.readFileSync(path.join(CORPUS, 'expected.json'), 'utf8'));
    for (const lane of ['free', 'paid']) {
      expect(Object.keys(expected[lane].fixtures).sort()).toEqual(fixtures.map(name => name.replace('.fixture.ts', '')));
    }
    // A failing fixture inside the census would fail every full free run.
    expect(collectFreeTestFiles(ROOT).filter(file => file.startsWith('test/fixtures/shard-equivalence/'))).toEqual([]);
  });
});
