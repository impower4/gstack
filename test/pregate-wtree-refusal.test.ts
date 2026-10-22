/**
 * Fix wave PR 5, item 10b (#3197): the pregate consumers of the working-tree
 * fingerprint use lib/script-invocation.ts's `{tree}|{error}` form. A
 * fingerprint failure is WTREE_UNAVAILABLE, never "origin/<base> is not a
 * resolvable commit": a launch failure lists each Windows bash candidate and
 * names GSTACK_GIT_BASH, a gstack-wtree exit keeps the repair it printed.
 * Under --json every context refusal is one envelope on stdout with exit 3,
 * sharing `ok` and `status` with the run object; GSTACK_RESULT is on stderr.
 * A `--base` that names a commit here but no origin branch (#3269) gets a fix
 * naming a branch, never a fetch that cannot create `origin/<base>`; a branch
 * name keeps the fetch fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT, type PregateFile } from '../lib/headless-artifacts';
import { buildContext, describeRefusal, readTestBackend, withFingerprint, wtreeRefusal } from '../lib/pregate/context';
import { verifyPregate } from '../lib/pregate/index';
import type { BashProbe } from '../lib/script-invocation';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const noBash: BashProbe = { platform: 'win32', env: {}, exists: () => false, gitExecPath: () => null, which: () => null };
const badTmp = (repo: FixtureRepo) => ({ TMPDIR: path.join(repo.root, 'no-such-tmp') });
const pregate = (repo: FixtureRepo, args: string[], env: Record<string, string> = {}) => runBin(repo, 'gstack-pregate', ['--base', 'main', ...args], env);
const lastLine = (text: string) => text.trim().split('\n').pop() ?? '';

describe('WTREE_UNAVAILABLE (lib/pregate/context.ts)', () => {
  test('a launch failure (no Git Bash) refuses with each candidate and the GSTACK_GIT_BASH fix, not an unresolvable base', () => {
    const repo = fixture();
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, testBackend: 'local', invocation: noBash });
    expect('refused' in loaded).toBe(true);
    if (!('refused' in loaded)) return;
    expect(loaded.refused.code).toBe('WTREE_UNAVAILABLE');
    expect(loaded.refused.message).toStartWith('gstack-wtree could not start: no Git Bash found; tried GSTACK_GIT_BASH (unset): not set; ');
    expect(loaded.refused.message).toContain('install path C:/Program Files/Git/bin/bash.exe: not found');
    expect(loaded.refused.message).toContain('PATH bash: not on PATH');
    const r = describeRefusal(loaded.refused, 'main');
    expect(r.line).not.toContain('is not a resolvable commit');
    expect(r.line).toEndWith('(WTREE_UNAVAILABLE)');
    expect(r.fix).toContain("export GSTACK_GIT_BASH='C:/Program Files/Git/bin/bash.exe'");
    expect(r.docs).toEndWith('docs/troubleshooting.md#wtree-unavailable');
  });

  test('a gstack-wtree exit keeps its own repair; an exit without one names how to reproduce it', () => {
    expect(wtreeRefusal({ kind: 'exit', error: 'gstack-wtree exited 1: gstack-wtree: cannot create a temp index under /x; set TMPDIR to a writable directory' }))
      .toEqual({ code: 'WTREE_UNAVAILABLE', message: 'gstack-wtree exited 1: gstack-wtree: cannot create a temp index under /x', fix: 'set TMPDIR to a writable directory' });
    expect(wtreeRefusal({ kind: 'exit', error: 'gstack-wtree exited 1: no stderr' }).fix).toStartWith('run bin/gstack-wtree in the repository');
  });

  test('the after-check fingerprint failing is incomplete with its cause, not "working tree changed"', async () => {
    const repo = fixture();
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, testBackend: 'local' });
    if (!('ctx' in loaded)) throw new Error(JSON.stringify(loaded.refused));
    const ctx = { ...loaded.ctx, env: { ...loaded.ctx.env, ...badTmp(repo) } };
    const r = await withFingerprint(ctx, 'strays', 'preflight', () => ({ id: 'strays', stage: 'preflight', status: 'pass', inputs: {} }));
    expect(r.status).toBe('incomplete');
    expect(r.detail).toStartWith('cannot fingerprint the working tree after the check (gstack-wtree exited 1:');
    expect(r.fix).toBe('set TMPDIR to a writable directory');
  });

  test('verify says the tree cannot be fingerprinted instead of comparing against "unknown"', () => {
    const file = { schema_version: 1, tree: 'a'.repeat(40), checks: [], requires_remote: [] } as unknown as PregateFile;
    const v = verifyPregate('/nonexistent', file, { kind: 'launch', error: 'gstack-wtree could not start: no Git Bash found' });
    expect(v).toMatchObject({ ok: false, code: 'PREGATE_STALE', current: false });
    expect(v.message).toContain('the tree cannot be fingerprinted now (gstack-wtree could not start: no Git Bash found)');
  });

  test('gstack-config (test_backend) launches through the script invocation, so Windows reaches it through Git Bash', () => {
    const repo = fixture();
    const env = { ...process.env, ...repo.env };
    expect(runBin(repo, 'gstack-config', ['set', 'test_backend', 'ubicloud']).status).toBe(0);
    const bash = Bun.which('bash')!;
    let resolved = 0;
    const backend = readTestBackend(env, { platform: 'win32', resolve: () => { resolved += 1; return { ok: true, bash, source: 'test', tried: [] }; } });
    expect(resolved).toBe(1);
    expect(backend).toBe('ubicloud');
  });
});

describe('gstack-pregate context refusals through the CLI', () => {
  test('a gstack-wtree failure prints WTREE_UNAVAILABLE with its own fix, never "is not a resolvable commit"', () => {
    const repo = fixture();
    const r = pregate(repo, ['--stage', 'preflight'], badTmp(repo));
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).not.toContain('is not a resolvable commit');
    expect(lastLine(r.err)).toMatch(/^gstack-pregate: cannot fingerprint the working tree: .* \(gstack-wtree exited 1: gstack-wtree: cannot create a temp index under .*no-such-tmp\); fix: set TMPDIR to a writable directory \(WTREE_UNAVAILABLE\)$/);
    expect(lastLine(r.out)).toMatch(/^GSTACK_RESULT: skill=pregate status=refused /);
  });

  test('--json: both refusals are one envelope on stdout (exit 3) sharing ok and status with the run object; GSTACK_RESULT goes to stderr', () => {
    const repo = fixture();
    const wtree = pregate(repo, ['--stage', 'preflight', '--json'], badTmp(repo));
    const base = runBin(repo, 'gstack-pregate', ['--base', 'no-such-base', '--stage', 'preflight', '--json']);
    const run = pregate(repo, ['--stage', 'preflight', '--only', 'strays', '--json']);
    for (const r of [wtree, base]) {
      expect(r.status).toBe(EXIT.refused);
      expect(r.out.trim().split('\n')).toHaveLength(1);
      expect(r.out).not.toContain('GSTACK_RESULT');
      expect(r.err).toMatch(/^GSTACK_RESULT: skill=pregate status=refused /m);
    }
    const w = JSON.parse(wtree.out);
    expect(Object.keys(w).sort()).toEqual(['code', 'detail', 'docs', 'fix', 'ok', 'status']);
    expect(w).toMatchObject({ ok: false, status: 'refused', code: 'WTREE_UNAVAILABLE', fix: 'set TMPDIR to a writable directory' });
    expect(w.detail).toMatch(/cannot create a temp index under .*no-such-tmp$/);
    expect(w.docs).toEndWith('#wtree-unavailable');
    const b = JSON.parse(base.out);
    expect(b).toMatchObject({ ok: false, status: 'refused', code: 'POLICY_SOURCE_UNAVAILABLE', detail: 'origin/no-such-base is not a resolvable commit' });
    expect(b.fix).toContain('git fetch origin no-such-base --depth=1');
    expect(b.docs).toEndWith('#policy-source-unavailable');
    expect(run.status).toBe(EXIT.ok);
    const ok = JSON.parse(run.out);
    expect(ok).toMatchObject({ ok: true, status: 'complete' });
    expect(run.err).toMatch(/^GSTACK_RESULT: skill=pregate status=complete run=.*pregate\.json$/m);
    expect(fs.existsSync(ok.out)).toBe(true);
  });

  test('a --base that names a commit here but no origin branch says to pass a branch; a branch name keeps the fetch fix (#3269)', () => {
    const repo = fixture();
    const sha = repo.git('rev-parse', '--short=8', 'main');
    repo.git('update-ref', 'refs/remotes/upstream/main', 'main');
    repo.git('branch', 'unpushed', 'main');
    for (const base of [sha, 'upstream/main']) {
      const r = runBin(repo, 'gstack-pregate', ['--base', base, '--stage', 'preflight', '--json']);
      expect(r.status).toBe(EXIT.refused);
      const b = JSON.parse(r.out);
      expect(b).toMatchObject({ ok: false, status: 'refused', code: 'POLICY_SOURCE_UNAVAILABLE' });
      expect(b.detail).toStartWith(`origin/${base} is not a resolvable commit`);
      expect(b.detail).toContain('--base takes a branch name on origin');
      expect(b.fix).toContain('--base main');
      expect(b.docs).toEndWith('#policy-source-unavailable');
      const line = r.err.split('\n')[0]!;
      expect(line).not.toContain('git fetch');
      expect(line).toContain('the reviewed pin files cannot be read');
      expect(line).toEndWith(`; fix: ${b.fix} (POLICY_SOURCE_UNAVAILABLE)`);
    }
    const unpushed = runBin(repo, 'gstack-pregate', ['--base', 'unpushed', '--stage', 'preflight', '--json']);
    expect(unpushed.status).toBe(EXIT.refused);
    expect(JSON.parse(unpushed.out).fix).toContain('git fetch origin unpushed --depth=1');
  });
});
