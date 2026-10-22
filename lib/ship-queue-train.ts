/**
 * Merge trains for gstack-ship-queue (docs/ship-policy.md#run-a-merge-train;
 * plan GSTA-49 lane T1): `train build`, `train status` and `train prune`,
 * plus the pieces the verdict, bisect, rebuild and verify modules share.
 * The surface is active only when the base revision's ship policy declares a
 * `train` block (QUEUE_TRAIN_OFF otherwise).
 *
 * A train is main plus each READY PR's pinned, unstamped head merged in slot
 * order. The merges run in object storage (`git merge-tree --write-tree`, the
 * gate-ahead merge rules: version files take the earlier prefix, the
 * CHANGELOG merges by section), so each prefix T0..Tk is a commit with a
 * fixed identity and date and the same pins always give the same train head.
 * Records (lib/ship-queue-train-record.ts) are written before every remote
 * effect: the branch push, the free-tests dispatch, the paid dispatch through
 * scripts/eval-bg.ts's nonce.
 */
import { randomBytes } from 'node:crypto';
import { DISPATCH_INPUTS, awaitNonceRun, dispatchWorkflow, listDispatchRuns, makeNonce, runForNonce, type WorkflowDispatch } from '../scripts/eval-bg';
import { mergeChangelogs, parseChangelog, type ChangelogSection } from './changelog-check';
import type { ResultStatus } from './headless-artifacts';
import { versionAtRef, versionFiles } from './restamp';
import type { LoadedPolicy, ShipPolicy, TrainPolicy } from './ship-policy';
import { loadBasePolicy, type QueueContext } from './ship-queue';
import { git, sha256, withIndex, type QueueFailure } from './ship-queue-gate';
import { asRun, execFor, newestBranchRun, prInfo, remoteBranchSha, repoSlug, runView, checkRun } from './ship-queue-train-github';
import {
  TERMINAL_STATES, activeFreeze, attemptsOf, listTrains, loadBisect, loadReady, loadTrain, nowIso, persist, rebuildFromNotes, repoIdentity, trainFile,
  type AttemptPurpose, type AttemptRecord, type TrainRecord, type TrainSlot,
} from './ship-queue-train-record';

export interface TrainOut { exit: number; status: ResultStatus; lines: string[]; next: string; failure?: QueueFailure; run: string }
export const outOk = (lines: string[], next: string, run: string): TrainOut => ({ exit: 0, status: 'complete', lines, next, run });
export const outRefused = (failure: QueueFailure, lines: string[], next: string, run: string): TrainOut => ({ exit: 3, status: 'refused', lines, next, failure, run });
export const outFailed = (failure: QueueFailure, lines: string[], next: string, run: string): TrainOut => ({ exit: 1, status: 'refused', lines, next, failure, run });
export const outPending = (failure: QueueFailure, lines: string[], next: string, run: string): TrainOut => ({ exit: 3, status: 'incomplete', lines, next, failure, run });

export interface TrainEnv { ctx: QueueContext; policy: LoadedPolicy; train: TrainPolicy; repo: { key: string; url: string }; remote: string }

const HEX = /^[0-9a-f]{40,64}$/;
const Q = 'gstack-ship-queue';

/** The policy gate: the base revision's ship policy must declare a `train` block. */
export function trainEnv(ctx: QueueContext): TrainEnv | QueueFailure {
  const policy = loadBasePolicy(ctx);
  if ('message' in policy) return policy;
  if (!policy.policy.train) return { code: 'QUEUE_TRAIN_OFF', message: `${policy.source.label} declares no train block; the per-PR queue applies` };
  return { ctx, policy, train: policy.policy.train, repo: repoIdentity(ctx.repoRoot), remote: ctx.remote ?? 'origin' };
}

export function fetchBase(ctx: QueueContext): string | null {
  const remote = ctx.remote ?? 'origin';
  const f = git(ctx.repoRoot, ['fetch', '--no-tags', '-q', remote, `+refs/heads/${ctx.base}:refs/remotes/${remote}/${ctx.base}`]);
  return f.ok ? null : `git fetch ${remote} ${ctx.base} failed: ${f.err.slice(0, 160)}`;
}

/** Make the train's prefix commits local (another machine built them): fetch train/<nonce>. */
export function fetchTrainBranch(env: TrainEnv, train: TrainRecord): string | null {
  if (git(env.ctx.repoRoot, ['cat-file', '-e', `${train.head}^{commit}`]).ok) return train.head;
  const f = git(env.ctx.repoRoot, ['fetch', '--no-tags', '-q', env.remote, `+refs/heads/${train.branch}:refs/gstack/${train.branch}`]);
  return f.ok ? git(env.ctx.repoRoot, ['rev-parse', `refs/gstack/${train.branch}`]).out : null;
}

/** A train record from local state, or from the notes ref when this machine has none. */
export function findTrain(env: TrainEnv, nonce: string): TrainRecord | null {
  const local = loadTrain(nonce);
  if (local) return local;
  rebuildFromNotes(env.ctx.repoRoot, env.remote);
  return loadTrain(nonce);
}

export const touch = <T extends { updated_at: string }>(r: T): T => { r.updated_at = nowIso(); return r; };

export function effect(train: TrainRecord, what: string): void {
  train.effects.push({ at: nowIso(), what });
}

/** Save the train (and any attempt) locally and to the notes ref; a failed notes push is recorded as an effect, never hidden. */
export function save(env: TrainEnv, train: TrainRecord, ...extra: AttemptRecord[]): string {
  touch(train);
  for (const a of extra) touch(a);
  const r = persist(env.ctx.repoRoot, [train, ...extra], { remote: env.remote });
  if (!r.pushed) { effect(train, `notes not pushed: ${r.detail}`); persist(env.ctx.repoRoot, [train], { push: false }); }
  return r.detail;
}

export function parsePins(spec: string | undefined): Array<{ pr: string; sha: string }> | string {
  if (!spec) return 'needs --prs <n>@<sha>[,<n>@<sha>...]';
  const pins = spec.split(',').map(s => s.trim()).filter(Boolean).map(s => /^#?(\d+)@([0-9a-f]{7,64})$/.exec(s));
  if (!pins.length || pins.some(m => !m)) return `--prs entries are <pr>@<sha> (got ${spec})`;
  const out = pins.map(m => ({ pr: m![1]!, sha: m![2]! }));
  return new Set(out.map(p => p.pr)).size === out.length ? out : 'a PR appears twice in --prs';
}

export const pinList = (slots: Array<{ pr: string; head: string }>) => slots.map(s => `${s.pr}@${s.head}`).join(',');

/** Slot order: screened PRs first, then unscreened, each in READY order; enough unscreened PRs form their own train. */
export function orderSlots(slots: TrainSlot[], max: number): { train: TrainSlot[]; held: TrainSlot[]; split: boolean } {
  const byReady = (a: TrainSlot, b: TrainSlot) => a.ready_at.localeCompare(b.ready_at) || Number(a.pr) - Number(b.pr);
  const screened = slots.filter(s => s.screen.choice === 'screen').sort(byReady);
  const unscreened = slots.filter(s => s.screen.choice !== 'screen').sort(byReady);
  if (screened.length && unscreened.length >= max) return { train: screened.slice(0, max), held: [...screened.slice(max), ...unscreened], split: true };
  const all = [...screened, ...unscreened];
  return { train: all.slice(0, max), held: all.slice(max), split: false };
}

/** When a train under its size may dispatch: its oldest READY plus the fill time; null when it may dispatch now. */
export function fillDue(slots: TrainSlot[], train: TrainPolicy, now: string, urgent: boolean): string | null {
  if (urgent || slots.length >= train.max_size) return null;
  const oldest = Math.min(...slots.map(s => Date.parse(s.ready_at)));
  const due = oldest + train.fill_hours * 3_600_000;
  return Date.parse(now) >= due ? null : new Date(due).toISOString();
}

function unionChangelog(ours: string, theirs: string): string {
  const a = parseChangelog(ours);
  const b = parseChangelog(theirs);
  const entry = (s: ChangelogSection) => s.lines.slice(1).join('\n').replace(/\n+$/, '');
  const known = new Set(b.sections.map(entry));
  const header = [...b.header];
  while (header.length && header[header.length - 1] === '') header.pop();
  const body = [...a.sections.filter(s => !known.has(entry(s))), ...b.sections].flatMap(s => {
    const lines = [...s.lines];
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return [...lines, ''];
  });
  return [...header, ...(header.length ? [''] : []), ...body].join('\n').replace(/\n+$/, '\n');
}

/**
 * One train merge, in object storage: the PR head onto the previous prefix.
 * Version files take the prefix's side; the CHANGELOG merges by section (the
 * gate-ahead rule, else a union of sections, since each heading is restamped
 * at merge). Any other conflict is reported with every conflicting path.
 */
export function mergeStep(repoRoot: string, pred: string, head: string, policy: ShipPolicy): { tree: string } | { conflicts: string[] } {
  const r = git(repoRoot, ['merge-tree', '--write-tree', head, pred]);
  const lines = r.out.split('\n');
  const tree = lines[0]?.trim() ?? '';
  if (r.status === 0 && HEX.test(tree)) return { tree };
  if (r.status !== 1 || !HEX.test(tree)) return { conflicts: [`(git merge-tree failed: ${(r.err || r.out).slice(0, 120)})`] };
  const stages = new Map<string, Map<number, string>>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/.exec(line);
    if (!m) continue;
    const entry = stages.get(m[4]!) ?? new Map<number, string>();
    entry.set(Number(m[3]), m[2]!);
    stages.set(m[4]!, entry);
  }
  const at = versionAtRef(repoRoot, pred);
  const stampFiles = versionFiles(repoRoot, 'rel' in at ? at.rel : 'VERSION');
  const resolved: Array<{ path: string; blob: string }> = [];
  const conflicts: string[] = [];
  for (const [file, entry] of stages) {
    const ours = entry.get(2);
    const theirs = entry.get(3);
    if (!ours || !theirs) conflicts.push(file);
    else if (file === policy.changelog) {
      const text = (sha: string) => git(repoRoot, ['cat-file', 'blob', sha]).out + '\n';
      const merged = mergeChangelogs(text(ours), text(theirs)) ?? unionChangelog(text(ours), text(theirs));
      const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], undefined, merged);
      if (blob.ok) resolved.push({ path: file, blob: blob.out }); else conflicts.push(file);
    } else if (stampFiles.includes(file)) resolved.push({ path: file, blob: theirs });
    else conflicts.push(file);
  }
  if (conflicts.length) return { conflicts: conflicts.sort() };
  const out = withIndex<{ tree: string } | { error: string }>(repoRoot, tree, index => {
    for (const { path: p, blob } of resolved) {
      const mode = git(repoRoot, ['ls-tree', tree, '--', p], index).out.split(/\s/)[0] || '100644';
      if (!git(repoRoot, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${p}`], index).ok) return { error: `cannot stage ${p}` };
    }
    const w = git(repoRoot, ['write-tree'], index);
    return w.ok ? { tree: w.out } : { error: `write-tree failed: ${w.err}` };
  });
  return 'error' in out ? { conflicts: [`(${out.error})`] } : { tree: out.tree };
}

const TRAIN_IDENTITY = { GIT_AUTHOR_NAME: 'gstack-ship-queue', GIT_AUTHOR_EMAIL: 'ship-queue@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-queue',
  GIT_COMMITTER_EMAIL: 'ship-queue@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };

/** Build T1..Tk on T0 = base; a conflict stops at the PR that conflicts. */
export function buildChain(repoRoot: string, baseSha: string, slots: TrainSlot[], policy: ShipPolicy):
  { prefixes: TrainRecord['prefixes'] } | { stoppedAt: string; conflicts: string[]; merged: string[] } {
  const prefixes: TrainRecord['prefixes'] = [{ index: 0, commit: baseSha, tree: git(repoRoot, ['rev-parse', `${baseSha}^{tree}`]).out, pr: null }];
  for (const [i, slot] of slots.entries()) {
    const pred = prefixes[i]!.commit;
    const m = mergeStep(repoRoot, pred, slot.head, policy);
    if ('conflicts' in m) return { stoppedAt: slot.pr, conflicts: m.conflicts, merged: slots.slice(0, i).map(s => s.pr) };
    const c = git(repoRoot, ['commit-tree', m.tree, '-p', pred, '-p', slot.head, '-m', `train T${i + 1}: merge #${slot.pr} at ${slot.head.slice(0, 12)}`], { ...process.env, ...TRAIN_IDENTITY });
    if (!c.ok) return { stoppedAt: slot.pr, conflicts: [`(commit-tree failed: ${c.err.slice(0, 120)})`], merged: slots.slice(0, i).map(s => s.pr) };
    prefixes.push({ index: i + 1, commit: c.out, tree: m.tree, pr: slot.pr });
  }
  return { prefixes };
}

/** NEXT for a train in its current state. */
export function nextFor(t: TrainRecord): string {
  const n = t.nonce;
  const unmerged = t.slots.filter(s => !t.merged.some(m => m.pr === s.pr));
  switch (t.state) {
    case 'built': case 'pushed': case 'free-pending': case 'free-green': case 'dispatch-absent': return `${Q} train build --train ${n}`;
    case 'dispatch-unknown': return `${Q} train status --train ${n}`;
    case 'gate-pending': return `${Q} train verdict --train ${n}`;
    case 'green': case 'merging': return unmerged.length ? `${Q} verify --pr ${unmerged[0]!.pr} --train ${n}` : `${Q} train prune --train ${n}`;
    case 'red': return `${Q} train bisect --train ${n} --spend-cap <usd>`;
    case 'incomplete': return `${Q} train verdict --train ${n}`;
    case 'attributed': {
      const drop = loadBisect(n)?.outcome?.prs ?? [];
      const keep = t.slots.filter(s => !drop.includes(s.pr));
      return keep.length ? `${Q} train build --prs ${pinList(keep)}` : 'none (every PR was dropped)';
    }
    case 'red-on-main': return `fix forward on main first, then ${Q} train build --prs ${pinList(t.slots)}`;
    case 'unattributed': return loadBisect(n)?.outcome?.all_green && !attemptsOf(t).some(a => a.purpose === 'rebuild')
      ? `${Q} train rebuild --train ${n}`
      : `route the red cases to a repair lane (GStack Minder); once the repair merges: ${Q} train build --prs ${pinList(t.slots)}`;
    default: return `${Q} train prune --train ${n}`;
  }
}

export function attemptId(train: TrainRecord, purpose: AttemptPurpose): string {
  const bisect = purpose === 'bisect';
  return `${bisect ? 'b' : 'a'}${train.attempts.filter(id => id.startsWith(bisect ? 'b' : 'a')).length + 1}`;
}

/**
 * Record an attempt as dispatching (locally and in the notes ref), dispatch
 * through eval-bg, then find the run by its nonce. A failed or unconfirmed
 * dispatch is `unknown`: train status reconciles it, nothing re-dispatches it.
 */
export async function dispatchAttempt(env: TrainEnv, slug: string, train: TrainRecord, purpose: AttemptPurpose, dispatch: WorkflowDispatch, prefixes: number[] = []): Promise<AttemptRecord> {
  const now = nowIso();
  const attempt: AttemptRecord = {
    schema: 1, kind: 'train-attempt', train: train.nonce, id: attemptId(train, purpose), purpose, nonce: dispatch.inputs[DISPATCH_INPUTS.nonce]!,
    workflow: dispatch.workflow, ref: train.branch, inputs: dispatch.inputs, state: 'dispatching', run: null, outcome: null, detail: null,
    red_cases: [], panels: [], infra_eligible: false, cost_usd: null, prefixes, created_at: now, updated_at: now,
  };
  train.attempts.push(attempt.id);
  save(env, train, attempt);
  const exec = execFor(env.ctx);
  const found = dispatchWorkflow(dispatch, train.branch, exec, slug) ? await awaitNonceRun(dispatch.workflow, attempt.nonce, exec, slug) : null;
  attempt.state = found ? 'dispatched' : 'unknown';
  attempt.run = found ? asRun(found) : null;
  effect(train, found ? `${purpose} dispatched: ${dispatch.workflow} run ${found.databaseId} (nonce ${attempt.nonce})` : `${purpose} dispatch unconfirmed (nonce ${attempt.nonce})`);
  save(env, train, attempt);
  return attempt;
}

export function gateDispatch(env: TrainEnv, train: TrainRecord, nonce: string): WorkflowDispatch {
  return { workflow: env.train.gate_workflow, inputs: { [DISPATCH_INPUTS.evalsAll]: 'true', [DISPATCH_INPUTS.expectedSha]: train.head, [DISPATCH_INPUTS.nonce]: nonce } };
}

export interface BuildOptions { pins?: string; resume?: string; dryRun: boolean; urgent: boolean; repair: boolean; freeTimeoutSec: number; pollMs: number }

/** The slots a new train would carry: trusted, unmoved, READY PRs, in slot order. */
function admitSlots(env: TrainEnv, pins: Array<{ pr: string; sha: string }>): { slots: TrainSlot[]; lines: string[] } | TrainOut {
  const { ctx } = env;
  const specs = pins.map(p => `+refs/pull/${p.pr}/head:refs/gstack/train/pr-${p.pr}`);
  const f = git(ctx.repoRoot, ['fetch', '--no-tags', '-q', env.remote, ...specs]);
  if (!f.ok) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `git fetch of the PR heads failed: ${f.err.slice(0, 160)}` }, [], 'none', 'none');
  const slots: TrainSlot[] = [];
  for (const p of pins) {
    const info = prInfo(ctx, p.pr);
    if ('error' in info) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: info.error }, [], 'none', 'none');
    const without = pinList(pins.filter(x => x.pr !== p.pr).map(x => ({ pr: x.pr, head: x.sha })));
    if (info.isCrossRepository) return outRefused({ code: 'QUEUE_TRAIN_UNTRUSTED', message: `PR #${p.pr}'s head repository is not the base repository; fork work stays on the trusted-branch path` }, [], without ? `${Q} train build --prs ${without}` : 'none', 'none');
    const fetched = git(ctx.repoRoot, ['rev-parse', `refs/gstack/train/pr-${p.pr}`]).out;
    if (!info.headRefOid.startsWith(p.sha) || fetched !== info.headRefOid) {
      return outRefused({ code: 'QUEUE_TRAIN_MOVED', message: `PR #${p.pr} moved: pinned ${p.sha.slice(0, 12)}, head is now ${info.headRefOid.slice(0, 12)}` }, [], `ask #${p.pr}'s lane for READY on ${info.headRefOid.slice(0, 12)}, then ${Q} train build --prs <pins>`, 'none');
    }
    const ready = loadReady(env.repo.key, p.pr, info.headRefOid);
    if (!ready) return outRefused({ code: 'QUEUE_NOT_READY', message: `no READY receipt for #${p.pr} at ${info.headRefOid.slice(0, 12)} (local state or ${'refs/notes/gstack-trains'})` }, [], `the lane runs ${Q} ready --pr ${p.pr} --screen|--no-screen`, 'none');
    slots.push({ pr: p.pr, head: info.headRefOid, ready_at: ready.ready_at, screen: ready.screen });
  }
  return { slots, lines: [] };
}

/** Start a new train from --prs, or find the live train with the same pins and base. */
async function newTrain(env: TrainEnv, o: BuildOptions): Promise<{ t: TrainRecord; lines: string[] } | TrainOut> {
  const pins = parsePins(o.pins);
  if (typeof pins === 'string') return outRefused({ code: 'QUEUE_PROOF_MISSING', message: pins }, [], 'none', 'none');
  if ((o.urgent || o.repair) && pins.length !== 1) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `${o.repair ? '--repair' : '--urgent'} admits exactly one PR` }, [], 'none', 'none');
  rebuildFromNotes(env.ctx.repoRoot, env.remote);
  const freeze = activeFreeze(env.repo.key);
  if (freeze && !o.repair) return outRefused({ code: 'QUEUE_TRAIN_FROZEN', message: `the queue is frozen since ${freeze.created_at}: train ${freeze.train} stopped after merging ${freeze.merged.map(p => '#' + p).join(',')} (${freeze.reason})` },
    frozenLines(freeze), `${Q} train build --repair --prs <repair-pr>@<sha>`, 'none');
  const admitted = admitSlots(env, pins);
  if ('exit' in admitted) return admitted;
  const order = orderSlots(admitted.slots, o.repair ? 1 : env.train.max_size);
  const lines = [
    `ORDER: ${order.train.map((s, i) => `${i + 1}:#${s.pr}(${s.screen.choice === 'screen' ? 'screened' : 'unscreened'})`).join(' ')}`,
    ...(order.held.length ? [`HELD: ${order.held.map(s => '#' + s.pr).join(',')} (${order.split ? 'unscreened PRs form their own train' : `over the train size ${env.train.max_size}`})`] : []),
  ];
  const due = fillDue(order.train, env.train, nowIso(), o.urgent || o.repair);
  if (due && !o.dryRun) return outPending({ code: 'QUEUE_TRAIN_WAITING', message: `${order.train.length} of ${env.train.max_size} PRs; the oldest READY dispatches at ${due}` }, lines, `${Q} train build --prs ${pinList(order.train)} (after ${due}, or with more PRs, or --urgent for one)`, 'none');
  const baseSha = git(env.ctx.repoRoot, ['rev-parse', `${env.remote}/${env.ctx.base}`]).out;
  const key = sha256(JSON.stringify({ base: baseSha, slots: order.train.map(s => `${s.pr}@${s.head}`) }));
  const live = listTrains(env.repo.key).find(t => t.key === key && !TERMINAL_STATES.includes(t.state) && t.state !== 'red' && t.state !== 'unattributed');
  if (live) return { t: Object.assign(live, { held: order.held.map(s => s.pr) }), lines };
  const chain = buildChain(env.ctx.repoRoot, baseSha, order.train, env.policy.policy);
  if ('stoppedAt' in chain) {
    const without = order.train.filter(s => s.pr !== chain.stoppedAt);
    return outFailed({ code: 'QUEUE_TRAIN_CONFLICT', message: `#${chain.stoppedAt} conflicts with the prefix before it` }, [...lines,
      `QUEUE_TRAIN_CONFLICT: train ${key.slice(0, 12)} stopped at #${chain.stoppedAt} (conflicts: ${chain.conflicts.join(', ')}) after merging ${chain.merged.map(p => '#' + p).join(',') || '(none)'}; nothing dispatched, no branch pushed; fix: ${Q} train build --prs ${pinList(without)}`],
    without.length ? `${Q} train build --prs ${pinList(without)}` : 'none', 'none');
  }
  const head = chain.prefixes.at(-1)!;
  const nonce = makeNonce('gate', head.commit, baseSha, randomBytes(3).toString('hex'), { purpose: 'train' });
  const now = nowIso();
  return { lines, t: {
    schema: 1, kind: 'train', nonce, key, repo_key: env.repo.key, repo: env.repo.url, base: { ref: env.ctx.base, sha: baseSha }, policy: env.policy.source.label,
    slots: order.train, held: order.held.map(s => s.pr), prefixes: chain.prefixes, head: head.commit, tree: head.tree, branch: `train/${nonce}`,
    urgent: o.urgent, repair: o.repair, state: 'built', free: null, attempts: [], merged: [], superseded_by: null, effects: [], error: null,
    created_at: now, updated_at: now,
  } };
}

export function frozenLines(f: NonNullable<ReturnType<typeof activeFreeze>>): string[] {
  return [
    `QUEUE_TRAIN_FROZEN: train ${f.train} merged ${f.merged.map(p => '#' + p).join(',') || '(none)'}; main ${f.main.sha.slice(0, 12)} tree ${f.main.tree.slice(0, 12)}; backstop ${f.backstop ? `${f.backstop.state} run ${f.backstop.run ?? 'unknown'} (nonce ${f.backstop.nonce})` : 'not dispatched'}`,
    `freeze: ${f.reason}; unmerged ${f.unmerged.map(u => '#' + u.pr).join(',') || '(none)'}; repair ${f.repair ? `#${f.repair.pr}@${f.repair.head.slice(0, 12)}` : 'none admitted'}`,
  ];
}

function describe(t: TrainRecord): string[] {
  return [
    `TRAIN: ${t.nonce} state=${t.state} prs=${t.slots.map(s => '#' + s.pr).join(',')} head=${t.head} tree=${t.tree}`,
    `base: origin/${t.base.ref}@${t.base.sha}`,
    ...t.prefixes.map(p => `PREFIX: T${p.index} ${p.commit} tree=${p.tree}${p.pr ? ` (+#${p.pr})` : ' (main)'}`),
    ...t.slots.map((s, i) => `SLOT: ${i + 1} #${s.pr} head=${s.head} ${s.screen.choice === 'screen' ? `screened (${s.screen.policy ?? 'narrow'}${s.screen.run ? `, run ${s.screen.run}` : ''})` : 'unscreened'} ready_at=${s.ready_at}`),
  ];
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Free tests on train/<nonce>: dispatched once, then followed until a verdict on the exact train head. */
async function freePhase(env: TrainEnv, slug: string, t: TrainRecord, o: BuildOptions): Promise<TrainOut | null> {
  if (t.free?.verdict === 'green' && t.free.head_sha === t.head) return null;
  const run = trainFile(t.nonce);
  if (t.state !== 'free-pending') {
    if (!env.ctx.gh(['workflow', 'run', env.train.free_workflow, '--repo', slug, '--ref', t.branch]).ok) {
      t.free = { run: null, url: null, head_sha: null, conclusion: null, verdict: 'missing' };
      t.state = 'free-red';
      effect(t, `${env.train.free_workflow} dispatch refused by gh`);
      save(env, t);
      return outFailed({ code: 'QUEUE_TRAIN_FREE_RED', message: `gh could not dispatch ${env.train.free_workflow} on ${t.branch}` }, describe(t), `${Q} train build --prs ${pinList(t.slots)}`, run);
    }
    t.state = 'free-pending';
    effect(t, `${env.train.free_workflow} dispatched on ${t.branch}`);
    save(env, t);
  }
  const deadline = Date.now() + o.freeTimeoutSec * 1000;
  let found = newestBranchRun(env.ctx, slug, env.train.free_workflow, t.branch);
  while ((found === null || found === 'unreadable' || found.status !== 'completed') && Date.now() < deadline) {
    await sleep(o.pollMs);
    found = newestBranchRun(env.ctx, slug, env.train.free_workflow, t.branch);
  }
  if (found && found !== 'unreadable' && found.status !== 'completed') {
    t.free = { run: found.databaseId, url: found.url, head_sha: found.headSha, conclusion: null, verdict: 'pending' };
    save(env, t);
    return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `free tests run ${found.databaseId} on ${t.branch} is still ${found.status}` }, describe(t), `${Q} train build --train ${t.nonce}`, run);
  }
  const r = found && found !== 'unreadable' ? found : null;
  const verdict = !r ? 'missing' : r.event !== 'workflow_dispatch' || r.headSha !== t.head ? 'stale' : r.conclusion === 'success' ? 'green' : r.conclusion === 'cancelled' ? 'cancelled' : 'red';
  t.free = { run: r?.databaseId ?? null, url: r?.url ?? null, head_sha: r?.headSha ?? null, conclusion: r?.conclusion ?? null, verdict };
  t.state = verdict === 'green' ? 'free-green' : 'free-red';
  save(env, t);
  if (verdict === 'green') return null;
  const why = verdict === 'missing' ? `no ${env.train.free_workflow} dispatch run appeared on ${t.branch}`
    : verdict === 'stale' ? `run ${r!.databaseId} tested ${(r!.headSha || '?').slice(0, 12)} (${r!.event}), not the train head ${t.head.slice(0, 12)}`
    : `run ${r!.databaseId} concluded ${r!.conclusion}`;
  return outFailed({ code: 'QUEUE_TRAIN_FREE_RED', message: `free tests ${verdict}: ${why}` }, [...describe(t), `FREE: ${verdict} ${r?.url ?? ''}`.trim()],
    `read the free-tests run; drop a PR that caused it: ${Q} train build --prs <pins without it>`, run);
}

/** Push the branch, gate it with the free tests, then dispatch the paid gate once. */
async function advance(env: TrainEnv, t: TrainRecord, o: BuildOptions, lines: string[]): Promise<TrainOut> {
  const run = trainFile(t.nonce);
  const slug = repoSlug(env.ctx);
  if (!slug) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, lines, `${Q} train build --train ${t.nonce}`, run);
  if (t.state === 'built') {
    const p = git(env.ctx.repoRoot, ['push', '-q', env.remote, `${t.head}:refs/heads/${t.branch}`]);
    if (!p.ok) { t.error = `branch push failed: ${p.err.slice(0, 160)}`; save(env, t); return outRefused({ code: 'QUEUE_PROOF_MISSING', message: t.error }, lines, `${Q} train build --train ${t.nonce}`, run); }
    t.state = 'pushed';
    effect(t, `branch pushed: ${t.branch} at ${t.head.slice(0, 12)}`);
    save(env, t);
  }
  const free = await freePhase(env, slug, t, o);
  if (free) return { ...free, lines: [...lines, ...free.lines] };
  if (t.state === 'dispatch-unknown') return outPending({ code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `the gate dispatch for ${t.nonce} is unconfirmed` }, [...lines, ...describe(t)], `${Q} train status --train ${t.nonce}`, run);
  if (t.state === 'free-green' || t.state === 'dispatch-absent') {
    const prior = attemptsOf(t).filter(a => a.purpose === 'gate');
    const nonce = prior.at(-1)?.state === 'absent' ? prior.at(-1)!.nonce : t.nonce;
    const a = await dispatchAttempt(env, slug, t, 'gate', gateDispatch(env, t, nonce));
    t.state = a.state === 'dispatched' ? 'gate-pending' : 'dispatch-unknown';
    save(env, t);
    if (a.state !== 'dispatched') return outPending({ code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `no ${a.workflow} run named ${a.nonce} appeared after the dispatch` }, [...lines, ...describe(t)], `${Q} train status --train ${t.nonce}`, run);
  }
  const gate = attemptsOf(t).filter(a => a.purpose !== 'bisect').at(-1);
  return outOk([...lines, ...describe(t), `FREE: green run ${t.free?.run ?? '?'} on ${t.head.slice(0, 12)}`,
    `GATE: ${gate?.workflow ?? env.train.gate_workflow} run ${gate?.run?.id ?? '?'} ${gate?.run?.url ?? ''} nonce ${gate?.nonce ?? t.nonce}`.trim(), `record: ${run}`], nextFor(t), run);
}

/** `train build`: admit, order, merge, record, push, free tests, dispatch; `--dry-run` spends nothing and writes nothing. */
export async function buildTrain(ctx: QueueContext, o: BuildOptions): Promise<TrainOut> {
  const fetchErr = fetchBase(ctx);
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  if (fetchErr) return outRefused({ code: 'POLICY_SOURCE_UNAVAILABLE', message: fetchErr }, [], 'none', 'none');
  let t: TrainRecord | TrainOut;
  let lines: string[] = [];
  if (o.resume) {
    t = findTrain(env, o.resume) ?? outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.resume} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
    if ('kind' in t && TERMINAL_STATES.includes(t.state)) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `train ${t.nonce} is ${t.state}; it never dispatches again` }, describe(t), nextFor(t), trainFile(t.nonce));
    if ('kind' in t && t.state !== 'free-pending' && t.state !== 'dispatch-absent' && t.state !== 'dispatch-unknown' && t.state !== 'built' && t.state !== 'pushed' && t.state !== 'free-green') {
      return outOk(describe(t), nextFor(t), trainFile(t.nonce));
    }
  } else {
    const made = await newTrain(env, o);
    if ('exit' in made) return made;
    ({ t, lines } = made);
  }
  if (!('kind' in t)) return t;
  if (o.dryRun) {
    return outOk([...lines, ...describe(t), `ESTIMATE: one ${env.train.gate_workflow} full gate (evals_all) on T${t.prefixes.length - 1} plus ${env.train.free_workflow}; dollar figure pending the T0 cost replay (lib/gate-cost.ts)`,
      'DRY-RUN: nothing written, pushed or dispatched'], `${Q} train build --prs ${pinList(t.slots)}`, 'none');
  }
  if (t.state === 'built' && !t.attempts.length && !loadTrain(t.nonce)) {
    effect(t, 'train.json written');
    save(env, t);
    for (const old of listTrains(env.repo.key)) {
      if (old.nonce === t.nonce || TERMINAL_STATES.includes(old.state) || old.state === 'green' || old.state === 'merging') continue;
      if (!old.slots.some(s => t.slots.some((n: TrainSlot) => n.pr === s.pr))) continue;
      old.state = 'superseded';
      old.superseded_by = t.nonce;
      save(env, old);
    }
    if (o.repair) {
      const f = activeFreeze(env.repo.key)!;
      f.repair = { pr: t.slots[0]!.pr, head: t.slots[0]!.head, train: t.nonce };
      f.updated_at = nowIso();
      persist(env.ctx.repoRoot, [f], { remote: env.remote });
    }
  }
  return advance(env, t, o, lines);
}

/**
 * `train status`: never spends. Rebuilds local records from the notes ref,
 * reconciles each unconfirmed dispatch by its nonce (found, or absent when a
 * full listing shows no such run) and reads run and check state.
 */
export function trainStatus(ctx: QueueContext, o: { train?: string }): TrainOut {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  const restored = rebuildFromNotes(ctx.repoRoot, env.remote);
  const lines = [`NOTES: read ${restored.read} record(s), restored ${restored.restored} (${restored.detail})`];
  const trains = o.train ? [loadTrain(o.train)].filter((t): t is TrainRecord => !!t) : listTrains(env.repo.key).filter(t => !TERMINAL_STATES.includes(t.state));
  if (o.train && !trains.length) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, lines, `${Q} train status`, 'none');
  const slug = trains.length ? repoSlug(ctx) : null;
  const exec = execFor(ctx);
  for (const t of trains) {
    lines.push(...describe(t));
    for (const a of attemptsOf(t)) {
      if (slug && (a.state === 'dispatching' || a.state === 'unknown')) {
        const runs = listDispatchRuns(a.workflow, exec, slug, 100);
        const hit = runs ? runForNonce(runs, a.nonce) : null;
        if (runs) {
          a.state = hit ? 'dispatched' : 'absent';
          a.run = hit ? asRun(hit) : null;
          if (t.state === 'dispatch-unknown') t.state = hit ? (a.purpose === 'bisect' ? 'red' : 'gate-pending') : 'dispatch-absent';
          effect(t, `status reconciled ${a.id} (nonce ${a.nonce}): ${hit ? `run ${hit.databaseId}` : 'absent'}`);
          save(env, t, a);
        }
      }
      const view = slug && a.run && !a.outcome ? runView(ctx, slug, a.run.id) : null;
      lines.push(`ATTEMPT: ${a.id} ${a.purpose} state=${a.state} nonce=${a.nonce} run=${a.run?.id ?? '-'}${view ? ` ${view.status}/${view.conclusion ?? '-'}` : ''} outcome=${a.outcome ?? '-'}`);
    }
    if (slug && (t.state === 'green' || t.state === 'merging')) {
      const c = checkRun(ctx, t.head, env.train.full_gate_check);
      lines.push(`CHECK: ${env.train.full_gate_check} on ${t.head.slice(0, 12)}: ${c ? `${c.status}/${c.conclusion ?? '-'}` : 'missing'}`);
    }
    lines.push(`NEXT(${t.nonce}): ${nextFor(t)}`);
  }
  if (!trains.length) lines.push('TRAIN: none live');
  const freeze = activeFreeze(env.repo.key);
  if (freeze) lines.push(...frozenLines(freeze));
  const single = trains.length === 1 ? trains[0]! : null;
  const next = freeze && !freeze.repair ? `${Q} train build --repair --prs <repair-pr>@<sha>` : single ? nextFor(single) : trains.length ? 'see each NEXT(<nonce>) line' : 'none';
  return outOk(lines, next, single ? trainFile(single.nonce) : 'none');
}

/** `train prune`: delete train/<nonce> on the remote for every finished (merged, superseded, dropped) train. */
export function pruneTrains(ctx: QueueContext, o: { dryRun: boolean; train?: string }): TrainOut {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  rebuildFromNotes(ctx.repoRoot, env.remote);
  const lines: string[] = [];
  const rgit = (args: string[]) => git(ctx.repoRoot, args);
  for (const t of listTrains(env.repo.key).filter(x => !o.train || x.nonce === o.train)) {
    if (!TERMINAL_STATES.includes(t.state)) { lines.push(`KEEP: ${t.branch} (${t.state})`); continue; }
    if (!remoteBranchSha(rgit, env.remote, t.branch)) { lines.push(`GONE: ${t.branch} (${t.state})`); continue; }
    if (o.dryRun) { lines.push(`WOULD-DELETE: ${t.branch} (${t.state})`); continue; }
    const d = git(ctx.repoRoot, ['push', '-q', env.remote, '--delete', `refs/heads/${t.branch}`]);
    lines.push(d.ok ? `DELETED: ${t.branch} (${t.state})` : `FAILED: ${t.branch}: ${d.err.slice(0, 120)}`);
    if (d.ok) { effect(t, `branch deleted: ${t.branch}`); save(env, t); }
  }
  if (!lines.length) lines.push('PRUNE: no trains');
  return outOk(lines, o.dryRun ? `${Q} train prune` : 'none', 'none');
}
