/**
 * pregate check `guards` (tier 2, preflight; field wave CD1): the repo's own
 * mechanical gates a lane must pass before it reports done. Each
 * `.gstack/pregate.json` guard `{ id, when, command, fix?, timeout_s? }`
 * whose `when` globs match a touched file runs in its own process group
 * (lib/pregate/supervise.ts: bash, under the verified launch Bun, output to a
 * log file, with its own timeout and the stall timeout). A failing guard
 * fails pregate naming the guard and its fix; a timed-out one is
 * `incomplete`; without --allow-repo-commands the selected guards are listed
 * and the check is `incomplete`. Guards are never downgradable. Field
 * incident: a gbrain serial test landed without its manifest row and
 * passed both the isolation check and pregate; `test/cli-goldens.test.ts`
 * spawns the CLI as a subprocess, so no import graph selects it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { matchesAny } from '../../ship-policy';
import type { Guard } from '../config';
import { baseInputs, sha256 } from '../context';
import { launchRuntime } from '../runtime';
import { readRange, supervise } from '../supervise';
import type { CheckDef, CheckResult, PregateContext } from '../types';

interface GuardRun { guard: Guard; exit: number | null; timedOut: boolean; stalled: boolean; tail: string[]; log: string }

async function runGuard(ctx: PregateContext, guard: Guard, env: NodeJS.ProcessEnv, dir: string): Promise<GuardRun> {
  const timeoutMs = guard.timeout_s ? guard.timeout_s * 1000 : ctx.timeoutMs;
  const log = path.join(dir, `${guard.id}.log`);
  fs.writeFileSync(log, '');
  const r = await supervise({ command: guard.command, cwd: ctx.repoRoot, env: { ...env, CI: env.CI ?? '1' }, log, deadline: Date.now() + timeoutMs, stallMs: ctx.stallTimeoutMs, label: `guard ${guard.id}`, progress: ctx.progress });
  const output = readRange(log, r.start, r.end).trim();
  return { guard, exit: r.exit, timedOut: r.outcome !== 'exited', stalled: r.outcome === 'stalled', tail: output ? output.split('\n').slice(-15) : [], log };
}

async function run(ctx: PregateContext): Promise<CheckResult> {
  const touched = ctx.touched.flatMap(t => (t.renamedFrom ? [t.path, t.renamedFrom] : [t.path]));
  const selected = ctx.config.guards.filter(g => touched.some(f => matchesAny(g.when, f)));
  const inputs = baseInputs(ctx, { guards: sha256(selected.map(g => `${g.id}\0${g.command}`).join('\n')) });
  const base: CheckResult = { id: 'guards', stage: 'preflight', status: 'pass', inputs };
  if (ctx.config.guards.length === 0) return { ...base, detail: `no guards declared (${ctx.configLabel})` };
  if (selected.length === 0) return { ...base, detail: `no guard's files touched (${ctx.config.guards.length} declared)` };
  const listed = selected.map(g => `COMMAND: ${g.id}=${JSON.stringify(g.command)} when=${g.when.join(',')}`);
  if (!ctx.allowRepoCommands) {
    return { ...base, status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED', lines: listed, detail: `${selected.length} guard(s) not run (pass --allow-repo-commands): ${selected.map(g => g.id).join(', ')}`, fix: 'rerun with --allow-repo-commands (what a lane runs before reporting done, and what /ship passes)' };
  }
  const runtime = launchRuntime(ctx.repoRoot, ctx.env);
  if (runtime.refusal) return { ...base, ...runtime.refusal, lines: [`runtime: ${runtime.label}`] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-guards-'));
  const runs: GuardRun[] = [];
  for (const g of selected) runs.push(await runGuard(ctx, g, runtime.env, dir));
  const lines = [`runtime: ${runtime.label}`];
  for (const r of runs) {
    lines.push(r.stalled ? `GUARD: ${r.guard.id} stalled: no output for ${ctx.stallTimeoutMs / 1000} s; process group killed (log ${r.log})` : r.timedOut ? `GUARD: ${r.guard.id} timed out after ${r.guard.timeout_s ?? ctx.timeoutMs / 1000} s (log ${r.log})` : `GUARD: ${r.guard.id} exit=${r.exit} (log ${r.log})`);
    if (r.exit !== 0) lines.push(...r.tail.map(l => `  ${l}`));
  }
  const failed = runs.filter(r => !r.timedOut && r.exit !== 0);
  const timedOut = runs.filter(r => r.timedOut);
  const withRuns = { ...base, lines, inputs: { ...inputs, runtime: runtime.label } };
  const fixOf = (rs: GuardRun[]) => rs.map(r => `${r.guard.id}: ${r.guard.fix ?? `read ${r.log}, fix the failure, rerun gstack-pregate --only guards`}`).join('; ');
  if (failed.length) return { ...withRuns, status: 'fail', code: 'PREGATE_GUARD_FAILED', detail: `${failed.length} guard(s) failed: ${failed.map(r => r.guard.id).join(', ')}${timedOut.length ? `; timed out: ${timedOut.map(r => r.guard.id).join(', ')}` : ''}`, fix: fixOf(failed) };
  if (timedOut.length) return { ...withRuns, status: 'incomplete', code: timedOut.some(r => r.stalled) ? 'PREGATE_STALLED' : 'PREGATE_INCOMPLETE', detail: `${timedOut.length} guard(s) did not finish: ${timedOut.map(r => `${r.guard.id} (${r.stalled ? 'stalled' : 'timed out'})`).join(', ')}`, fix: 'fix the hang, or raise the guard\'s timeout_s, --timeout or --stall-timeout; an unfinished guard never passes' };
  return { ...withRuns, detail: `${runs.length} guard(s) passed: ${runs.map(r => r.guard.id).join(', ')}` };
}

export const guardsCheck: CheckDef = { id: 'guards', stage: 'preflight', tier: 2, downgradable: false, needsRepoCommands: true, run };
