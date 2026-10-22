/**
 * `verify --pr <n> --train <nonce>`: the coordinator's merge check under
 * merge trains (docs/ship-policy.md#run-a-merge-train; plan GSTA-49 T1, P1).
 *
 * Each merge needs a green train record that includes the PR at its pinned
 * head, or at a head whose tree is the slot's prefix after it modulo stamps
 * (from slot 2 on, the lane merges main into its pin so GitHub can merge it),
 * with main's tree equal to the prefix before the PR (pre-merge:
 * MERGE_CONDITION) or after it (post-merge confirmation), modulo stamps
 * (lib/tree-receipt.ts). When a train stops partway (a mismatch or a moved
 * head after earlier slots merged) the queue freezes: the freeze is written
 * locally and to the notes ref first, then the backstop gate is dispatched on
 * main's published prefix at once. One repair train is admitted under the
 * freeze; verify clears the freeze when main after that merge carries it.
 */
import { randomBytes } from 'node:crypto';
import { DISPATCH_INPUTS, awaitNonceRun, dispatchWorkflow, makeNonce } from '../scripts/eval-bg';
import type { QueueContext } from './ship-queue';
import { git } from './ship-queue-gate';
import { checkRun, execFor, repoSlug } from './ship-queue-train-github';
import { activeFreeze, attemptsOf, nowIso, persist, trainFile, type FreezeRecord, type TrainRecord } from './ship-queue-train-record';
import {
  effect, fetchBase, fetchTrainBranch, findTrain, frozenLines, nextFor, outFailed, outOk, outRefused, pinList, save, trainEnv, type TrainEnv, type TrainOut,
} from './ship-queue-train';
import { buildReceipt } from './tree-receipt';

const Q = 'gstack-ship-queue';

function sameModuloStamps(env: TrainEnv, gated: string, current: string): { same: boolean; detail: string } {
  const r = buildReceipt({ repoRoot: env.ctx.repoRoot, gated, current, policy: env.policy.policy, policyLabel: env.policy.source.label });
  if ('error' in r) return { same: false, detail: r.error };
  return { same: r.tree === 'same-modulo-stamps', detail: r.tree === 'same-modulo-stamps' ? `same modulo stamps (${r.files.length} stamp file(s))` : `differs: ${r.residual.slice(0, 8).join(', ')}` };
}

/**
 * Freeze the queue: the record goes to local state and the notes ref before
 * anything remote, then the backstop gate is dispatched on main's sha.
 */
async function freezeQueue(env: TrainEnv, t: TrainRecord, reason: string, mainSha: string): Promise<FreezeRecord> {
  const now = nowIso();
  const f: FreezeRecord = {
    schema: 1, kind: 'freeze', repo_key: env.repo.key, train: t.nonce, merged: t.merged.map(m => m.pr),
    unmerged: t.slots.filter(s => !t.merged.some(m => m.pr === s.pr)).map(s => ({ pr: s.pr, head: s.head })),
    main: { sha: mainSha, tree: git(env.ctx.repoRoot, ['rev-parse', `${mainSha}^{tree}`]).out }, reason, backstop: null, repair: null,
    created_at: now, cleared_at: null, cleared_by: null, updated_at: now,
  };
  persist(env.ctx.repoRoot, [f], { remote: env.remote });
  effect(t, `queue frozen: ${reason}`);
  save(env, t);
  const slug = repoSlug(env.ctx);
  const nonce = makeNonce('gate', mainSha, mainSha, randomBytes(3).toString('hex'), { purpose: 'backstop' });
  const dispatch = { workflow: env.train.gate_workflow, inputs: { [DISPATCH_INPUTS.evalsAll]: 'true', [DISPATCH_INPUTS.expectedSha]: mainSha, [DISPATCH_INPUTS.nonce]: nonce } };
  const exec = execFor(env.ctx);
  const found = slug && dispatchWorkflow(dispatch, env.ctx.base, exec, slug) ? await awaitNonceRun(dispatch.workflow, nonce, exec, slug) : null;
  f.backstop = { nonce, run: found?.databaseId ?? null, state: found ? 'dispatched' : 'unconfirmed' };
  f.updated_at = nowIso();
  persist(env.ctx.repoRoot, [f], { remote: env.remote });
  return f;
}

/** Interrupted publication: freeze when earlier slots merged; otherwise a plain refusal (nothing was published). */
async function stopped(env: TrainEnv, t: TrainRecord, code: 'QUEUE_TRAIN_TREE_MISMATCH' | 'QUEUE_TRAIN_MOVED', message: string, mainSha: string, lines: string[]): Promise<TrainOut> {
  const run = trainFile(t.nonce);
  if (!t.merged.length) return outFailed({ code, message: `${message}; nothing of train ${t.nonce} merged, so the queue is not frozen` }, lines, `${Q} train build --prs ${pinList(t.slots)} (a new train on current main)`, run);
  const f = activeFreeze(env.repo.key) ?? await freezeQueue(env, t, message, mainSha);
  return outFailed({ code, message: `${message}; the queue is frozen` }, [...lines, ...frozenLines(f)], `${Q} train build --repair --prs <repair-pr>@<sha>`, run);
}

export async function verifyTrain(ctx: QueueContext, o: { pr: string; train: string; noFetch: boolean }): Promise<TrainOut> {
  const fetchErr = o.noFetch ? null : fetchBase(ctx);
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  if (fetchErr) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: fetchErr }, [], 'none', 'none');
  const t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const i = t.slots.findIndex(s => s.pr === o.pr);
  if (i < 0) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} does not include #${o.pr}` }, [], nextFor(t), run);
  const gate = attemptsOf(t).filter(a => a.purpose !== 'bisect').at(-1);
  if (gate?.outcome !== 'GREEN' || !['green', 'merging', 'merged'].includes(t.state)) {
    return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} has no green record (state ${t.state}, last gate ${gate?.outcome ?? 'none'})` }, [], nextFor(t), run);
  }
  const check = checkRun(ctx, t.head, env.train.full_gate_check);
  if (check?.conclusion !== 'success') return outRefused({ code: 'QUEUE_GATE_MISSING', message: `no successful ${env.train.full_gate_check} check run on the train head ${t.head.slice(0, 12)}` }, [], `${Q} train verdict --train ${t.nonce}`, run);
  if (!fetchTrainBranch(env, t)) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the train's prefix commits are not here and ${t.branch} could not be fetched` }, [], `${Q} train status --train ${t.nonce}`, run);
  const main = git(ctx.repoRoot, ['rev-parse', `${env.remote}/${ctx.base}`]).out;
  const freeze = activeFreeze(env.repo.key);
  if (freeze && freeze.repair?.train !== t.nonce) return outRefused({ code: 'QUEUE_TRAIN_FROZEN', message: `the queue is frozen (${freeze.reason}); only the admitted repair train merges` }, frozenLines(freeze), `${Q} train build --repair --prs <repair-pr>@<sha>`, run);
  const after = t.prefixes[i + 1]!;
  const before = t.prefixes[i]!;
  const post = sameModuloStamps(env, after.commit, main);
  const lines = [`TRAIN: ${t.nonce} slot ${i + 1}/${t.slots.length} #${o.pr} pinned ${t.slots[i]!.head}`];
  if (post.same) return confirmMerged(env, t, o.pr, main, after.index, [...lines, `main: ${main} = T${after.index} (${post.detail})`]);
  const pre = sameModuloStamps(env, before.commit, main);
  if (!pre.same) {
    return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `main ${main.slice(0, 12)} is neither T${before.index} nor T${after.index} modulo stamps (vs T${after.index}: ${post.detail})`, main, lines);
  }
  const headRef = o.noFetch ? '' : (git(ctx.repoRoot, ['fetch', '--no-tags', '-q', env.remote, `+refs/pull/${o.pr}/head:refs/gstack/queue/pr-${o.pr}`]).ok ? `refs/gstack/queue/pr-${o.pr}` : '');
  const head = headRef ? git(ctx.repoRoot, ['rev-parse', headRef]).out : t.slots[i]!.head;
  const pinned = head === t.slots[i]!.head ? { same: true, detail: 'the pinned head' } : sameModuloStamps(env, t.slots[i]!.head, head);
  const asPrefix = pinned.same ? null : sameModuloStamps(env, after.commit, head);
  const stampOnly = asPrefix?.same ? { same: true, detail: `T${after.index} with main merged in, ${asPrefix.detail}` } : pinned;
  if (!stampOnly.same) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr} moved past its pinned head ${t.slots[i]!.head.slice(0, 12)} and is not T${after.index} modulo stamps (${head.slice(0, 12)}: ${pinned.detail})`, main, lines);
  return outOk([...lines, `main: ${main} = T${before.index} (${pre.detail})`, `head: ${head} (${stampOnly.detail})`,
    `VERIFY_TRAIN: #${o.pr} may merge as slot ${i + 1} of train ${t.nonce} (green run ${gate.run?.id ?? '-'}, ${env.train.full_gate_check} success)`, `MERGE_CONDITION: sha=${head}`],
  `merge #${o.pr} with expected head ${head.slice(0, 12)} (gstack-restamp stamps at merge), then ${Q} verify --pr ${o.pr} --train ${t.nonce}`, run);
}

function confirmMerged(env: TrainEnv, t: TrainRecord, pr: string, main: string, index: number, lines: string[]): TrainOut {
  const run = trainFile(t.nonce);
  if (!t.merged.some(m => m.pr === pr)) t.merged.push({ pr, sha: main, tree: git(env.ctx.repoRoot, ['rev-parse', `${main}^{tree}`]).out, at: nowIso() });
  t.state = t.merged.length === t.slots.length ? 'merged' : 'merging';
  effect(t, `verified #${pr} merged as T${index}`);
  save(env, t);
  lines.push(`VERIFY_TRAIN: #${pr} merged; main's tree is T${index} of train ${t.nonce} (${t.merged.length}/${t.slots.length} merged)`);
  const freeze = activeFreeze(env.repo.key);
  if (freeze && freeze.repair?.train === t.nonce && t.state === 'merged') {
    freeze.cleared_at = nowIso();
    freeze.cleared_by = `repair #${pr} via train ${t.nonce}; main ${main.slice(0, 12)} carries a green record`;
    freeze.updated_at = freeze.cleared_at;
    persist(env.ctx.repoRoot, [freeze], { remote: env.remote });
    lines.push(`FREEZE: cleared (${freeze.cleared_by})`);
    return outOk(lines, freeze.unmerged.length ? `${Q} train build --prs ${pinList(freeze.unmerged)}` : 'none', run);
  }
  return outOk(lines, nextFor(t), run);
}
