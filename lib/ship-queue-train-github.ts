/**
 * GitHub reads and writes for merge trains, all through the queue's `gh`
 * seam (QueueContext.gh) so tests answer them from a fixture: PR identity,
 * workflow runs found by branch or by eval-bg nonce, run artifacts and the
 * full-gate check run. Dispatch itself goes through scripts/eval-bg.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Exec, RunSummary } from '../scripts/eval-bg';
import type { QueueContext } from './ship-queue';

export interface PrInfo { headRefOid: string; isCrossRepository: boolean; state: string; headRefName: string }
export interface RunInfo { databaseId: number; status: string; conclusion: string | null; url: string; headSha: string; event: string; displayTitle: string }
export interface CheckInfo { status: string; conclusion: string | null }

function json<T>(r: { ok: boolean; out: string }): T | null {
  if (!r.ok) return null;
  try { return JSON.parse(r.out) as T; } catch { return null; }
}

/** eval-bg's process seam bound to the queue's gh (only `gh` is ever routed through it). */
export function execFor(ctx: QueueContext): Exec {
  return (command, args) => {
    if (command !== 'gh') return { status: null, stdout: '' };
    const r = ctx.gh(args);
    return { status: r.ok ? 0 : 1, stdout: r.out };
  };
}

export function repoSlug(ctx: QueueContext): string | null {
  const r = json<{ nameWithOwner?: string }>(ctx.gh(['repo', 'view', '--json', 'nameWithOwner']));
  return r?.nameWithOwner && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.nameWithOwner) ? r.nameWithOwner : null;
}

export function prInfo(ctx: QueueContext, pr: string): PrInfo | { error: string } {
  const r = ctx.gh(['pr', 'view', pr, '--json', 'headRefOid,isCrossRepository,state,headRefName']);
  const p = json<Partial<PrInfo>>(r);
  if (!p?.headRefOid) return { error: `cannot read PR #${pr} through gh (${(r.err ?? r.out).trim().slice(0, 120) || 'no headRefOid'})` };
  return { headRefOid: p.headRefOid, isCrossRepository: p.isCrossRepository !== false, state: p.state ?? 'OPEN', headRefName: p.headRefName ?? '' };
}

const RUN_FIELDS = 'databaseId,status,conclusion,url,headSha,event,displayTitle';

/** Newest workflow_dispatch run of a workflow on one branch; null when none; 'unreadable' when gh failed. */
export function newestBranchRun(ctx: QueueContext, slug: string, workflow: string, branch: string): RunInfo | null | 'unreadable' {
  const runs = json<RunInfo[]>(ctx.gh(['run', 'list', '--repo', slug, '--workflow', workflow, '--branch', branch, '--event', 'workflow_dispatch', '--limit', '20', '--json', RUN_FIELDS]));
  if (!Array.isArray(runs)) return 'unreadable';
  return runs.filter(r => r.event === 'workflow_dispatch').sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
}

export function runView(ctx: QueueContext, slug: string, id: number): RunInfo | null {
  return json<RunInfo>(ctx.gh(['run', 'view', String(id), '--repo', slug, '--json', RUN_FIELDS]));
}

export function asRun(summary: RunSummary): { id: number; url: string } {
  return { id: summary.databaseId, url: summary.url };
}

/** One JSON artifact of a run (the first .json file it holds); null when it is missing or unreadable. */
export function downloadJson(ctx: QueueContext, slug: string, run: number, name: string, scratch: string): unknown {
  const dir = path.join(scratch, `${run}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!ctx.gh(['run', 'download', String(run), '--repo', slug, '-n', name, '-D', dir]).ok) return null;
    const file = fs.readdirSync(dir).find(f => f.endsWith('.json'));
    return file ? JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) : null;
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The named check run on a commit (the newest when several); null when absent or unreadable. */
export function checkRun(ctx: QueueContext, sha: string, name: string): CheckInfo | null {
  const r = json<{ check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }> }>(
    ctx.gh(['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`]));
  const hit = r?.check_runs?.find(c => c.name === name);
  return hit ? { status: hit.status ?? 'unknown', conclusion: hit.conclusion ?? null } : null;
}

/** Whether a branch exists on the remote (ls-remote, never a fetch). */
export function remoteBranchSha(git: (args: string[]) => { ok: boolean; out: string }, remote: string, branch: string): string | null {
  const r = git(['ls-remote', remote, `refs/heads/${branch}`]);
  return r.ok ? (r.out.split(/\s/)[0] || null) : null;
}
