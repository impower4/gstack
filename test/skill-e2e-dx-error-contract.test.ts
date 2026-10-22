/**
 * Paid behavior case dx-error-contract-review (plan v3 item 11, arm A): the
 * snapshot-built autoplan native DX reviewer prompt, run headless against a
 * five-path fixture plan. The bars are preregistered in
 * test/fixtures/dx-error-contract-case.ts and replayed free by
 * test/dx-error-contract-grader.test.ts. One trial per run; the paid runner
 * supplies the 3-trial panel (E2E_KINDS 'behavior').
 */
import { afterAll, afterEach, beforeEach, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initializePlan, prepareMethodology, createSnapshot } from '../bin/gstack-autoplan-snapshot';
import { detectScope, sectionLoadFor, writePrompts } from '../lib/autoplan-prompts';
import { CAPTURE_MS } from './helpers/eval-budgets';
import { expectContract } from './helpers/eval-store';
import { ROOT, runId, logCost, recordE2E, createEvalCollector, finalizeEvalCollector, describeIfSelected, testIfSelected } from './helpers/e2e-helpers';
import { runSkillTest } from './helpers/session-runner';
import { DX_ERROR_CONTRACT_PLAN, gradeDxContractReview } from './fixtures/dx-error-contract-case';

const collector = createEvalCollector('e2e-dx-error-contract');
const NAME = 'dx error contract review';

describeIfSelected('DX error contract native reviewer (arm A)', ['dx-error-contract-review'], () => {
  let workDir = '';

  beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-error-contract-')); });
  afterEach(() => { if (workDir) fs.rmSync(workDir, { recursive: true, force: true }); });
  afterAll(() => finalizeEvalCollector(collector));

  testIfSelected('dx-error-contract-review', async () => {
    const source = path.join(workDir, 'plan.md');
    const active = path.join(workDir, 'active-plan.md');
    const restore = path.join(workDir, 'restore.md');
    fs.writeFileSync(source, DX_ERROR_CONTRACT_PLAN);
    initializePlan(source, active, restore);
    const methodology = prepareMethodology('dx', path.join(ROOT, 'plan-devex-review/SKILL.md'), restore);
    const snapshot = createSnapshot('dx', active, restore, methodology.methodologyPath);
    const outDir = path.join(workDir, 'out');
    fs.mkdirSync(outDir);
    const sections = sectionLoadFor('dx', detectScope(active, workDir, {}), 'light');
    const prompts = writePrompts({ phase: 'dx', snapshot, outDir, priorConsensus: [], sections });

    const result = await runSkillTest({
      testName: 'dx-error-contract-review',
      workingDirectory: workDir,
      prompt: `Read ${JSON.stringify(prompts.native)} completely and carry out the review it describes. Write the result file it names.`,
      tools: ['Read', 'Write'],
      allowedTools: ['Read', 'Write'],
      maxTurns: 10,
      timeout: CAPTURE_MS,
      runId,
    });
    logCost(NAME, result);
    const review = fs.existsSync(prompts.nativeResult) ? fs.readFileSync(prompts.nativeResult, 'utf8') : '';
    const grade = gradeDxContractReview(review, snapshot.sha256);
    console.log(`dx-error-contract-review caps: ${grade.caps.map(cap => `${cap.severity}:${cap.title}`).join(' | ') || 'none'}`);
    recordE2E(collector, NAME, 'DX error contract native reviewer', result, {
      passed: result.exitReason === 'success' && grade.pass,
      ...(grade.reasons.length ? { error: grade.reasons.join('; ') } : {}),
    });
    expect(result.exitReason).toBe('success');
    expectContract(!grade.reasons.some(reason => reason.startsWith('result: ')),
      `dx-error-contract-review: the bound result does not parse: ${grade.reasons.filter(reason => reason.startsWith('result: ')).join('; ')}`, { collector, name: NAME });
    expect(grade.reasons).toEqual([]);
  }, CAPTURE_MS + 30_000);
});
