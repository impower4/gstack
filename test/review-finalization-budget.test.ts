/** The real review registrations record late results and clean up before finalization, under the production zero-retry arguments. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPaidShardArgs, retriesForFiles, resolvePaidShardTimeoutMs } from '../scripts/test-paid-shards';
const ROOT = path.resolve(import.meta.dir, '..');
const PAID_FILE = 'test/skill-e2e-review.test.ts';
const CASES = [
  ['review-sql-injection', 400, 20],
  ['review-enum-completeness', 300, 15],
  ['review-design-lite', 400, 35],
] as const;
const SYNTHETIC_REPORT = 'SQL injection. Returned enum status critical. Papyrus font family;14px font-size;outline focus;!important;purple gradient;generic hero copy;3-column feature grid;detector [low-contrast] x3.';
const DESIGN_CAPTURES = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/review-design-lite-reports-ci-36633323521.json'), 'utf8')) as {
  reports: Array<{ run: string; trial: string; scanRan: boolean; report: string }>;
};

function runRegistration(id: string, scenario: string, report: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-finalization-'));
  const script = path.join(dir, 'registration.test.ts');
  const facts = path.join(dir, 'events.jsonl');
  const evalDir = path.join(dir, 'eval');
  fs.writeFileSync(script, `
import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(ROOT)}, selected = ${JSON.stringify(id)};
let attempts = 0;
const event = value => fs.appendFileSync(${JSON.stringify(facts)}, JSON.stringify(value) + '\\n');
mock.module(path.join(root, 'test/helpers/eval-budgets.ts'), () => ({ JUDGE_MS: 300, CAPTURE_MS: 400 }));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  ROOT: root, browseBin: '', runId: 'free-review-finalization', evalsEnabled: true, selectedTests: [selected],
  describeIfSelected: (name, ids, body) => { if (ids.includes(selected)) describe(name, body); },
  testConcurrentIfSelected: (name, body, outerMs) => {
    if (name !== selected) return;
    event({ kind: 'registration', name, outerMs });
    test.concurrent(name, body, outerMs);
  },
  copyDirSync: () => {}, setupBrowseShims: () => {}, logCost: () => {}, createEvalCollector: () => null,
  recordE2E: (_collector, name, suite, result) => event({ kind: 'record', id: result.attemptId, exitReason: result.exitReason, name, suite }),
  finalizeEvalCollector: async () => event({ kind: 'finalized' }),
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({
  SESSION_DRAIN_GRACE_MS: 50,
  runSkillTest: async opts => {
    const id = ++attempts;
    event({ kind: 'start', id, timeout: opts.timeout, maxTurns: opts.maxTurns, cwd: opts.workingDirectory });
    const timeout = ${JSON.stringify(scenario)} === 'timeout';
    // Use the caller's actual work budget; only the provider and budget
    // constants are scaled. The actual registered Bun outer deadline stays.
    await new Promise(resolve => setTimeout(resolve, timeout ? opts.timeout + 50 : 80));
    event({ kind: 'ready', id, fixtureExists: fs.existsSync(opts.workingDirectory) });
    if (!timeout) {
      const target = selected === 'review-enum-completeness'
        ? opts.prompt.match(/Write your review findings once to (\\S+)/)[1]
        : path.join(opts.workingDirectory, 'review-output.md');
      fs.writeFileSync(target, ${JSON.stringify(report)});
    }
    return { attemptId: id, exitReason: timeout ? 'timeout' : 'success', duration: opts.timeout,
      model: 'free-fixture-model', toolCalls: [], browseErrors: [], output: '', transcript: [],
      costEstimate: { estimatedCost: 0, estimatedTokens: 0, turnsUsed: 0 } };
  },
}));
await import(path.join(root, ${JSON.stringify(PAID_FILE)}));
`);
  const retries = retriesForFiles([PAID_FILE]);
  expect(retries).toBe(0);
  const child = Bun.spawnSync([process.execPath, ...buildPaidShardArgs([script], resolvePaidShardTimeoutMs([PAID_FILE]), 2, retries)], {
    cwd: ROOT, timeout: 15_000, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, EVALS: '', EVALS_ALL: '', TMPDIR: dir, TMP: dir, TEMP: dir, GSTACK_EVAL_DIR: evalDir },
  });
  const violations = path.join(evalDir, 'contract-violations.jsonl');
  return { dir, facts, exitCode: child.exitCode, output: child.stdout.toString() + child.stderr.toString(),
    violations: fs.existsSync(violations) ? fs.readFileSync(violations, 'utf8') : '' };
}

for (const [id, workMs, maxTurns] of CASES) {
  test.each(['success', 'timeout'])(`${id} records late results before finalization: %s`, scenario => {
    const { dir, facts, exitCode, output } = runRegistration(id, scenario, SYNTHETIC_REPORT);
    try {
      expect(exitCode, output).toBe(scenario === 'success' ? 0 : 1);
      expect(output).not.toContain('Unhandled error between tests');
      const events = fs.readFileSync(facts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const starts = events.filter(event => event.kind === 'start');
      const ready = events.filter(event => event.kind === 'ready');
      const records = events.filter(event => event.kind === 'record');
      expect(starts.map(event => event.id)).toEqual([1]);
      expect(starts.map(({ timeout, maxTurns }) => ({ timeout, maxTurns })))
        .toEqual([{ timeout: workMs, maxTurns }]);
      expect(ready).toEqual([{ kind: 'ready', id: 1, fixtureExists: true }]);
      expect(records.map(event => [event.id, event.exitReason]))
        .toEqual([[1, scenario === 'success' ? 'success' : 'timeout']]);
      expect(events.findIndex(event => event.kind === 'record' && event.id === 1))
        .toBeLessThan(events.findIndex(event => event.kind === 'finalized'));
      expect(events.filter(event => event.kind === 'finalized')).toHaveLength(1);
      expect(events.find(event => event.kind === 'registration')).toEqual({ kind: 'registration', name: id, outerMs: workMs + 50 + 5_000 });
      for (const attempt of starts) expect(fs.existsSync(attempt.cwd)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test.each(DESIGN_CAPTURES.reports.map(capture => [`${capture.run} ${capture.trial}`, capture] as const))(
  'review-design-lite credits detector rows in captured report %s only when the scan ran', (_label, capture) => {
    const { dir, exitCode, output, violations } = runRegistration('review-design-lite', 'success', capture.report);
    try {
      expect(exitCode, output).toBe(capture.scanRan ? 0 : 1);
      expect(violations.includes('the review omitted the mechanical detector rows'), output).toBe(!capture.scanRan);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
