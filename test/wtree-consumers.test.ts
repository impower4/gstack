/**
 * #3197: every consumer of the working-tree fingerprint goes through
 * lib/script-invocation.ts's wtreeFingerprint and keeps its own fail
 * direction when the fingerprint is unavailable, now saying why:
 *   gstack-regen check   refuses the scratch run (incomplete)
 *   gstack-regen write   completes; the run id falls back to the registry label
 *   gstack-gate-diff     records the candidate as `+nowtree`
 *   gstack-restamp       refuses (RESTAMP_CONFLICT), nothing written
 *   gstack-evidence      records without a fingerprint (grades STALE)
 * The failure is induced with an unwritable TMPDIR, which gstack-wtree
 * reports with its own repair hint.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanup as cleanupPregate, commit, makeFixtureRepo as makePregateRepo, runBin as runPregateBin, type FixtureRepo } from './helpers/pregate-fixture';
import { cleanup as cleanupRestamp, makeFixtureRepo as makeRestampRepo, makePr, restamp } from './helpers/restamp-fixture';
import { runBin } from './helpers/run-bin';
import { gitIn, findFilesBySuffix } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const badTmp = (root: string) => ({ TMPDIR: path.join(root, 'no-such-tmp') });
const WTREE_FAILED = /gstack-wtree exited 1: gstack-wtree: cannot create a temp index under .*no-such-tmp; set TMPDIR to a writable directory/;

function pregateRepo(): FixtureRepo {
  const repo = makePregateRepo();
  cleanups.push(() => cleanupPregate(repo));
  return repo;
}

describe('gstack-regen', () => {
  test('check: an unavailable fingerprint is an incomplete run that names the cause', () => {
    const repo = pregateRepo();
    commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.1.0' };\n" });
    const r = runPregateBin(repo, 'gstack-regen', ['check', '--allow-repo-commands'], badTmp(repo.root));
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(WTREE_FAILED);
    expect(r.err).toContain('cannot fingerprint the working tree (gstack-wtree exited 1:');
    expect(r.out).toContain('status=incomplete');
  });

  test('write: the no-scratch path completes and reports the registry label as its run id', () => {
    const repo = pregateRepo();
    const r = runPregateBin(repo, 'gstack-regen', ['write', '--allow-repo-commands'], badTmp(repo.root));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/GSTACK_RESULT: skill=regen status=complete run=origin\/main@/);
  });
});

describe('gstack-gate-diff', () => {
  test('records the candidate without a fingerprint and prints why', () => {
    const repo = pregateRepo();
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    const r = runPregateBin(repo, 'gstack-gate-diff', ['main'], badTmp(repo.root));
    expect(r.status).toBe(0);
    expect(r.err).toMatch(/gstack-gate-diff: working-tree fingerprint unavailable \(gstack-wtree exited 1: .*set TMPDIR.*\); candidate recorded without it/);
    expect(r.out + r.err).toContain('+nowtree');
  });
});

describe('gstack-restamp', () => {
  test('refuses with the fingerprint failure in its detail and writes nothing', () => {
    const repo = makeRestampRepo();
    cleanups.push(() => cleanupRestamp(repo));
    makePr(repo, 'pr-a');
    const r = restamp(repo, ['--next', '--dry-run'], badTmp(repo.root));
    expect(r.status).not.toBe(0);
    expect(r.out + r.err).toMatch(/cannot fingerprint the working tree \(gstack-wtree exited 1: .*set TMPDIR to a writable directory\); nothing written/);
    expect(r.out + r.err).toContain('RESTAMP_CONFLICT');
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});

describe('gstack-evidence', () => {
  function evidenceRepo(extra: string[] = []) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-evidence-wtree-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-evidence-wtree-repo-'));
    cleanups.push(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
    gitIn(repo, `init -q -b main ${extra.join(' ')}`);
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v1\n');
    gitIn(repo, 'add src.txt');
    gitIn(repo, 'commit -q -m init');
    const run = (env: Record<string, string> = {}) => runBin(path.join(ROOT, 'bin', 'gstack-evidence'), ['run', '--label', 'tests', '--', 'echo ok'], { cwd: repo, env: { GSTACK_HOME: home, ...env } });
    const record = () => JSON.parse(fs.readFileSync(findFilesBySuffix(path.join(home, 'projects'), '-evidence.jsonl')[0]!, 'utf8').trim().split('\n').pop()!);
    return { home, repo, run, record };
  }

  test('a SHA-256 repository gets a 64-hex content fingerprint', () => {
    const e = evidenceRepo(['--object-format=sha256']);
    expect(e.run().status).toBe(0);
    expect(e.record().wtree).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an unavailable fingerprint records without it and says why once', () => {
    const e = evidenceRepo();
    const r = e.run(badTmp(e.home));
    expect(r.status).toBe(0);
    expect(e.record().wtree).toBeUndefined();
    const warnings = r.stderr.split('\n').filter(l => l.includes('working-tree fingerprint unavailable'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(WTREE_FAILED);
  });
});
