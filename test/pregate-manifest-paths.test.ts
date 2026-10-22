/**
 * Item 8 (manifest-parser half of #3176): a lane's selection manifest prints
 * framework route paths (`app/(shop)/[id]/page.test.ts`, `@modal`, `$id`)
 * and the parser keeps them whole. Cutting them down to `page.test.ts`
 * dropped the test from its platform lane, so its remote receipt obligation
 * vanished and the test ran locally instead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { manifestTestPaths } from '../lib/pregate/lane-selection';
import { runScriptSync } from '../lib/script-invocation';
import { BASE_PREGATE, BIN, cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('manifestTestPaths', () => {
  test('framework route segments stay intact', () => {
    const out = [
      'app/(shop)/[id]/page.test.ts',
      'app/@modal/(.)photo/[...slug]/page.spec.tsx',
      'app/routes/$userId/route.test.ts',
      'src/routes/[[lang]]/+page.test.ts',
      '  test/plain.test.ts  ',
    ].join('\n');
    expect(manifestTestPaths(out)).toEqual([
      'app/(shop)/[id]/page.test.ts',
      'app/@modal/(.)photo/[...slug]/page.spec.tsx',
      'app/routes/$userId/route.test.ts',
      'src/routes/[[lang]]/+page.test.ts',
      'test/plain.test.ts',
    ]);
  });

  test('paths inside JSON, quotes, listings and grep-style lines are found; prose is not', () => {
    const out = [
      'Discovered 12 test files.',
      '["app/(shop)/[id]/a.test.ts", "test/b.test.ts"]',
      '  ./test/c.test.ts:12',
      '(test/d.test.ts)',
      'shard 2: tests/test_e.py',
      'app/(group)/f.test.ts,',
    ].join('\n');
    expect(manifestTestPaths(out)).toEqual(['app/(shop)/[id]/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'tests/test_e.py', 'app/(group)/f.test.ts']);
  });

  test('the test-file rule is the import graph\'s own (one definition of a test file)', () => {
    expect(manifestTestPaths('pkg/x_test.go\nlib/y_spec.rb\nlib/not-a-test.ts')).toEqual(['pkg/x_test.go', 'lib/y_spec.rb']);
  });
});

describe('lanes: a bracketed route test in a platform-only lane keeps its remote receipt obligation', () => {
  test('the manifest path selects the Windows lane, not a local run', () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const route = 'app/(shop)/[id]/page.test.js';
    commit(repo, {
      'scripts/windows-list.js': `console.log('test/windows-paths.test.js');\nconsole.log(${JSON.stringify(route)});\n`,
    });
    repo.git('push', '-q', 'origin', 'feature:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { [route]: "const test = require('node:test');\ntest('route', () => {});\n" });
    const run = runScriptSync(BIN('gstack-pregate'), ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain'],
      { cwd: repo.work, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...repo.env } });
    const r = { out: run.stdout ?? '', err: `${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}` };
    expect(r.out, r.err).toContain('lane windows.yml/windows-shard: 2 files from manifest `node scripts/windows-list.js`');
    const host = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const owed = [
      { lane: 'free-tests.yml/unit', platform: 'linux', workflow: 'free-tests.yml', job: 'unit', tests: [route], receipt: null },
      { lane: 'windows.yml/windows-shard', platform: 'windows', workflow: 'windows.yml', job: 'windows-shard', tests: [route], receipt: null },
    ].filter((o) => o.platform !== host);
    const out = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
    expect(out.requires_remote).toEqual(owed);
    for (const o of owed) expect(r.out).toContain(`requires-remote ${o.lane} (${o.platform}): 1 test(s) — ${route}`);
    if (host === 'windows') expect(r.out, r.err).toContain(`ran: node --test '${route}'`);
    expect(BASE_PREGATE.selection['windows.yml/windows-shard']).toBe('node scripts/windows-list.js');
  });
});
