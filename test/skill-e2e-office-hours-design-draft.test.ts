/**
 * Office-hours design-draft checkpoint (periodic). The fixed startup interview
 * from CARVE_GUARDS['office-hours'] runs only through the Write that creates the
 * design (observed at 269s of the full workflow in run 36385945043). It applies
 * the full workflow's design-draft checks, required section reads and
 * launch/skill-read guards. The complete review, approval and handoff workflow
 * is marathon tier in skill-e2e-office-hours-section-loading.test.ts.
 */
import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeE2ETier } from './helpers/e2e-gate';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { setupSkillDir, skillFromWorktree, captureSectionReads, LONG_SECTION_CAPTURE_MS } from './helpers/auq-sdk-capture';
import { CARVE_GUARDS } from './helpers/carve-guards';
import { validateOfficeHoursDesignDraft } from './helpers/office-hours-completion';

const describePeriodic = describeE2ETier('periodic');

describePeriodic('/office-hours design-draft checkpoint (periodic)', () => {
  test('the startup interview reads its sections and writes a complete design after an independent opinion', async () => {
    const guard = CARVE_GUARDS['office-hours'];
    const answersStart = guard.scenario.indexOf('This is a synthetic interview fixture');
    const answersEnd = guard.scenario.indexOf('Use the available Agent tool');
    if (answersStart < 0 || answersEnd < answersStart) {
      throw new Error('fixture drift: CARVE_GUARDS office-hours scenario no longer has its interview block');
    }
    const { skillMd, sectionsFrom } = skillFromWorktree(guard.skill);
    const planDir = setupSkillDir({
      skillName: guard.skill, skillMd, sectionsFrom, tmpPrefix: 'gstack-office-hours-draft-',
    });
    const capture = await captureSectionReads({
      planDir, skillName: guard.skill,
      scenario: `Run office hours in STARTUP mode through the diagnostic, premise challenge,
alternatives, independent opinion and the design document.
${guard.scenario.slice(answersStart, answersEnd).trim()}

Use the available Agent tool for the independent opinion when the workflow calls
for it. It is read-only. An automated test is not a reason to skip it. This fixture
checks a separate real tool call: obtain the independent opinion on RosterCheck
before writing the design. A self-authored "second opinion" is not a subagent result.
Save the design to docs/designs/roster-check.md in this fixture; keep all artifacts
inside the fixture.

Checkpoint for this run: stop after the Write that saves the complete design
document. Do not run the spec review, approval, relationship closing or handoff;
the full workflow covers them separately. Then write REPORT.md with the design path
and a one-line outcome for each phase you completed.`,
      testName: 'office-hours-design-draft', runId: `office-hours-design-draft-${process.env.EVALS_RUN_ID ?? 'local'}`,
      timeout: LONG_SECTION_CAPTURE_MS,
    });
    const designPath = path.join(planDir, 'docs/designs/roster-check.md');
    expect(capture.exitReason).toBe('success');
    validateOfficeHoursDesignDraft({
      designPath, toolCalls: capture.toolCalls,
      designContent: fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf-8') : null,
    });
    const missing = guard.requiredReads.filter(section => !capture.readSections.has(section));
    expect({ reportProduced: capture.reportProduced, read: [...capture.readSections], missing }).toEqual({
      reportProduced: true, read: expect.any(Array), missing: [],
    });
    expect(capture.toolCalls.filter(call => call.tool === 'Skill')).toEqual([]);
    const ownSkillPath = path.join(planDir, guard.skill, 'SKILL.md');
    expect(capture.toolCalls.filter(call => call.tool === 'Read'
      && /(?:^|\/)SKILL\.md$/.test(String(call.input?.file_path ?? ''))
      && path.resolve(planDir, call.input.file_path) !== ownSkillPath)).toEqual([]);
  }, CAPTURE_LONG_MS);
});
