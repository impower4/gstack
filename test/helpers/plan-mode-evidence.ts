import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactFindingSpans } from '../../lib/redact-engine';
import type { PlanSkillObservation } from './claude-pty-runner';

/** Retain the returned observation if caller assertions fail after PTY cleanup.
 * The observation has no native session identity: an attempt ID is not a SID.
 * Diagnostic failures must not replace the assertion that failed the case.
 */
export function assertPlanModeWithEvidence(
  skillName: 'plan-design-review' | 'plan-eng-review', caseName: string, observation: PlanSkillObservation, assertions: () => void,
): void {
  try { assertions(); } catch (error) {
    try {
      const evalDir = process.env.GSTACK_EVAL_DIR;
      if (!evalDir) throw new Error('GSTACK_EVAL_DIR is not configured');
      const secrets = Object.entries(process.env)
        .filter(([key, value]) => /token|secret|password|credential|authorization|api[_-]?key|private[_-]?key/i.test(key)
          && value && value.length >= 8)
        .map(([, value]) => value!).sort((a, b) => b.length - a.length);
      const safe = (value: unknown): unknown => {
        if (typeof value !== 'string') return value;
        // The returned evidence is already a 2KB tail; bound other strings too.
        if (Buffer.byteLength(value) > 65_536) return '[OMITTED_OVERSIZE_STRING]';
        for (const secret of secrets) value = (value as string).replaceAll(secret, '[REDACTED_ENV]');
        return redactFindingSpans(value as string) ?? '[OMITTED_UNSAFE_STRING]';
      };
      const root = path.join(evalDir, 'plan-mode');
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
        throw new Error('Plan-mode evidence root must be a real directory');
      }
      const attemptId = randomUUID();
      const dir = path.join(root, attemptId);
      fs.mkdirSync(dir, { mode: 0o700 });
      const file = path.join(dir, 'observation.json');
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1, attemptId, capturedAt: new Date().toISOString(),
        caseFile: `test/skill-e2e-${skillName.replace(/-review$/, '')}-plan-mode.test.ts`, caseName,
        skillName, inPlanMode: true,
        nativeSessionId: null, provenance: 'Returned PlanSkillObservation; native session identity is not exposed.',
        observation: Object.fromEntries(Object.entries(observation).map(([key, value]) => [key, safe(value)])),
        failure: { name: error instanceof Error ? error.name : 'ThrownValue',
          message: safe(error instanceof Error ? error.message : String(error)),
          stack: safe(error instanceof Error ? error.stack : undefined) },
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.error(`[plan-mode] failure observation: ${file}`);
    } catch (retentionError) {
      console.error('[plan-mode] failed to retain observation:', retentionError);
    }
    throw error;
  }
}

/**
 * A seeded plan-mode review targeted the seeded plan without asking which
 * target to review: either the auto-selection was observed (visible
 * announcement or native seeded-plan selection) or seed-only plan content
 * appeared in the review output after the slash command. The announcement's
 * exact wording is not required.
 */
export function seededPlanTargeted(observation: PlanSkillObservation, seedTokens: readonly string[]): boolean {
  return observation.scopeGateAutoSelectObserved === true
    || seedTokens.some(token => observation.tokensObserved?.[token] === true);
}

/**
 * The AskUserQuestion format forbids writing a decision to the plan file as a
 * substitute for asking, so a plan file with a `## Decisions` section fails.
 */
export function assertNoPlanFileDecisions(observation: PlanSkillObservation, hasDecisions: (planFile: string) => boolean): void {
  if (observation.outcome === 'plan_ready' && observation.planFile && hasDecisions(observation.planFile)) {
    throw new Error(`plan file ${observation.planFile} carries a ## Decisions section: decisions must be asked ` +
      `(AskUserQuestion or the prose fallback), not written to the plan as a substitute.\n` +
      `--- evidence (last 2KB) ---\n${observation.evidence}`);
  }
}
