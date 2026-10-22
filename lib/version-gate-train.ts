/**
 * Version Gate under merge trains (docs/ship-policy.md#run-a-merge-train).
 * When the base branch's .gstack/ship-policy.json declares a `train` block, a
 * READY head is unstamped: the train merges it onto main and the lane stamps
 * at its slot with `gstack-restamp --next`. This classifies the PR head
 * against its merge base with the base branch, so
 * scripts/compare-pr-version.ts can accept an unstamped head and hold a
 * stamped one to the version the restamp allocates (base + the policy bump).
 */
import { spawnSync } from 'node:child_process';
import { parseChangelog } from './changelog-check';
import { matchesAny } from './ship-policy';

export type TrainHead =
  | { kind: 'off' }
  | { kind: 'unstamped' }
  | { kind: 'stamped'; expected: string }
  | { kind: 'invalid'; reason: string };

function git(repoRoot: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout : null;
}

export function bumpVersion(version: string, level: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  const v = m.slice(1).map(Number);
  const at = { major: 0, minor: 1, patch: 2, micro: 3 }[level] ?? 2;
  return v.map((n, i) => (i < at ? n : i === at ? n + 1 : 0)).join('.');
}

export function classifyTrainHead(o: { repoRoot: string; baseRef: string; head: string }): TrainHead {
  const base = `origin/${o.baseRef.replace(/^origin\//, '')}`;
  const show = (rev: string, file: string) => git(o.repoRoot, ['show', `${rev}:${file}`]);
  let policy: any = null;
  try { policy = JSON.parse(show(base, '.gstack/ship-policy.json') ?? 'null'); } catch { policy = null; }
  if (!policy || typeof policy.train !== 'object' || policy.train === null) return { kind: 'off' };
  const mergeBase = git(o.repoRoot, ['merge-base', base, o.head])?.trim();
  if (!mergeBase) return { kind: 'invalid', reason: `no merge base between ${base} and ${o.head}` };

  const npmVersion = (rev: string) => { try { return JSON.parse(show(rev, 'package.json') ?? '{}').version ?? null; } catch { return null; } };
  const changed = (git(o.repoRoot, ['diff', '--name-only', mergeBase, o.head]) ?? '').split('\n').filter(Boolean);
  const releaseOutputs: string[] = Array.isArray(policy.release_outputs) ? policy.release_outputs : [];
  const touched = changed.filter(f => f === 'VERSION' || matchesAny(releaseOutputs, f));
  if (npmVersion(mergeBase) !== npmVersion(o.head)) touched.push('package.json version');
  if (touched.length) {
    const expected = bumpVersion(show(base, 'VERSION') ?? '', policy.bump ?? 'patch');
    return expected ? { kind: 'stamped', expected } : { kind: 'invalid', reason: `${base}:VERSION is not a 4-part version` };
  }

  const file = typeof policy.changelog === 'string' ? policy.changelog : 'CHANGELOG.md';
  const before = parseChangelog(show(mergeBase, file) ?? '');
  const after = parseChangelog(show(o.head, file) ?? '');
  const unreleased = after.sections.filter(s => s.unreleased);
  if (unreleased.length > 1) return { kind: 'invalid', reason: `${file} has ${unreleased.length} [Unreleased] sections` };
  if (unreleased.length === 1 && after.sections[0] !== unreleased[0]) return { kind: 'invalid', reason: `${file}: [Unreleased] must be the top section` };
  const released = (c: typeof after) => [c.header.join('\n'), ...c.sections.filter(s => !s.unreleased).map(s => s.lines.join('\n'))];
  const was = released(before);
  const now = released(after);
  if (was.length !== now.length || was.some((text, i) => text !== now[i])) {
    return { kind: 'invalid', reason: `${file} changes text outside [Unreleased]; an unstamped head may only add or edit its [Unreleased] section` };
  }
  return { kind: 'unstamped' };
}
