/**
 * plan-devex-review plan-mode smoke (gate, paid, real-PTY).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. Exercises the same contract against /plan-devex-review.
 */

import { test, expect } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  runPlanSkillObservation,
  planFileHasDecisionsSection,
  assertReportAtBottomIfPlanWritten,
} from './helpers/claude-pty-runner';
import { assertNoPlanFileDecisions } from './helpers/plan-mode-evidence';

const describeE2E = describeE2ETier('gate');

describeE2E('plan-devex-review plan-mode smoke (gate)', () => {
  test('reaches a terminal outcome (asked or plan_ready) without silent writes', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-devex-review',
      inPlanMode: true,
      timeoutMs: CAPTURE_MS,
    });

    if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
      throw new Error(
        `plan-devex-review plan-mode smoke FAILED: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
    assertReportAtBottomIfPlanWritten(obs);
    assertNoPlanFileDecisions(obs, planFileHasDecisionsSection);
  }, CAPTURE_LONG_MS);

  // v1.21+ regression: see skill-e2e-plan-ceo-plan-mode.test.ts for the
  // contract. With AskUserQuestion blocked the decision must still be asked
  // (the prose fallback, observed as 'asked'); a plan-file ## Decisions
  // section is not a substitute. Failure signals also include 'auto_decided'
  // (AUTO_DECIDE without opt-in) plus the standard silent_write/exited/timeout.
  test('AskUserQuestion surfaces when --disallowedTools AskUserQuestion is set', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-devex-review',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      timeoutMs: CAPTURE_MS,
    });

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `plan-devex-review AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    assertReportAtBottomIfPlanWritten(obs);
    assertNoPlanFileDecisions(obs, planFileHasDecisionsSection);
    if (obs.outcome !== 'asked') {
      throw new Error(
        `plan-devex-review AskUserQuestion-blocked regression: outcome=${obs.outcome} — Step 0 reached ${obs.planFile ?? 'plan_ready'} without asking.\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
  }, CAPTURE_LONG_MS);
});
