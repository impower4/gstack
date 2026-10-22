/**
 * Version Gate (scripts/compare-pr-version.ts). Hard rule 1 requires VERSION
 * above the base, which dependabot can never satisfy, so a dependabot PR that
 * touches only dependency manifests, lockfiles and dependabot config is exempt.
 * Every other author or file keeps the rule.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BASE_POLICY, cleanup, makeFixtureRepo, type FixtureRepo } from './helpers/restamp-fixture';
import { bumpVersion } from '../lib/version-gate-train';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'compare-pr-version.ts');

function gate(env: { PR_VERSION: string; PR_AUTHOR?: string; PR_CHANGED_FILES?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-gate-'));
  try {
    const next = path.join(dir, 'next.json');
    fs.writeFileSync(next, JSON.stringify({ version: '1.91.117.0', base_version: '1.91.116.0', claimed: [{ pr: 3236, branch: 'fix-wave-5', version: '1.91.117.0' }] }));
    const run = Bun.spawnSync([process.execPath, 'run', SCRIPT, next, '3227'], {
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DEPENDABOT = 'dependabot[bot]';

describe('version gate: dependabot dependency-manifest exemption', () => {
  test('an unbumped VERSION still fails for a human author', () => {
    const result = gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: 'garrytan', PR_CHANGED_FILES: 'package.json\nbun.lock' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('::error::VERSION not bumped');
  });

  test('a dependabot PR behind main that touches only manifests, lockfiles and dependabot config passes', () => {
    const files = ['package.json', 'bun.lock', 'lib/diagram-render/package.json', 'lib/diagram-render/bun.lock', '.github/dependabot.yml'].join('\n');
    const result = gate({ PR_VERSION: '1.91.106.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: files + '\n' });
    expect(result.code).toBe(0);
    expect(result.out).toContain('::notice::PR #3227 is a dependabot dependency update');
    expect(result.out).not.toContain('::error::');
  });

  test('a dependabot PR with any other file keeps hard rule 1', () => {
    for (const other of ['scripts/compare-pr-version.ts', 'VERSION', '.github/workflows/version-gate.yml', 'evil-package.json', 'package.json.bak']) {
      const result = gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: `package.json\nbun.lock\n${other}` });
      expect(result.code).toBe(1);
      expect(result.out).toContain('::error::VERSION not bumped');
    }
  });

  test('a missing file list or author keeps hard rule 1', () => {
    expect(gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: '' }).code).toBe(1);
    expect(gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: DEPENDABOT }).code).toBe(1);
    expect(gate({ PR_VERSION: '1.91.116.0', PR_CHANGED_FILES: 'package.json' }).code).toBe(1);
  });

  test('a bumped dependabot VERSION goes through the collision rule as before', () => {
    const result = gate({ PR_VERSION: '1.91.117.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: 'package.json' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('::error::VERSION collision');
  });

  test('the workflow passes the PR author and its changed-file list to the gate', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'version-gate.yml'), 'utf8')) as any;
    const step = workflow.jobs.check.steps.find((s: any) => s.name === 'Compare PR VERSION to next free slot');
    expect(step.env.PR_AUTHOR).toBe('${{ github.event.pull_request.user.login }}');
    expect(step.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(step.run).toContain('pulls/${{ github.event.pull_request.number }}/files');
    expect(step.run).toContain('--paginate');
    expect(step.run).toContain('then PR_CHANGED_FILES=""; fi');
    expect(step.run).toContain('export PR_CHANGED_FILES');
    expect(workflow.jobs.check.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });
});

/**
 * Under merge trains (docs/ship-policy.md#run-a-merge-train) a READY head is
 * unstamped: VERSION, package.json and the release outputs stay at the merge
 * base and the CHANGELOG entry sits under [Unreleased]. The gate classifies
 * the head against the base's policy in a real git repo.
 */
describe('version gate: unstamped heads under a train policy', () => {
  const TRAIN = { gate_workflow: 'evals.yml', free_workflow: 'free-tests.yml', full_gate_check: 'gstack/full-gate', record_artifact: 'gstack-train-record', max_size: 5, fill_hours: 3, screen_selection: 'gstack-paid', trial_reservation_usd: 1.5 };
  const repos: FixtureRepo[] = [];
  const fixture = (policy: Record<string, unknown> = { ...BASE_POLICY, train: TRAIN }) => { const r = makeFixtureRepo({ policy, prefix: 'version-gate-train-' }); repos.push(r); return r; };
  const write = (r: FixtureRepo, rel: string, text: string) => fs.writeFileSync(path.join(r.work, rel), text);
  const read = (r: FixtureRepo, rel: string) => fs.readFileSync(path.join(r.work, rel), 'utf8');
  const commit = (r: FixtureRepo, msg: string) => { r.git('add', '-A'); r.git('commit', '-q', '-m', msg); return r.git('rev-parse', 'HEAD'); };
  const withUnreleased = (r: FixtureRepo, entry = '- the PR entry') => read(r, 'CHANGELOG.md').replace('# Changelog\n\n', `# Changelog\n\n## [Unreleased]\n\n${entry}\n\n`);
  const run = (r: FixtureRepo, head: string, prVersion = read(r, 'VERSION').trim()) => {
    const next = path.join(r.root, 'next.json');
    fs.writeFileSync(next, JSON.stringify({ version: '1.2.4.0', base_version: '1.2.3.0', claimed: [] }));
    const out = Bun.spawnSync([process.execPath, 'run', SCRIPT, next, '3320'], {
      cwd: r.work, env: { ...process.env, ...r.env, PR_VERSION: prVersion, BASE_REF: 'main', HEAD_SHA: head }, timeout: 30_000, stdout: 'pipe', stderr: 'pipe',
    });
    return { code: out.exitCode, out: out.stdout.toString() + out.stderr.toString() };
  };
  const branch = (r: FixtureRepo) => r.git('checkout', '-q', '-b', 'feature');

  test('an unstamped head with only an [Unreleased] entry passes', () => {
    const r = fixture();
    branch(r);
    write(r, 'docs/feature.md', 'new\n');
    write(r, 'CHANGELOG.md', withUnreleased(r));
    const res = run(r, commit(r, 'feature'));
    expect(res.code).toBe(0);
    expect(res.out).toContain('is unstamped under the base');
  });

  test('an unstamped head on an older main still passes (the train merges it; no main merge needed)', () => {
    const r = fixture();
    branch(r);
    write(r, 'CHANGELOG.md', withUnreleased(r));
    const head = commit(r, 'feature');
    r.git('checkout', '-q', 'main');
    write(r, 'VERSION', '1.2.4.0\n');
    write(r, 'CHANGELOG.md', read(r, 'CHANGELOG.md').replace('# Changelog\n\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-02\n\n- another release\n\n'));
    commit(r, 'release 1.2.4.0');
    r.git('push', '-q', 'origin', 'main');
    r.git('fetch', '-q', 'origin');
    const res = run(r, head, '1.2.3.0');
    expect(res.code).toBe(0);
    expect(res.out).toContain('is unstamped under the base');
  });

  test('without a train block the unstamped head keeps hard rule 1', () => {
    const r = fixture({ ...BASE_POLICY });
    branch(r);
    write(r, 'CHANGELOG.md', withUnreleased(r));
    const res = run(r, commit(r, 'feature'));
    expect(res.code).toBe(1);
    expect(res.out).toContain('::error::VERSION not bumped');
  });

  test('a stamped head must carry base + bump: the slot-called stamp passes, any other version fails', () => {
    const r = fixture();
    branch(r);
    write(r, 'CHANGELOG.md', read(r, 'CHANGELOG.md').replace('# Changelog\n\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-02\n\n- the PR entry\n\n'));
    write(r, 'VERSION', '1.2.4.0\n');
    const stamped = commit(r, 'stamp 1.2.4.0');
    expect(run(r, stamped).code).toBe(0);
    write(r, 'VERSION', '1.2.7.0\n');
    const res = run(r, commit(r, 'wrong stamp'));
    expect(res.code).toBe(1);
    expect(res.out).toContain('must carry v1.2.4.0');
  });

  test('negative controls: a changed package.json version or release output counts as a stamp and needs base + bump', () => {
    for (const edit of [
      (r: FixtureRepo) => write(r, 'package.json', read(r, 'package.json').replace('"version": "1.2.3"', '"version": "1.2.9"')),
      (r: FixtureRepo) => write(r, 'generated/digest.md', '# digest v1.2.9.0\nbody\n'),
    ]) {
      const r = fixture();
      branch(r);
      write(r, 'CHANGELOG.md', withUnreleased(r));
      edit(r);
      const res = run(r, commit(r, 'stray version edit'));
      expect(res.code).toBe(1);
      expect(res.out).toContain('must carry v1.2.4.0');
    }
  });

  test('negative controls: CHANGELOG edits outside [Unreleased] fail an unstamped head', () => {
    const cases: Array<(r: FixtureRepo) => string> = [
      r => withUnreleased(r).replace('- older', '- older, rewritten'),
      r => read(r, 'CHANGELOG.md').replace('- base release', '- base release\n- smuggled into a released section'),
      r => withUnreleased(r).replace('## [1.2.2.0]', '## [Unreleased]\n\n- second\n\n## [1.2.2.0]'),
      r => read(r, 'CHANGELOG.md').replace('## [1.2.2.0]', '## [Unreleased]\n\n- not on top\n\n## [1.2.2.0]'),
    ];
    for (const changelog of cases) {
      const r = fixture();
      branch(r);
      write(r, 'CHANGELOG.md', changelog(r));
      const res = run(r, commit(r, 'bad changelog'));
      expect(res.code).toBe(1);
      expect(res.out).toContain('::error::PR #3320:');
    }
  });

  test('the workflow runs the gate from the merge commit with the base ref and head sha', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'version-gate.yml'), 'utf8')) as any;
    const steps = workflow.jobs.check.steps;
    const gateCode = steps.find((s: any) => s.name === 'Checkout gate code (merge commit)');
    expect(gateCode.with).toMatchObject({ ref: '${{ github.sha }}', path: '.version-gate', 'persist-credentials': false });
    const step = steps.find((s: any) => s.name === 'Compare PR VERSION to next free slot');
    expect(step.env.BASE_REF).toBe('${{ steps.versions.outputs.base_ref }}');
    expect(step.env.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
    expect(step.run).toContain('run .version-gate/scripts/compare-pr-version.ts');
  });

  test('the stamped version is base + the policy bump', () => {
    expect(bumpVersion('1.91.164.0', 'patch')).toBe('1.91.165.0');
    expect(bumpVersion('1.91.164.3', 'patch')).toBe('1.91.165.0');
    expect(bumpVersion('1.91.164.0', 'micro')).toBe('1.91.164.1');
    expect(bumpVersion('1.91.164.0', 'minor')).toBe('1.92.0.0');
    expect(bumpVersion('1.91.164', 'patch')).toBeNull();
  });

  test('cleanup', () => { while (repos.length) cleanup(repos.pop()!); });
});
