/**
 * Fail-open regression suite for the paid lane verdict. Synthetic slice
 * artifacts go through the real `--report` CLI path (the command the workflow
 * report jobs run), so a change to the gate cannot turn a real failure green
 * without one of these cases going red. Landed before the panel-verdict gate
 * change; every later gate change extends it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRunManifest, type PaidRunManifest, type SliceResult } from '../scripts/test-paid-shards';
import { stampTrialSeries } from '../scripts/eval-trial-series';

const ROOT = path.resolve(import.meta.dir, '..');
const RULE_A = 'test/skill-e2e-fail-open-alpha.test.ts';
const RULE_B = 'test/skill-e2e-fail-open-beta.test.ts';

let base: string;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-fail-open-')); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

type Outcome = SliceResult['outcomes'][number];
const passed = (file: string, extra: Partial<Outcome> = {}): Outcome =>
  ({ files: [file], status: 'passed', exitCode: 0, elapsedMs: 1_000, executedTests: 1, skippedTests: 0, ...extra });

function manifest(entries: PaidRunManifest['entries'], sliceCount: number): PaidRunManifest {
  return parseRunManifest(JSON.stringify({ version: 1, tier: 'periodic', evalsAll: true, sliceCount,
    selectionReason: 'fail-open fixture', profile: 'full', selection: { e2e: null, judges: null }, entries }));
}

let caseCounter = 0;
function report(plan: PaidRunManifest, slices: SliceResult[], collectors: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = path.join(base, `case-${++caseCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(plan));
  for (const slice of slices) fs.writeFileSync(path.join(dir, `slice-${slice.sliceIndex}.json`), JSON.stringify(slice));
  for (const [name, body] of Object.entries(collectors)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  }
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'), '--tier', plan.tier, '--report', dir],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GITHUB_RUN_ID: '', GITHUB_SHA: '', EVALS_TIER: plan.tier, ...env } });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`, dir };
}

const slice = (sliceIndex: number, sliceCount: number, outcomes: Outcome[]): SliceResult =>
  ({ version: 1, tier: 'periodic', profile: 'full', selection: { e2e: null, judges: null }, sliceIndex, sliceCount, outcomes });

describe('rule shards stay fail-closed through --report', () => {
  const plan = manifest([
    { file: RULE_A, slice: 1, status: 'planned' },
    { file: RULE_B, slice: 2, status: 'planned' },
  ], 2);

  test('all planned rule shards passed: green', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status, r.out).toBe(0);
  });

  test('a failed rule shard: red, naming the file', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'failed', exitCode: 1 })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_A}: failed`);
  });

  test('a timed-out rule shard: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'timed-out', exitCode: null })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_A}: timed-out`);
  });

  test('a missing slice artifact: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('slice 2/2 reported NO result');
  });

  test('a planned shard no slice reported: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)]), slice(2, 2, [])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`planned ${RULE_B} (slice 2) was never reported`);
  });

  test('a hollow shard under EVALS_ALL: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'passed-empty', executedTests: 0 })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_A}: passed-empty`);
  });

  test('a never-started shard: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A, { status: 'never-started', exitCode: null, executedTests: null })]), slice(2, 2, [passed(RULE_B)])]);
    expect(r.status).toBe(1);
  });

  test('a failed collector record under a passing shard: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A)]), slice(2, 2, [passed(RULE_B)])], {
      'shards/skill-e2e-fail-open-alpha/run.json': { tier: 'e2e', total_tests: 1, total_cost_usd: 0,
        tests: [{ name: 'alpha', suite: 's', tier: 'e2e', passed: false, duration_ms: 1, cost_usd: 0 }] },
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('1 unapproved final collector failure(s)');
  });

  test('a shard reported by the wrong slice: red', () => {
    const r = report(plan, [slice(1, 2, [passed(RULE_A), passed(RULE_B)]), slice(2, 2, [])]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${RULE_B} planned for slice 2 but reported by slice 1`);
  });
});

describe('behavior and quarantined panels through --report', () => {
  const FILE = 'test/skill-e2e-review.test.ts';
  const ID = 'review-design-lite';
  const key = (trial: number) => `${FILE}#${ID}~t${trial}`;
  const plan = (quarantined = false) => manifest([
    ...[1, 2, 3].map(trial => ({ file: key(trial), slice: trial, status: 'planned' as const,
      trial: { kind: 'behavior' as const, panel: { n: 3, k: 2 }, quarantined } })),
    { file: RULE_A, slice: 4, status: 'planned' },
  ], 4);
  type TrialResult = 'passed' | 'failed' | 'contract' | 'missing' | 'harness';
  const trialOutcome = (trial: number, result: TrialResult, quarantined = false): Outcome | null => {
    if (result === 'missing') return null;
    const record = { case: ID, trial, kind: 'behavior' as const, panel: { n: 3, k: 2 }, quarantined, cost_usd: 0, duration_ms: 1_000 };
    if (result === 'harness') return passed(key(trial), { status: 'never-started', exitCode: null, executedTests: null, skippedTests: null,
      trial: { ...record, outcome: null, harness: 'never started' } });
    if (result === 'passed') return passed(key(trial), { trial: { ...record, outcome: 'passed' } });
    return passed(key(trial), { status: 'failed', exitCode: 1,
      trial: { ...record, outcome: 'failed', failure_class: result === 'contract' ? 'contract' : 'timeout',
        exit_reason: 'timeout', timeout_at_turn: 14, error: result === 'contract' ? 'handoff missing' : 'no posture match' } });
  };
  const run = (results: TrialResult[], quarantined = false, dropSlice?: number) => report(plan(quarantined), [1, 2, 3, 4]
    .filter(index => index !== dropSlice)
    .map(index => slice(index, 4, index === 4 ? [passed(RULE_A)]
      : [trialOutcome(index, results[index - 1]!, quarantined)].filter((o): o is Outcome => o !== null))));

  test('behavior 3/3: green', () => {
    const r = run(['passed', 'passed', 'passed']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('VERDICT GREEN');
  });

  test('behavior 2/3: green, the failed trial shown with its cause', () => {
    const r = run(['passed', 'failed', 'passed']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`⚠ ${ID}  behavior  PASS 2/3 (✓✗✓)`);
    expect(r.out).toContain('t2: timeout at turn 14');
    const summary = JSON.parse(fs.readFileSync(path.join(r.dir, 'collector-outcomes.json'), 'utf8'));
    expect(summary.version).toBe(2);
    expect(summary.panels[0]).toMatchObject({ case: ID, status: 'PASS', split: true, failsLane: false });
    const outcomesFile = path.join(r.dir, 'trial-outcomes.jsonl');
    const history = () => fs.readFileSync(outcomesFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(history().map(h => [h.trial, h.outcome])).toEqual([[1, 'passed'], [2, 'failed'], [3, 'passed']]);
    expect(stampTrialSeries(outcomesFile)).toBe(3);
    expect(new Set(history().map(h => h.series_identity)).size).toBe(1);
    expect(history()[0].series_identity).toMatch(/^[0-9a-f]{16}$/);
  });

  test('behavior 1/3: red', () => {
    const r = run(['passed', 'failed', 'failed']);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`PANEL ${ID} FAIL 1/3`);
  });

  test('a missing trial record: INCOMPLETE, red', () => {
    const r = run(['passed', 'missing', 'passed']);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`PANEL ${ID} INCOMPLETE`);
  });

  test('a trial the harness never started: red, machine-classified for one re-dispatch', () => {
    const r = run(['passed', 'harness', 'passed']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('no trial record (never started)');
    expect(r.out).toContain('INFRA-ONLY RED');
  });

  test('a contract trial at 2/3: red', () => {
    const r = run(['passed', 'passed', 'contract']);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`PANEL ${ID} FAIL 2/3`);
    expect(r.out).toContain('contract violation');
    expect(r.out).not.toContain('INFRA-ONLY RED');
  });

  test('quarantined 1/3: reported, does not fail the lane', () => {
    const r = run(['passed', 'failed', 'failed'], true);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`◌ ${ID}  behavior (quarantined)  FAIL 1/3`);
  });

  test('quarantined 0/3: hard break, red', () => {
    const r = run(['failed', 'failed', 'failed'], true);
    expect(r.status).toBe(1);
    expect(r.out).toContain('quarantined hard break');
  });

  test('quarantined contract violation: red', () => {
    const r = run(['passed', 'passed', 'contract'], true);
    expect(r.status).toBe(1);
  });

  test('a missing trial slice: red', () => {
    const r = run(['passed', 'passed', 'passed'], false, 2);
    expect(r.status).toBe(1);
    expect(r.out).toContain('slice 2/4 reported NO result');
    expect(r.out).toContain(`PANEL ${ID} INCOMPLETE`);
  });

  test('a later run attempt never replaces the first attempt verdict', () => {
    const r = run(['passed', 'failed', 'failed']);
    expect(r.status).toBe(1);
    const retry = slice(3, 4, [trialOutcome(3, 'passed')!]);
    fs.mkdirSync(path.join(r.dir, 'paid-slice-3-a2'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'paid-slice-3-a2', 'slice-3.json'), JSON.stringify({ ...retry, attempt: 2 }));
    const again = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'), '--tier', 'periodic', '--report', r.dir],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(again.status).toBe(1);
    expect(again.stdout).toContain('attempt 1 (later attempts 2 reported, never replacing it)');
  });

  test('verdicts become next-run receipts: a whole fresh PASS panel, and negatives for FAIL panels', () => {
    const inputKey = 'b'.repeat(64);
    const withKey = (results: TrialResult[]) => [1, 2, 3, 4].map(index => slice(index, 4, index === 4 ? [passed(RULE_A)]
      : [{ ...trialOutcome(index, results[index - 1]!)!, inputKey }]));
    const env = { GITHUB_RUN_ID: '77', GITHUB_SHA: 'e'.repeat(40) };
    const green = report(plan(), withKey(['passed', 'failed', 'passed']), {}, env);
    expect(green.status, green.out).toBe(0);
    const receipt = JSON.parse(fs.readFileSync(path.join(green.dir, 'report-receipts', `${inputKey}.panel.json`), 'utf8'));
    expect(receipt).toMatchObject({ key: inputKey, case: ID, panel: { n: 3, k: 2 }, source: { runId: '77/1' } });
    expect(receipt.trials.map((t: any) => t.outcome)).toEqual(['passed', 'failed', 'passed']);
    const red = report(plan(), withKey(['passed', 'failed', 'failed']), {}, env);
    expect(red.status).toBe(1);
    expect(fs.readdirSync(path.join(red.dir, 'report-receipts'))).toEqual([`${inputKey}.fail.json`]);
  });
});
