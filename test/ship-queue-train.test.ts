/**
 * Merge trains through the real bin/gstack-ship-queue (plan GSTA-49 lane T1),
 * headless against fixture repos outside the checkout (bare origin, lane and
 * coordinator clones, a hermetic git identity) with a stateful gh shim:
 * build (happy path, CHANGELOG union, conflict, fork, moved head, READY,
 * fill, free tests red/missing/stale/cancelled, dry run, ordering), dispatch
 * recovery (partial and absent dispatches), status rebuilt from
 * refs/notes/gstack-trains on a clean state root, verdict, bisect
 * (monotone, non-monotone, all green, red on main, capped and resumed
 * without repeats, prefix ancestry), rebuild-once and the INFRA
 * re-dispatch, verify (tree equality, mismatch, freeze, repair and clear),
 * prune, ready's screen choice, and the policy gate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { TRAIN_HELP } from '../lib/ship-queue-train-cli';
import { BASE_POLICY, cleanup, runBin } from './helpers/restamp-fixture';
import { coordinatorClone } from './helpers/ship-queue-fixture';
import {
  COMPLETE, FAIL, GREEN_GATE, PASS, RED_GATE, TRAIN_BLOCK, TRAIN_POLICY, dispatches, line, nonceOf, openPr, queue, readyReceipt, repoKey, trainFixture, trainJson,
  type Rule, type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = (policy: Record<string, unknown> = TRAIN_POLICY) => { const f = trainFixture(policy); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const result = (out: string) => line(out, 'GSTACK_RESULT:');
const next = (out: string) => line(out, 'NEXT:');
const remoteRefs = (fx: TrainFixture) => fx.repo.git('ls-remote', 'origin');

function twoPrTrain(fx: TrainFixture, gate: Rule = GREEN_GATE) {
  const h1 = openPr(fx, '1');
  const h2 = openPr(fx, '2');
  readyReceipt(fx, '1', h1);
  readyReceipt(fx, '2', h2);
  fx.write(d => { d.rules['evals.yml'] = gate; });
  const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
  return { h1, h2, r, nonce: nonceOf(r.out) };
}

/** A main commit with a prefix's tree plus a VERSION stamp, the way stamp-at-merge publishes it. */
function publishMain(fx: TrainFixture, prefixCommit: string, version: string, extra?: { file: string; text: string }): string {
  const { repo } = fx;
  repo.git('checkout', '-q', '-B', 'mainsim', 'origin/main');
  repo.git('rm', '-rq', '.');
  repo.git('checkout', prefixCommit, '--', '.');
  fs.writeFileSync(path.join(repo.work, 'VERSION'), version + '\n');
  if (extra) fs.writeFileSync(path.join(repo.work, extra.file), extra.text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `merge to ${version}`);
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  repo.git('fetch', '-q', 'origin');
  return repo.git('rev-parse', 'HEAD');
}

describe('the train command surface', () => {
  test('train with no subcommand (flags only) prints the train help and exits usage; --help exits 0; bad arguments name what is missing', () => {
    const fx = make();
    const bare = queue(fx, ['train']);
    expect([bare.status, bare.out]).toEqual([EXIT.usage, TRAIN_HELP + '\n']);
    expect(queue(fx, ['train', '--help'])).toMatchObject({ status: EXIT.ok, out: TRAIN_HELP + '\n' });
    const noPins = queue(fx, ['train', 'build']);
    expect(noPins.status).toBe(EXIT.usage);
    expect(noPins.err).toContain('train build needs --prs <n>@<sha>[,...] or --train <nonce>');
    expect(queue(fx, ['train', 'build', '--prs', '1@abc', '--urgent', '--repair']).err).toContain('--urgent and --repair are separate one-PR trains; pass one');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue'))).toBe(false);
  }, 60_000);
});

describe('the policy gate', () => {
  test('without a train block the train surface refuses with QUEUE_TRAIN_OFF and ready prints exactly today\'s block', () => {
    const fx = make(BASE_POLICY);
    const status = queue(fx, ['train', 'status']);
    expect(status.status).toBe(EXIT.refused);
    expect(status.err).toContain('declares no train block; the per-PR queue applies');
    expect(status.err).toContain('(QUEUE_TRAIN_OFF)');
    expect(next(status.out)).toBe('NEXT: none');
    expect(result(status.out)).toBe('GSTACK_RESULT: skill=ship-queue status=refused run=none');
    expect(queue(fx, ['verify', '--pr', '1', '--train', 'x']).err).toContain('(QUEUE_TRAIN_OFF)');
    const head = openPr(fx, '1');
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const today = queue(fx, ['ready', '--pr', '1', '--pregate', pregate]);
    expect(today.status).toBe(EXIT.ok);
    expect(today.out.split('\n')[0]).toBe(`READY #1 ${head} STAMP_VERSION=unstamped`);
    expect(today.out).not.toContain('NEXT:');
    expect(today.out).not.toContain('screen');
    expect(result(today.out)).toBe('GSTACK_RESULT: skill=ship-queue status=complete run=.gstack/tmp/pregate.json');
    const flagged = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(flagged.out).toBe(today.out);
    expect(flagged.err).toContain('--screen/--no-screen/--broad ignored: the base policy declares no train block');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue'))).toBe(false);
  }, 120_000);
});

describe('ready under a train policy: the screen choice', () => {
  function readyFixture() {
    const fx = make();
    const head = openPr(fx, '1');
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    return { fx, head, pregate };
  }

  test('no choice refuses with the recommendation; --no-screen records a READY receipt in the block, the state root and the notes ref', () => {
    const { fx, head, pregate } = readyFixture();
    const none = queue(fx, ['ready', '--pr', '1', '--pregate', pregate]);
    expect(none.status).toBe(EXIT.refused);
    expect(none.err).toContain('(READY_SCREEN_CHOICE_REQUIRED)');
    expect(none.out).toContain('SCREEN: selection not computed (train.screen_selection is none)');
    expect(none.out).toContain('SCREEN: price pending the T0 cost replay (lib/gate-cost.ts)');
    expect(next(none.out)).toBe('NEXT: gstack-ship-queue ready --pr 1 --no-screen');
    const ok = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out.split('\n').slice(0, 2)).toEqual([`READY #1 ${head} STAMP_VERSION=unstamped`, 'screen: no-screen']);
    const receipt = path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), `1-${head}.json`);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({ kind: 'ready', pr: '1', head, ready_at: '2026-10-18T12:00:00.000Z', screen: { choice: 'no-screen' } });
    expect(result(ok.out)).toBe(`GSTACK_RESULT: skill=ship-queue status=complete run=${receipt}`);
    expect(remoteRefs(fx)).toContain('refs/notes/gstack-trains');
    expect(dispatches(fx)).toEqual([]);
  }, 120_000);

  test('--screen dispatches one screen with the PR, its merge SHA and the policy; a repeat adopts it; a broad screen never adopts the narrow one', () => {
    const { fx, head, pregate } = readyFixture();
    const dry = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen', '--dry-run']);
    expect(dry.status).toBe(EXIT.ok);
    expect(line(dry.out, 'SCREEN_DISPATCH:')).toMatch(new RegExp(`^SCREEN_DISPATCH: evals\\.yml --ref main evals_all=false expected_sha=${head} nonce=pr\\.screen\\.narrow-\\S+ base_ref=main base_sha=[0-9a-f]{40} screen_pr=1 screen_merge_sha=${head} screen_policy=narrow \\(dry run: not dispatched\\)$`));
    expect(dispatches(fx)).toEqual([]);
    fx.write(d => { d.rules['evals.yml'] = { status: 'in_progress', conclusion: null }; });
    const first = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(first.status).toBe(EXIT.ok);
    expect(first.out.split('\n')[1]).toMatch(/^screen: screen policy=narrow nonce=pr\.screen\.narrow-\S+ run=100$/);
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(again.out).toContain('SCREEN_DISPATCH: following run 100 (same merge SHA, base and policy; no duplicate)');
    const broad = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen', '--broad']);
    expect(broad.status).toBe(EXIT.ok);
    expect(dispatches(fx).map(d => (d.inputs as any).screen_policy)).toEqual(['narrow', 'broad']);
    expect(queue(fx, ['ready', '--pr', '1', '--broad']).status).toBe(EXIT.usage);
  }, 120_000);
});

describe('train build', () => {
  test('happy path: slot order, prefix trees, CHANGELOG union, records before effects, free tests then one paid dispatch by nonce; resume and identical pins never dispatch again', () => {
    const fx = make();
    const { h1, h2, r, nonce } = twoPrTrain(fx);
    expect(r.status).toBe(EXIT.ok);
    expect(nonce).toMatch(/^gate\.train-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{6}$/);
    const t = trainJson(fx, nonce);
    expect(t).toMatchObject({ schema: 1, kind: 'train', state: 'gate-pending', branch: `train/${nonce}`, slots: [{ pr: '1', head: h1 }, { pr: '2', head: h2 }] });
    expect(t.prefixes.map((p: any) => [p.index, p.pr])).toEqual([[0, null], [1, '1'], [2, '2']]);
    expect(t.prefixes[0].commit).toBe(fx.repo.git('rev-parse', 'origin/main'));
    expect(t.prefixes[2].commit).toBe(t.head);
    expect(r.out).toContain(`PREFIX: T2 ${t.head} tree=${t.tree} (+#2)`);
    expect(remoteRefs(fx)).toContain(`${t.head}\trefs/heads/train/${nonce}`);
    expect(remoteRefs(fx)).toContain('refs/notes/gstack-trains');
    const changelog = fx.repo.git('show', `${t.head}:CHANGELOG.md`);
    expect(changelog).toContain('- #1 change');
    expect(changelog).toContain('- #2 change');
    expect(fx.repo.git('show', `${t.head}:pr-1.txt`)).toBe('change from #1');
    const sent = dispatches(fx);
    expect(sent.map(d => [d.workflow, d.ref])).toEqual([['free-tests.yml', `train/${nonce}`], ['evals.yml', `train/${nonce}`]]);
    expect(sent[1]!.inputs).toEqual({ evals_all: 'true', expected_sha: t.head, nonce });
    expect(t.effects.map((e: any) => e.what)).toEqual(expect.arrayContaining(['train.json written', `branch pushed: train/${nonce} at ${t.head.slice(0, 12)}`]));
    expect(next(r.out)).toBe(`NEXT: gstack-ship-queue train verdict --train ${nonce}`);
    expect(result(r.out)).toBe(`GSTACK_RESULT: skill=ship-queue status=complete run=${path.join(fx.state, 'ship-queue', 'trains', nonce, 'train.json')}`);
    const resume = queue(fx, ['train', 'build', '--train', nonce]);
    expect(resume.status).toBe(EXIT.ok);
    const same = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
    expect(nonceOf(same.out)).toBe(nonce);
    expect(dispatches(fx).length).toBe(2);
  }, 180_000);

  test('--dry-run prints order, trees and the estimate, and writes, pushes and dispatches nothing', () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    readyReceipt(fx, '1', h1);
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1}`, '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('ORDER: 1:#1(unscreened)');
    expect(r.out).toMatch(/^PREFIX: T1 [0-9a-f]{40} tree=[0-9a-f]{40} \(\+#1\)$/m);
    expect(r.out).toContain('ESTIMATE: one evals.yml full gate (evals_all) on T1 plus free-tests.yml; dollar figure pending the T0 cost replay');
    expect(result(r.out)).toBe('GSTACK_RESULT: skill=ship-queue status=complete run=none');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'trains'))).toBe(false);
    expect(remoteRefs(fx)).not.toContain('refs/heads/train/');
    expect(dispatches(fx)).toEqual([]);
  }, 120_000);

  test('a conflict stops the train at that PR with the exact recovery line; nothing pushed or dispatched', () => {
    const fx = make();
    const h1 = openPr(fx, '1', { file: 'same.txt', text: 'one\n', changelog: false });
    const h2 = openPr(fx, '2', { file: 'same.txt', text: 'two\n', changelog: false });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
    expect(r.status).toBe(EXIT.fail);
    expect(line(r.out, 'QUEUE_TRAIN_CONFLICT:')).toMatch(new RegExp(`^QUEUE_TRAIN_CONFLICT: train [0-9a-f]{12} stopped at #2 \\(conflicts: same\\.txt\\) after merging #1; nothing dispatched, no branch pushed; fix: gstack-ship-queue train build --prs 1@${h1}$`));
    expect(r.err).toContain('(QUEUE_TRAIN_CONFLICT)');
    expect(next(r.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${h1}`);
    expect(remoteRefs(fx)).not.toContain('refs/heads/train/');
    expect(dispatches(fx)).toEqual([]);
  }, 120_000);

  test('refusals: a fork PR, a moved head, a PR without READY, and a train still filling (until --urgent)', () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    const h2 = openPr(fx, '2', { cross: true });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    const fork = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
    expect(fork.status).toBe(EXIT.refused);
    expect(fork.err).toMatch(/PR #2's head repository is not the base repository.*\(QUEUE_TRAIN_UNTRUSTED\)/);
    expect(next(fork.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${h1}`);
    const moved = queue(fx, ['train', 'build', '--prs', `1@${'f'.repeat(40)}`]);
    expect(moved.err).toMatch(/PR #1 moved: pinned ffffffffffff, head is now .*\(QUEUE_TRAIN_MOVED\)/);
    const h3 = openPr(fx, '3');
    const notReady = queue(fx, ['train', 'build', '--prs', `3@${h3}`]);
    expect(notReady.err).toMatch(/no READY receipt for #3 .*\(QUEUE_NOT_READY\)/);
    readyReceipt(fx, '3', h3, { at: '2026-10-18T11:00:00.000Z' });
    const filling = queue(fx, ['train', 'build', '--prs', `3@${h3}`]);
    expect(filling.status).toBe(EXIT.refused);
    expect(filling.err).toMatch(/1 of 5 PRs; the oldest READY dispatches at 2026-10-18T14:00:00\.000Z.*\(QUEUE_TRAIN_WAITING\)/);
    expect(result(filling.out)).toBe('GSTACK_RESULT: skill=ship-queue status=incomplete run=none');
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const urgent = queue(fx, ['train', 'build', '--prs', `3@${h3}`, '--urgent']);
    expect(urgent.status).toBe(EXIT.ok);
    expect(trainJson(fx, nonceOf(urgent.out)).urgent).toBe(true);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('free tests red, cancelled, missing or on another SHA refuse with QUEUE_TRAIN_FREE_RED before any paid dispatch', () => {
    const fx = make();
    const h1 = openPr(fx, '1');
    readyReceipt(fx, '1', h1);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const variants: Array<[Rule, RegExp, string[]]> = [
      [{ conclusion: 'failure' }, /free tests red: run \d+ concluded failure/, []],
      [{ conclusion: 'cancelled' }, /free tests cancelled: run \d+ concluded cancelled/, []],
      [{ silent: true }, /free tests missing: no free-tests\.yml dispatch run appeared on train\//, ['--free-timeout', '1']],
      [{ headSha: '0'.repeat(40) }, /free tests stale: run \d+ tested 000000000000 \(workflow_dispatch\), not the train head/, []],
    ];
    for (const [rule, why, extra] of variants) {
      fx.write(d => { d.rules['free-tests.yml'] = rule; });
      const r = queue(fx, ['train', 'build', '--prs', `1@${h1}`, '--urgent', ...extra]);
      expect(r.status).toBe(EXIT.fail);
      expect(r.err).toMatch(why);
      expect(r.err).toContain('(QUEUE_TRAIN_FREE_RED)');
      expect(trainJson(fx, nonceOf(r.out)).state).toBe('free-red');
    }
    expect(dispatches(fx, 'evals.yml')).toEqual([]);
    expect(dispatches(fx, 'free-tests.yml').length).toBe(4);
  }, 180_000);

  test('ordering: screened PRs first in READY order; enough unscreened PRs wait for their own train', () => {
    const fx = make({ ...TRAIN_POLICY, train: { ...TRAIN_BLOCK, max_size: 2 } });
    const h = ['1', '2', '3'].map(pr => openPr(fx, pr));
    readyReceipt(fx, '1', h[0]!, { at: '2026-10-18T08:00:00.000Z' });
    readyReceipt(fx, '2', h[1]!, { at: '2026-10-18T07:00:00.000Z' });
    readyReceipt(fx, '3', h[2]!, { at: '2026-10-18T09:00:00.000Z', screen: true });
    const r = queue(fx, ['train', 'build', '--prs', `1@${h[0]},2@${h[1]},3@${h[2]}`, '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(line(r.out, 'ORDER:')).toBe('ORDER: 1:#3(screened)');
    expect(line(r.out, 'HELD:')).toBe('HELD: #2,#1 (unscreened PRs form their own train)');
    const wide = make();
    const w = ['1', '2', '3'].map(pr => openPr(wide, pr));
    readyReceipt(wide, '1', w[0]!, { at: '2026-10-18T08:00:00.000Z' });
    readyReceipt(wide, '2', w[1]!, { at: '2026-10-18T07:00:00.000Z' });
    readyReceipt(wide, '3', w[2]!, { at: '2026-10-18T09:00:00.000Z', screen: true });
    const all = queue(wide, ['train', 'build', '--prs', `1@${w[0]},2@${w[1]},3@${w[2]}`, '--dry-run']);
    expect(line(all.out, 'ORDER:')).toBe('ORDER: 1:#3(screened) 2:#2(unscreened) 3:#1(unscreened)');
    expect(all.out).toMatch(/^SLOT: 1 #3 head=[0-9a-f]{40} screened \(narrow\) ready_at=2026-10-18T09:00:00\.000Z$/m);
  }, 180_000);
});

describe('dispatch recovery and status', () => {
  test('a partial dispatch (gh failed after GitHub accepted it) is unknown, never re-dispatched, and train status finds the run by nonce', () => {
    const fx = make();
    const { r, nonce } = twoPrTrain(fx, { ...GREEN_GATE, failButCreate: true });
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    expect(next(r.out)).toBe(`NEXT: gstack-ship-queue train status --train ${nonce}`);
    expect(trainJson(fx, nonce).state).toBe('dispatch-unknown');
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    expect(queue(fx, ['train', 'build', '--train', nonce]).err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    const status = queue(fx, ['train', 'status', '--train', nonce]);
    expect(status.status).toBe(EXIT.ok);
    expect(status.out).toMatch(new RegExp(`^ATTEMPT: a1 gate state=dispatched nonce=${nonce.replace(/\./g, '\\.')} run=101 `, 'm'));
    expect(trainJson(fx, nonce).state).toBe('gate-pending');
    expect(next(status.out)).toBe(`NEXT: gstack-ship-queue train verdict --train ${nonce}`);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('a dispatch that never started is marked absent by status; only then does build dispatch it again, under the same nonce', () => {
    const fx = make();
    const { r, nonce } = twoPrTrain(fx, { silent: true });
    expect(r.err).toContain('(QUEUE_TRAIN_DISPATCH_UNKNOWN)');
    const status = queue(fx, ['train', 'status', '--train', nonce]);
    expect(status.out).toContain('ATTEMPT: a1 gate state=absent');
    expect(next(status.out)).toBe(`NEXT: gstack-ship-queue train build --train ${nonce}`);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const again = queue(fx, ['train', 'build', '--train', nonce]);
    expect(again.status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').map(d => (d.inputs as any).nonce)).toEqual([nonce, nonce]);
    expect(trainJson(fx, nonce).attempts).toEqual(['a1', 'a2']);
  }, 180_000);

  test('train status on a clean state root rebuilds the records from refs/notes/gstack-trains and spends nothing', () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const before = dispatches(fx).length;
    const clone = coordinatorClone(fx.repo);
    const fresh = path.join(fx.repo.root, 'fresh-state');
    const s = queue(fx, ['train', 'status', '--train', nonce], { GSTACK_STATE_ROOT: fresh }, clone);
    expect(s.status).toBe(EXIT.ok);
    expect(s.out).toMatch(/^NOTES: read 2 record\(s\), restored 2 /m);
    expect(s.out).toContain(`TRAIN: ${nonce} state=green`);
    expect(s.out).toContain('CHECK: gstack/full-gate on');
    expect(trainJson(fx, nonce, fresh)).toEqual(trainJson(fx, nonce));
    expect(dispatches(fx).length).toBe(before);
    const all = queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: fresh }, clone);
    expect(all.out).toContain(`NEXT(${nonce}): gstack-ship-queue verify --pr 1 --train ${nonce}`);
  }, 180_000);
});

describe('verdict, bisect, rebuild', () => {
  function redTrain(fx: TrainFixture, pattern: string) {
    const t = twoPrTrain(fx, RED_GATE);
    const v = queue(fx, ['train', 'verdict', '--train', t.nonce]);
    const prefixes = trainJson(fx, t.nonce).prefixes.map((p: any) => p.commit);
    fx.write(d => { d.rules['evals.yml'] = { bisect: { prefixes, patterns: { c1: pattern } } }; });
    return { ...t, v, prefixes };
  }

  test('a red train names its cases and a capped bisect; the bisect runs only the red cases on every prefix and attributes a monotone pattern; prune deletes the dropped train\'s branch', () => {
    const fx = make();
    const { h1, nonce, v, prefixes } = redTrain(fx, 'GGR');
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toContain(`train ${nonce} is red on c1`);
    expect(v.out).toContain('ATTEMPT: a1 gate run 101 RED red=c1 cost=$1.70');
    expect(next(v.out)).toBe(`NEXT: gstack-ship-queue train bisect --train ${nonce} --spend-cap 2.70`);
    const dry = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70', '--dry-run']);
    expect(dry.out).toContain('BISECT: cases c1 prefixes T0,T1,T2 need results; $0.90 reserved per prefix; spent $0.00, cap $2.70');
    expect(dry.out).toContain('DRY-RUN: nothing dispatched');
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const go = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70']);
    expect(go.status).toBe(EXIT.ok);
    const sent = dispatches(fx, 'evals.yml').at(-1)!.inputs as any;
    expect(sent.cases).toBe('c1');
    expect(sent.prefix_shas).toBe(prefixes.join(','));
    expect(sent.expected_sha).toBe(prefixes[2]);
    expect(sent.nonce).toMatch(/^gate\.bisect-/);
    const done = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '2.70']);
    expect(done.status).toBe(EXIT.ok);
    expect(done.out).toContain('PATTERN: c1 T0=G T1=G T2=R');
    expect(done.out).toContain('BISECT: ATTRIBUTED #2');
    expect(next(done.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${h1}`);
    expect(trainJson(fx, nonce).state).toBe('attributed');
    expect(queue(fx, ['train', 'prune', '--dry-run']).out).toContain(`WOULD-DELETE: train/${nonce} (attributed)`);
    expect(queue(fx, ['train', 'prune']).out).toContain(`DELETED: train/${nonce} (attributed)`);
    expect(remoteRefs(fx)).not.toContain(`refs/heads/train/${nonce}`);
    expect(queue(fx, ['train', 'prune']).out).toContain(`GONE: train/${nonce}`);
  }, 180_000);

  test('red on every prefix, T0 included, is RED_ON_MAIN; a non-monotone pattern is unattributed and earns no rebuild', () => {
    const main = make();
    const m = redTrain(main, 'RRR');
    queue(main, ['train', 'bisect', '--train', m.nonce, '--spend-cap', '5']);
    const onMain = queue(main, ['train', 'bisect', '--train', m.nonce, '--spend-cap', '5']);
    expect(onMain.status).toBe(EXIT.fail);
    expect(onMain.err).toContain('(QUEUE_TRAIN_RED_ON_MAIN)');
    expect(next(onMain.out)).toMatch(/^NEXT: fix forward on main first, then gstack-ship-queue train build --prs /);
    const fx = make();
    const n = redTrain(fx, 'GRG');
    queue(fx, ['train', 'bisect', '--train', n.nonce, '--spend-cap', '5']);
    const mixed = queue(fx, ['train', 'bisect', '--train', n.nonce, '--spend-cap', '5']);
    expect(mixed.status).toBe(EXIT.fail);
    expect(mixed.err).toContain('(QUEUE_TRAIN_UNATTRIBUTED)');
    expect(mixed.out).toContain('BISECT: UNATTRIBUTED (not monotone)');
    expect(next(mixed.out)).toMatch(/^NEXT: route the red cases to a repair lane \(GStack Minder\); once the repair merges: /);
    const refused = queue(fx, ['train', 'rebuild', '--train', n.nonce]);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.err).toMatch(/rebuild refused: the bisect was not all green \(c1=GRG\).*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
  }, 240_000);

  test('rebuild-once: refused without a bisect; an all-green bisect earns exactly one unchanged rebuild, both runs reported; a second red stays red', () => {
    const fx = make();
    const { nonce } = redTrain(fx, 'GGG');
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toMatch(/rebuild refused: no bisect record.*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
    queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    const green = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(green.out).toContain('BISECT: UNATTRIBUTED (all green)');
    expect(next(green.out)).toBe(`NEXT: gstack-ship-queue train rebuild --train ${nonce}`);
    fx.write(d => { d.rules['evals.yml'] = RED_GATE; });
    const rebuild = queue(fx, ['train', 'rebuild', '--train', nonce]);
    expect(rebuild.status).toBe(EXIT.ok);
    expect(dispatches(fx, 'evals.yml').at(-1)!.inputs).toMatchObject({ evals_all: 'true', nonce: `${nonce}.2` });
    const second = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(second.status).toBe(EXIT.fail);
    expect(second.out).toContain('ATTEMPT: a1 gate run 101 RED red=c1');
    expect(second.out).toMatch(/^ATTEMPT: a2 rebuild run \d+ RED red=c1/m);
    expect(next(second.out)).toMatch(/^NEXT: second red stays red: route c1 to a repair lane/);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toMatch(/rebuild refused: already rebuilt once/);
    expect(queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']).err).toContain('second red is not bisected again');
  }, 240_000);

  test('a capped bisect launches only what fits, keeps completed prefixes, and resumes without repeating one', () => {
    const fx = make();
    const { nonce, prefixes } = redTrain(fx, 'GGR');
    const none = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '0.5']);
    expect(none.status).toBe(EXIT.refused);
    expect(none.err).toContain('(QUEUE_TRAIN_BISECT_CAPPED)');
    expect(next(none.out)).toBe(`NEXT: gstack-ship-queue train bisect --train ${nonce} --spend-cap 2.70`);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const part = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '1.9']);
    expect(part.status).toBe(EXIT.refused);
    expect(part.err).toContain('(QUEUE_TRAIN_BISECT_CAPPED)');
    expect(part.out).toContain('BISECT: launch T0,T1; 1 prefix(es) wait for a higher cap');
    expect((dispatches(fx, 'evals.yml').at(-1)!.inputs as any).prefix_shas).toBe(prefixes.slice(0, 2).join(','));
    const resume = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(resume.status).toBe(EXIT.ok);
    expect((dispatches(fx, 'evals.yml').at(-1)!.inputs as any).prefix_shas).toBe(prefixes[2]);
    const done = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(done.out).toContain('BISECT: ATTRIBUTED #2');
    expect(done.out).toContain('BISECT: spent $1.50 of cap $5.00');
    expect(dispatches(fx, 'evals.yml').length).toBe(3);
  }, 240_000);

  test('a bisect refuses prefixes that are not ancestors of train/<nonce>', () => {
    const fx = make();
    const { nonce } = redTrain(fx, 'GGR');
    fx.repo.git('push', '-q', '-f', 'origin', `origin/main:refs/heads/train/${nonce}`);
    const r = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/train\/\S+ is at [0-9a-f]{12}, not the recorded train head .*\(QUEUE_TRAIN_PREFIX_INVALID\)/);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
  }, 180_000);

  test('an INFRA/INCOMPLETE-only census is never green and earns one re-dispatch, reported beside the first run', () => {
    const fx = make();
    const infra: Rule = { conclusion: 'failure', record: { panels: [PASS('c1'), FAIL('c2', 'INFRA'), PASS('j1', 'judge')], census: { ...COMPLETE, killed_before_upload: 1 }, verdict: 'RED' } };
    const { nonce } = twoPrTrain(fx, infra);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toMatch(/gate is incomplete: 1 slice killed before upload; c2 FAIL \(INFRA\).*\(QUEUE_TRAIN_INCOMPLETE\)/);
    expect(next(v.out)).toBe(`NEXT: gstack-ship-queue train rebuild --train ${nonce} --infra (the single re-dispatch EVAL_POLICY.infraRedispatch allows; report both runs)`);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce]).err).toContain('rebuild refused: no bisect record');
    const again = queue(fx, ['train', 'rebuild', '--train', nonce, '--infra']);
    expect(again.status).toBe(EXIT.ok);
    const second = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect(second.out).toMatch(/^ATTEMPT: a2 infra-redispatch run \d+ INCOMPLETE/m);
    expect(next(second.out)).toMatch(/^NEXT: diagnose run /);
    expect(queue(fx, ['train', 'rebuild', '--train', nonce, '--infra']).err).toMatch(/already re-dispatched once.*\(QUEUE_TRAIN_REBUILD_REFUSED\)/);
  }, 180_000);
});

describe('verify, freeze, repair and clear', () => {
  test('verify accepts each merge only at prefix equality modulo stamps; an interrupted publication freezes the queue until one repair train lands', () => {
    const fx = make();
    const { h1, h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string, train = nonce) => queue(fx, ['verify', '--pr', pr, '--train', train], {}, coord);

    const pre1 = v('1');
    expect(pre1.status).toBe(EXIT.ok);
    expect(pre1.out).toContain(`VERIFY_TRAIN: #1 may merge as slot 1 of train ${nonce}`);
    expect(line(pre1.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h1}`);
    const early = v('2');
    expect(early.status).toBe(EXIT.fail);
    expect(early.err).toMatch(/is neither T1 nor T2 modulo stamps.*nothing of train \S+ merged, so the queue is not frozen.*\(QUEUE_TRAIN_TREE_MISMATCH\)/);

    publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    const post1 = v('1');
    expect(post1.status).toBe(EXIT.ok);
    expect(post1.out).toMatch(/^main: [0-9a-f]{40} = T1 \(same modulo stamps \(1 stamp file\(s\)\)\)$/m);
    expect(post1.out).toContain(`VERIFY_TRAIN: #1 merged; main's tree is T1 of train ${nonce} (1/2 merged)`);
    expect(next(post1.out)).toBe(`NEXT: gstack-ship-queue verify --pr 2 --train ${nonce}`);
    expect(line(v('2').out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h2}`);

    const broken = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'stray.txt', text: 'not in the train\n' });
    const mismatch = v('2');
    expect(mismatch.status).toBe(EXIT.fail);
    expect(mismatch.err).toContain('(QUEUE_TRAIN_TREE_MISMATCH)');
    expect(line(mismatch.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(new RegExp(`^QUEUE_TRAIN_FROZEN: train \\S+ merged #1; main ${broken.slice(0, 12)} tree [0-9a-f]{12}; backstop dispatched run \\d+ \\(nonce gate\\.backstop-`));
    const backstop = dispatches(fx, 'evals.yml').at(-1)!;
    expect([backstop.ref, (backstop.inputs as any).expected_sha, (backstop.inputs as any).evals_all]).toEqual(['main', broken, 'true']);
    const freezeFile = path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8'))).toMatchObject({ kind: 'freeze', merged: ['1'], unmerged: [{ pr: '2', head: h2 }], cleared_at: null });

    const h3 = openPr(fx, '3');
    readyReceipt(fx, '3', h3);
    const ordinary = queue(fx, ['train', 'build', '--prs', `3@${h3}`, '--urgent']);
    expect(ordinary.status).toBe(EXIT.refused);
    expect(ordinary.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(next(ordinary.out)).toBe('NEXT: gstack-ship-queue train build --repair --prs <repair-pr>@<sha>');
    const fresh = path.join(fx.repo.root, 'fresh-state');
    expect(queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: fresh }, coord).out).toMatch(/^QUEUE_TRAIN_FROZEN: train /m);

    const repair = queue(fx, ['train', 'build', '--repair', '--prs', `3@${h3}`]);
    expect(repair.status).toBe(EXIT.ok);
    const rn = nonceOf(repair.out);
    expect(trainJson(fx, rn)).toMatchObject({ repair: true, base: { sha: broken } });
    expect(queue(fx, ['train', 'verdict', '--train', rn]).status).toBe(EXIT.ok);
    expect(v('2').err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(dispatches(fx, 'evals.yml').filter(d => d.ref === 'main').length).toBe(1);
    expect(line(v('3', rn).out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h3}`);
    publishMain(fx, trainJson(fx, rn).prefixes[1].commit, '1.2.6.0');
    const cleared = v('3', rn);
    expect(cleared.status).toBe(EXIT.ok);
    expect(cleared.out).toMatch(/^FREEZE: cleared \(repair #3 via train \S+; main [0-9a-f]{12} carries a green record\)$/m);
    expect(next(cleared.out)).toBe(`NEXT: gstack-ship-queue train build --prs 2@${h2}`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8')).cleared_at).toBe('2026-10-18T12:00:00.000Z');
    expect(queue(fx, ['train', 'status']).out).not.toContain('QUEUE_TRAIN_FROZEN');
  }, 300_000);
  test('from slot 2 on, a head that merges main into the pin verifies when its tree is the slot\'s prefix modulo stamps', () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    expect(v('1').status).toBe(EXIT.ok);

    const { repo } = fx;
    const laneHead = (extra?: { file: string; text: string }) => {
      repo.git('reset', '-q', '--hard');
      repo.git('checkout', '-q', '-B', 'lane2', h2);
      repo.git('rm', '-rq', '.');
      repo.git('checkout', t.prefixes[2].commit, '--', '.');
      fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
      if (extra) fs.writeFileSync(path.join(repo.work, extra.file), extra.text);
      repo.git('add', '-A');
      const tree = repo.git('write-tree');
      const head = repo.git('commit-tree', tree, '-p', h2, '-p', main1, '-m', 'merge main into #2, stamp 1.2.5.0');
      repo.git('push', '-q', '-f', 'origin', `${head}:refs/pull/2/head`);
      return head;
    };

    const merged = laneHead();
    const ok = v('2');
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(new RegExp(`^head: ${merged} \\(T2 with main merged in, same modulo stamps`, 'm'));
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${merged}`);

    const stray = laneHead({ file: 'stray.txt', text: 'not in the train\n' });
    const moved = v('2');
    expect(moved.status).toBe(EXIT.fail);
    expect(moved.err).toMatch(new RegExp(`#2 moved past its pinned head ${h2.slice(0, 12)} and is not T2 modulo stamps \\(${stray.slice(0, 12)}: .*\\(QUEUE_TRAIN_MOVED\\)`));
  }, 300_000);
});
