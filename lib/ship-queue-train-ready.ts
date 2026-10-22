/**
 * `ready --pr <n> --screen | --no-screen` under a ship policy with a `train`
 * block (docs/ship-policy.md#run-a-merge-train; plan GSTA-49 T1). The
 * READY block is today's (lib/ship-queue.ts ready()); this adds the screen
 * selection and Garry's default recommendation (screen when the screen
 * selects a skill's own cases), requires an explicit choice
 * (READY_SCREEN_CHOICE_REQUIRED), dispatches a chosen screen through
 * eval-bg's nonce with its purpose and policy in the key, and records the
 * choice as a READY receipt (local state and refs/notes/gstack-trains) that
 * `train build` requires. The screen's dollar price is left to the T0 cost
 * replay (lib/gate-cost.ts) and printed as pending until it lands.
 */
import { randomBytes } from 'node:crypto';
import { DISPATCH_INPUTS, awaitNonceRun, dedupeKey, dispatchWorkflow, findDuplicateRun, listDispatchRuns, makeNonce, type WorkflowDispatch } from '../scripts/eval-bg';
import { EXIT } from './headless-artifacts';
import { ready, type QueueContext } from './ship-queue';
import { git } from './ship-queue-gate';
import { execFor, repoSlug } from './ship-queue-train-github';
import { loadReady, nowIso, persist, readyPath, type ReadyReceipt, type ScreenChoice } from './ship-queue-train-record';
import { outOk, outPending, outRefused, trainEnv, type TrainEnv, type TrainOut } from './ship-queue-train';

const Q = 'gstack-ship-queue';

export interface ReadyOptions { pr: string; pregate?: string; gateExit?: number; gateLog?: string; screen?: 'screen' | 'no-screen'; broad: boolean; dryRun: boolean }
export interface ScreenSelection { lines: string[]; recommend: 'screen' | 'no-screen' | null }

/** Skill directories a diff touches: top-level directories that hold a SKILL.md.tmpl at the head. */
export function touchedSkills(changed: readonly string[], hasTemplate: (dir: string) => boolean): string[] {
  return [...new Set(changed.filter(f => f.includes('/')).map(f => f.split('/')[0]!))].filter(hasTemplate).sort();
}

/** The selected cases that are a touched skill's own: their touchfiles name a path inside that skill's directory. */
export function skillOwnCases(selected: readonly string[], touchfiles: Record<string, string[]>, skills: readonly string[]): string[] {
  return selected.filter(id => (touchfiles[id] ?? []).some(glob => skills.some(s => glob.startsWith(`${s}/`)))).sort();
}

/** gstack's paid selector over a diff (today's PR selection; T2 narrows it), loaded only when the policy asks for it. */
export async function gstackPaidSelection(repoRoot: string, baseSha: string, changed: string[], hasTemplate: (dir: string) => boolean): Promise<ScreenSelection> {
  const { computePaidCaseSelection } = await import('../scripts/lib/paid-select');
  const { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } = await import('../test/helpers/touchfiles');
  const skills = touchedSkills(changed, hasTemplate);
  let e2e: string[]; let judges: number; let note = "today's PR selection; T2's narrowed screen has not landed";
  try {
    const s = computePaidCaseSelection({ profile: 'pr', rootDir: repoRoot, changedFiles: changed, env: { ...process.env, EVALS_BASE: baseSha, EVALS_ALL: '' } }).selection;
    e2e = s.e2e ?? Object.keys(E2E_TOUCHFILES);
    judges = s.judges ? s.judges.length : Object.keys(LLM_JUDGE_TOUCHFILES).length;
  } catch (error) {
    e2e = Object.keys(E2E_TOUCHFILES);
    judges = Object.keys(LLM_JUDGE_TOUCHFILES).length;
    note = `the PR profile needs full validation (${error instanceof Error ? error.message.slice(0, 160) : String(error)}): the screen is the full gate selection`;
  }
  const own = skillOwnCases(e2e, E2E_TOUCHFILES, skills);
  const recommend = own.length ? 'screen' : 'no-screen';
  return {
    recommend,
    lines: [
      `SCREEN: selection ${e2e.length} e2e case(s) + ${judges} judge(s) (${note})`,
      `SCREEN: skill's own cases ${own.length ? own.slice(0, 12).join(',') + (own.length > 12 ? ` (+${own.length - 12})` : '') : 'none'} → recommend --${recommend}`,
    ],
  };
}

async function screenSelection(env: TrainEnv, head: string, baseSha: string): Promise<ScreenSelection> {
  const price = 'SCREEN: price pending the T0 cost replay (lib/gate-cost.ts): cases without cost data are unknown; a red train holds its PRs about an hour';
  if (env.train.screen_selection === 'none') return { recommend: null, lines: ['SCREEN: selection not computed (train.screen_selection is none); no recommendation, the lane decides', price] };
  const changed = git(env.ctx.repoRoot, ['diff', '--name-only', `${baseSha}...${head}`]).out.split('\n').filter(Boolean);
  const hasTemplate = (dir: string) => git(env.ctx.repoRoot, ['cat-file', '-e', `${head}:${dir}/SKILL.md.tmpl`]).ok;
  const s = await gstackPaidSelection(env.ctx.repoRoot, baseSha, changed, hasTemplate);
  return { ...s, lines: [...s.lines, price] };
}

/** Dispatch (or adopt) the PR's screen on the base branch: inputs name the PR, its merge SHA and the screen policy. */
async function dispatchScreen(env: TrainEnv, o: ReadyOptions, mergeSha: string, baseSha: string): Promise<{ choice: ScreenChoice; line: string } | TrainOut> {
  const policy = o.broad ? 'broad' : 'narrow';
  const scope = { purpose: 'screen' as const, policy: policy as 'narrow' | 'broad' };
  const nonce = makeNonce('pr', mergeSha, baseSha, randomBytes(3).toString('hex'), scope);
  const dispatch: WorkflowDispatch = { workflow: env.train.gate_workflow, inputs: {
    [DISPATCH_INPUTS.evalsAll]: 'false', [DISPATCH_INPUTS.expectedSha]: mergeSha, [DISPATCH_INPUTS.nonce]: nonce, [DISPATCH_INPUTS.baseRef]: env.ctx.base,
    [DISPATCH_INPUTS.baseSha]: baseSha, [DISPATCH_INPUTS.screenPr]: o.pr, [DISPATCH_INPUTS.screenMergeSha]: mergeSha, [DISPATCH_INPUTS.screenPolicy]: policy,
  } };
  const inputs = Object.entries(dispatch.inputs).map(([k, v]) => `${k}=${v}`).join(' ');
  if (o.dryRun) return { choice: { choice: 'screen', policy, nonce, run: null, merge_sha: mergeSha }, line: `SCREEN_DISPATCH: ${dispatch.workflow} --ref ${env.ctx.base} ${inputs} (dry run: not dispatched)` };
  const slug = repoSlug(env.ctx);
  if (!slug) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, [], `${Q} ready --pr ${o.pr} --screen`, 'none');
  const exec = execFor(env.ctx);
  const existing = findDuplicateRun(listDispatchRuns(dispatch.workflow, exec, slug) ?? [], dedupeKey('pr', mergeSha, baseSha, scope));
  if (existing) return { choice: { choice: 'screen', policy, nonce: /eval-bg (\S+?)\]/.exec(existing.displayTitle)?.[1] ?? nonce, run: existing.databaseId, merge_sha: mergeSha }, line: `SCREEN_DISPATCH: following run ${existing.databaseId} (same merge SHA, base and policy; no duplicate)` };
  const found = dispatchWorkflow(dispatch, env.ctx.base, exec, slug) ? await awaitNonceRun(dispatch.workflow, nonce, exec, slug) : null;
  if (!found) return outPending({ code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `no ${dispatch.workflow} run named ${nonce} appeared after the screen dispatch` }, [], `${Q} ready --pr ${o.pr} --screen${o.broad ? ' --broad' : ''} (adopts the run by its key once it appears)`, 'none');
  return { choice: { choice: 'screen', policy, nonce, run: found.databaseId, merge_sha: mergeSha }, line: `SCREEN_DISPATCH: ${dispatch.workflow} run ${found.databaseId} ${found.url} nonce ${nonce}` };
}

export async function trainReady(ctx: QueueContext, o: ReadyOptions): Promise<TrainOut> {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  const base = ready(ctx, o);
  if (!base.ok) {
    const out = outRefused(base.failure!, base.lines, `fix the refusal, then ${Q} ready --pr ${o.pr} --screen|--no-screen`, base.run);
    return ['QUEUE_VERIFY_MISMATCH', 'QUEUE_STAMP_NOT_STAMP_ONLY'].includes(base.failure!.code) ? { ...out, exit: EXIT.fail } : out;
  }
  const head = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
  const baseSha = git(ctx.repoRoot, ['rev-parse', `${env.remote}/${ctx.base}`]).out;
  const sel = await screenSelection(env, head, baseSha);
  const lines = [...base.lines, ...sel.lines];
  const rec = sel.recommend ?? 'no-screen';
  if (!o.screen) {
    return outRefused({ code: 'READY_SCREEN_CHOICE_REQUIRED', message: `the base policy runs merge trains; choose --screen or --no-screen (recommended: --${rec})` }, lines,
      `${Q} ready --pr ${o.pr} --${rec}`, 'none');
  }
  let choice: ScreenChoice = { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null };
  if (o.screen === 'screen') {
    const ls = git(ctx.repoRoot, ['ls-remote', env.remote, `refs/pull/${o.pr}/merge`]);
    const mergeSha = ls.ok ? ls.out.split(/\s/)[0] ?? '' : '';
    if (!/^[0-9a-f]{40,64}$/.test(mergeSha)) return outRefused({ code: 'QUEUE_NOT_READY', message: `${env.remote} has no refs/pull/${o.pr}/merge (the PR conflicts with ${ctx.base}, or GitHub has not computed it yet)` }, lines, `merge ${ctx.base} into the branch, push, then ${Q} ready --pr ${o.pr} --screen`, 'none');
    const d = await dispatchScreen(env, o, mergeSha, baseSha);
    if ('exit' in d) return { ...d, lines: [...lines, ...d.lines] };
    choice = d.choice;
    lines.push(d.line);
  }
  lines.splice(1, 0, `screen: ${choice.choice}${choice.policy ? ` policy=${choice.policy} nonce=${choice.nonce} run=${choice.run ?? '-'}` : ''}`);
  const now = nowIso();
  const readyAt = loadReady(env.repo.key, o.pr, head)?.ready_at ?? now;
  const receipt: ReadyReceipt = { schema: 1, kind: 'ready', repo_key: env.repo.key, pr: o.pr, head, base_sha: baseSha, ready_at: readyAt, screen: choice, updated_at: now };
  if (o.dryRun) return outOk([...lines, 'DRY-RUN: no READY receipt written, nothing dispatched'], `${Q} ready --pr ${o.pr} --${o.screen}${o.broad ? ' --broad' : ''}`, 'none');
  const p = persist(ctx.repoRoot, [receipt], { remote: env.remote });
  lines.push(`READY_RECEIPT: ${readyPath(env.repo.key, o.pr, head)} (${p.detail})`);
  return outOk(lines, `send the READY block; the coordinator builds the train: ${Q} train build --prs ${o.pr}@${head},...`, readyPath(env.repo.key, o.pr, head));
}
