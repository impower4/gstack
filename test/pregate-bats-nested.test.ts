/**
 * Pregate recognises .bats tests (#3161). The first block is #3177's own
 * tests by @harjothkhara, moved here verbatim from
 * test/pregate-selection.test.ts so that file stays untouched; the second is
 * the reviewer test: a .bats file in a nested directory is selected and run
 * end to end through bin/gstack-pregate, both when it is touched itself (no
 * declaration) and through a declared dependency, and a failing nested bats
 * run is a lane failure with the bats counts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { parseSummary } from '../lib/pregate/checks/lanes';
import { buildGraph, isTestFile, testsFor } from '../lib/pregate/import-graph';
import { laneFileSet } from '../lib/pregate/lane-selection';
import { parseWorkflow } from '../lib/pregate/workflows';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const check = (repo: FixtureRepo, id: string) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === id);

describe('bats tests (#3161)', () => {
  const bats = (run: string) => parseWorkflow('b.yml', `jobs:\n  t:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${run}\n`, 'linux')[0]!;

  test('isTestFile and testsFor recognise .bats, and only a terminal .bats', () => {
    for (const f of ['tests/foo.bats', 'test/a/b.bats', 'foo.bats']) expect(isTestFile(f)).toBe(true);
    for (const f of ['tests/foo.bats.md', 'x.bats.sh', 'batsfile', 'tests/foo.bats.xml']) expect(isTestFile(f)).toBe(false);
    const repo = fixture({ baseFiles: { 'scripts/foo.sh': '#!/bin/sh\ntrue\n', 'tests/foo.bats': '@test "x" { true; }\n' } });
    const g = buildGraph(repo.work, { declarations: { 'scripts/**': ['tests/foo.bats'] } });
    expect(testsFor(g, 'scripts/foo.sh').tests).toEqual(['tests/foo.bats']);
  });

  test('a selection manifest printing .bats paths yields them; .bats.md and .bats.xml are not taken', () => {
    const ctx: any = { config: { selection: { 'b.yml/t': "printf 'tests/foo.bats\\ntests/x/bar.bats\\ntests/foo.bats.md\\ntests/foo.bats.xml\\ntests/foo.test.js.bats\\ntests/foo.spec.ts.bats\\n'" } }, allowRepoCommands: true, repoRoot: os.tmpdir(), timeoutMs: 30_000, env: process.env, explain: [] };
    expect((laneFileSet(ctx, bats('bats tests/')) as string[]).sort()).toEqual(['tests/foo.bats', 'tests/foo.spec.ts.bats', 'tests/foo.test.js.bats', 'tests/x/bar.bats']);
  });

  test('parseSummary reads the bats TAP plan and the pretty summary', () => {
    expect(parseSummary('1..1\nok 1 x')).toEqual({ ran: 1, failed: 0 });
    expect(parseSummary('1..0')).toEqual({ ran: 0, failed: 0 });
    expect(parseSummary('1..2\nok 1 a\nnot ok 2 b')).toEqual({ ran: 2, failed: 1 });
    expect(parseSummary('3 tests, 1 failure')).toEqual({ ran: 3, failed: 1 });
    expect(parseSummary('1 test, 0 failures')).toEqual({ ran: 1, failed: 0 });
    // A bats-looking line inside output that ends with another runner's summary must not mask it.
    expect(parseSummary('1..0\n===== 1 passed in 0.1s =====')).toEqual({ ran: 1, failed: 0 });
    expect(parseSummary('0 tests, 0 failures\n===== 1 passed in 0.1s =====')).toEqual({ ran: 1, failed: 0 });
    expect(parseSummary('1..0\n===== 1 passed in 0.1s =====', 'pytest {files}')).toEqual({ ran: 1, failed: 0 });
    // With a bats runner the bats summary wins over stray words from test output.
    for (const runner of ['bats {files}', 'CI=1 bats {files}', './node_modules/.bin/bats {files}']) {
      expect(parseSummary('1..1\n# No tests found\nok 1 works', runner)).toEqual({ ran: 1, failed: 0 });
      expect(parseSummary('1..0\n# 1 passed', runner)).toEqual({ ran: 0, failed: 0 });
    }
    for (const runner of ['npx bats {files}', 'pnpm exec bats {files}', 'bats {files}', 'CI=1 bats {files}', './node_modules/.bin/bats {files}', 'make bats']) expect(parseSummary('1..1\nok 1 No tests found', runner)).toEqual({ ran: 1, failed: 0 });
    // Runners that merely contain the letters keep the generic behaviour.
    for (const runner of ['bats-core {files}', 'node scripts/run-bats.js {files}', 'pytest {files}']) expect(parseSummary('1..1\nok 1 No tests found', runner)).toEqual({ ran: 0, failed: 0 });
  });

  test('end to end: a declared dependency selects the .bats file and runs it with the bats runner; a runner reporting 0 tests is ZERO-RUN', () => {
    const repo = fixture({
      pregate: { ...BASE_PREGATE, runner: 'bats {files}', dependencies: { ...BASE_PREGATE.dependencies, 'scripts/**': ['tests/foo.bats'] } },
      baseFiles: {
        'tests/foo.bats': '@test "x" { true; }\n',
        'scripts/foo.sh': '#!/bin/sh\ntrue\n',
      },
    });
    commit(repo, { 'scripts/foo.sh': '#!/bin/sh\n# touched\ntrue\n' });
    expect(repo.git('diff', '--name-only', 'main...HEAD')).toBe('scripts/foo.sh');
    const stub = (tap: string) => { const dir = path.join(repo.root, 'bin-stub'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'bats'), `#!/bin/sh\nprintf '%s\\n' '${tap}'\n`, { mode: 0o755 }); return { PATH: `${dir}:${process.env.PATH ?? ''}` }; };
    const ok = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain'], stub('1..1\nok 1 x'));
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.err).not.toContain('PREGATE_NO_LANE');
    // The fixture's own Linux lane is remote on a non-Linux host, so the verdict may be requires-remote; the selected file and runner are what matter here.
    expect(['pass', 'requires-remote']).toContain(check(repo, 'lanes').status);
    expect(ok.out).toContain("ran: bats 'tests/foo.bats'");
    const zero = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], stub('1..0'));
    expect(zero.status).toBe(EXIT.fail);
    expect(zero.out).toMatch(/^tests {6}lanes {5}fail .*ZERO-RUN/m);
    const masked = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], stub('1..0\n# 1 passed'));
    expect(masked.status).toBe(EXIT.fail);
    expect(masked.out).toMatch(/^tests {6}lanes {5}fail .*ZERO-RUN/m);
  });
});

const NESTED = 'tests/integration/cli/deep.bats';

function batsRepo(dependencies: Record<string, string[]> = {}): FixtureRepo {
  return fixture({
    pregate: { ...BASE_PREGATE, runner: 'bats {files}', dependencies: { ...BASE_PREGATE.dependencies, ...dependencies } },
    baseFiles: { 'scripts/deep.sh': '#!/bin/sh\necho deep\n', [NESTED]: '@test "deep" { run bash scripts/deep.sh; [ "$output" = deep ]; }\n' },
  });
}

/** A `bats` on PATH that records its argv and prints `tap`, exiting `exit`. */
function stubBats(repo: FixtureRepo, tap: string, exit = 0): { env: Record<string, string>; argv: string } {
  const dir = path.join(repo.root, 'bin-stub');
  const argv = path.join(repo.root, 'bats-argv.txt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bats'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\nprintf '%s\\n' '${tap}'\nexit ${exit}\n`, { mode: 0o755 });
  return { env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }, argv };
}

const lanes = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === 'lanes');
const run = (repo: FixtureRepo, env: Record<string, string>) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain'], env);

describe('nested .bats files end to end (#3161, reviewer test for #3177)', () => {
  test('a touched nested .bats file selects itself with no declaration and runs under the bats runner', () => {
    const repo = batsRepo();
    commit(repo, { [NESTED]: '@test "deep" { run bash scripts/deep.sh; [ "$output" = deep ]; }\n@test "deeper" { true; }\n' });
    const stub = stubBats(repo, '1..2\nok 1 deep\nok 2 deeper');
    const r = run(repo, stub.env);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain(`${NESTED} (itself a test)`);
    expect(r.out).toContain(`ran: bats '${NESTED}'`);
    expect(fs.readFileSync(stub.argv, 'utf8').trim()).toBe(NESTED);
    expect(lanes(repo).detail).toMatch(/^2 tests ran in 1 file\(s\)/);
  });

  test('a declared dependency on a nested .bats file selects it; a failing run reports the bats counts', () => {
    const repo = batsRepo({ 'scripts/**': [NESTED] });
    commit(repo, { 'scripts/deep.sh': '#!/bin/sh\necho deeper\n' });
    const stub = stubBats(repo, '1..2\nok 1 a\nnot ok 2 deep', 1);
    const r = run(repo, stub.env);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain(`${NESTED} ← scripts/deep.sh (declared)`);
    expect(fs.readFileSync(stub.argv, 'utf8').trim()).toBe(NESTED);
    expect(lanes(repo)).toMatchObject({ status: 'fail', code: 'PREGATE_LANE_FAILED' });
    expect(lanes(repo).detail).toContain('1 failed of 2 ran');
  });
});
