/**
 * pregate check `timing` (field list 2 W4): added or changed test lines
 * that compare an elapsed wall-clock or CPU time against a bound, or sleep
 * and then assert, print TIMING_ASSERTION lines and warn; a
 * `gstack-timing-ok: <reason>` comment on the line or the line above
 * escapes one. The fixture sources mark each line HIT, CLEAN, ESCAPED or
 * UNREASONED with the expected pattern; they are .txt so this repo's own
 * pregate never reads them as tests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { scanTiming, scansTiming, timingCheck, type TimingHit } from '../lib/pregate/checks/timing';
import { CHECK_IDS, runPregate } from '../lib/pregate/index';
import { buildContext } from '../lib/pregate/context';
import { validateConfig } from '../lib/pregate/config';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'pregate-timing');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** Expected outcomes from the fixture's own markers: line → [marker, pattern]. */
function markers(text: string): Map<number, [string, string | undefined]> {
  const out = new Map<number, [string, string | undefined]>();
  text.split('\n').forEach((l, i) => { const m = /(?:\/\/|#) (HIT|CLEAN|ESCAPED|UNREASONED)(?: ([a-z-]+))?\s*$/.exec(l); if (m) out.set(i + 1, [m[1]!, m[2]]); });
  return out;
}

function outcome(h: TimingHit | undefined): string {
  if (!h) return 'CLEAN';
  if (!h.escape) return 'HIT ' + h.pattern;
  return ('reason' in h.escape ? 'ESCAPED ' : 'UNREASONED ') + h.pattern;
}

describe('timing detector over marked fixtures', () => {
  for (const [file, as] of [['flaky.test.ts.txt', 'test/flaky.test.ts'], ['test_flaky.py.txt', 'tests/test_flaky.py']] as const) {
    test(`${file}: every marked line gets its marked outcome and no unmarked line is flagged`, () => {
      const text = read(file);
      const hits = scanTiming(as, text, 'all');
      const byLine = new Map(hits.map(h => [h.line, h]));
      const expected = markers(text);
      expect(expected.size).toBeGreaterThanOrEqual(5);
      for (const [line, [marker, pattern]] of expected) expect(`${line}: ${outcome(byLine.get(line))}`).toBe(`${line}: ${pattern ? `${marker} ${pattern}` : marker}`);
      expect(hits.filter(h => !expected.has(h.line)).map(h => `${h.line} ${h.pattern}`)).toEqual([]);
    });
  }

  test('only added lines count: an unchanged bound is not reported, a changed one is', () => {
    const text = read('flaky.test.ts.txt');
    const line = text.split('\n').findIndex(l => l.includes('toBeLessThan(400)')) + 1;
    expect(scanTiming('test/flaky.test.ts', text, new Set([1, 2, 3]))).toEqual([]);
    expect(scanTiming('test/flaky.test.ts', text, new Set([line])).map(h => [h.line, h.pattern])).toEqual([[line, 'wall-time-bound']]);
  });

  test('a sleep-then-assert pair is reported when only its assertion changed', () => {
    const text = read('flaky.test.ts.txt');
    const lines = text.split('\n');
    const sleep = lines.findIndex(l => l.includes('await Bun.sleep(50)')) + 1;
    expect(scanTiming('test/flaky.test.ts', text, new Set([sleep + 1])).map(h => [h.line, h.pattern])).toEqual([[sleep, 'sleep-then-assert']]);
  });

  test('scope: test code only, never fixtures or product code', () => {
    expect(scansTiming('test/x.test.ts')).toBe(true);
    expect(scansTiming('test/helpers/poll.ts')).toBe(true);
    expect(scansTiming('tests/test_x.py')).toBe(true);
    expect(scansTiming('src/x.spec.js')).toBe(true);
    expect(scansTiming('lib/retry.ts')).toBe(false);
    expect(scansTiming('test/fixtures/pregate-timing/flaky.test.ts.txt')).toBe(false);
    expect(scansTiming('test/fixtures/sample.test.ts')).toBe(false);
    expect(scansTiming('docs/timing.md')).toBe(false);
  });
});

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const pregate = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'preflight', '--only', 'timing', ...args]);

describe('gstack-pregate --only timing (real subprocess, fixture repo)', () => {
  test('a branch adding a wall-clock bound warns with TIMING_ASSERTION file:line and still exits ok; the escape clears it', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const body = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('fast', () => {\n  const t0 = Date.now();\n  require('../lib/util.js').add(1, 2);\n  assert.ok(Date.now() - t0 < 400);\n});\n";
    commit(repo, { 'test/speed.test.js': body });
    const r = pregate(repo, []);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^preflight {2}timing {4}warn .*1 timing-dependent assertion\(s\) in added test lines \(1 wall-time-bound\) \(PREGATE_TIMING_ASSERTION\)/m);
    expect(r.out).toContain('timing: TIMING_ASSERTION: test/speed.test.js:6 wall-time-bound');
    expect(r.out).toContain('timing: TIMING_ASSERTIONS: found=1 escaped=0 files=1');
    expect(r.out).toMatch(/^PREGATE: warn /m);
    commit(repo, { 'test/speed.test.js': body.replace('  assert.ok(', '  // gstack-timing-ok: a hang check with 100x headroom\n  assert.ok(') });
    const ok = pregate(repo, ['--explain']);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(/^preflight {2}timing {4}pass .*1 escaped with gstack-timing-ok/m);
    expect(ok.out + ok.err).toContain('timing: test/speed.test.js:7 wall-time-bound escaped: a hang check with 100x headroom');
  });

  test('an escape without a reason is still reported, and an untouched existing bound is not', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    repo.git('checkout', '-q', 'main');
    write(repo.work, 'test/old.test.js', "const assert = require('node:assert');\nconst t0 = Date.now();\nassert.ok(Date.now() - t0 < 400);\n");
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'old bound'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature'); repo.git('merge', '-q', '--ff-only', 'main');
    commit(repo, { 'test/old.test.js': "const assert = require('node:assert');\nconst t0 = Date.now();\nassert.ok(Date.now() - t0 < 400);\nassert.ok(true);\n", 'test/new.test.js': "const t0 = Date.now();\n// gstack-timing-ok:\nexpect(Date.now() - t0).toBeLessThan(400);\n" });
    const r = pregate(repo, []);
    expect(r.out).toContain('timing: TIMING_ASSERTION: test/new.test.js:3 wall-time-bound (gstack-timing-ok needs a reason)');
    expect(r.out).not.toContain('test/old.test.js:3');
    expect(r.out).toContain('TIMING_ASSERTIONS: found=1 escaped=0 files=2');
  });

  test('diff configuration cannot hide added lines: an external driver, a textconv or noprefix still gets the hit', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'test/speed.test.js': "const t0 = Date.now();\nexpect(Date.now() - t0).toBeLessThan(400);\n" });
    fs.writeFileSync(path.join(repo.work, '.git', 'info', 'attributes'), '*.js diff=hide\n');
    for (const [key, value] of [['diff.external', '/bin/true'], ['diff.hide.textconv', 'true'], ['diff.noprefix', 'true']] as const) {
      repo.git('config', key, value);
      const r = pregate(repo, []);
      expect(r.out).toContain('timing: TIMING_ASSERTION: test/speed.test.js:2 wall-time-bound');
      expect(r.out).toContain('TIMING_ASSERTIONS: found=1 escaped=0 files=1');
      repo.git('config', '--unset', key);
    }
  });

  test('a diff that cannot be read is incomplete, never a pass, even when timing is downgraded to warn', async () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'test/speed.test.js': "const t0 = Date.now();\nexpect(Date.now() - t0).toBeLessThan(400);\n" });
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, progress: () => {} });
    if (!('ctx' in loaded)) throw new Error('fixture context refused');
    const ctx = { ...loaded.ctx, mergeBase: '0'.repeat(40), config: { ...loaded.ctx.config, warn: ['timing'] } };
    const direct = await timingCheck.run(ctx);
    expect(direct).toMatchObject({ id: 'timing', status: 'incomplete', code: 'PREGATE_INCOMPLETE' });
    expect(direct.detail).toMatch(/^git diff exited 128: .*; the added test lines were not read$/);
    const file = await runPregate(ctx, { stage: 'preflight', only: ['timing'] });
    expect(file.checks.find(c => c.id === 'timing')!.status).toBe('incomplete');
  });

  test('a docs-only branch passes and timing is a known, downgradable check id', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'docs/README.md': '# docs\nmore\n' });
    const r = pregate(repo, []);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^preflight {2}timing {4}pass .*no timing assertion in the added lines of 0 test file\(s\)/m);
    expect(CHECK_IDS).toContain('timing');
    expect(validateConfig({ ...BASE_PREGATE, warn: ['timing'] }, CHECK_IDS)).toEqual([]);
  });
});
