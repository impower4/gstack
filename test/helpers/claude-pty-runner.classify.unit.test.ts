/**
 * Deterministic unit tests for the frame classifiers (test/helpers/pty/classify.ts).
 * Split along the W4 module seams from the former claude-pty-runner.unit.test.ts;
 * tests import the public barrel, test/helpers/claude-pty-runner.ts.
 */
import { describe, test, expect } from 'bun:test';
import {
  isNumberedOptionListVisible,
  isProseAUQVisible,
  isScopeGateQuestionVisible,
  isScopeGateAutoSelectVisible,
  isPlanReadyVisible,
  parseNumberedOptions,
  classifyVisible,
  TAIL_SCAN_BYTES,
  optionsSignature,
  stripAnsi,
  COMPLETION_SUMMARY_RE,
  classifyPlanCountFrame,
  capturePlanCountQuestion,
  planCountSubmissionInput,
} from './claude-pty-runner';

describe('scope-gate render detectors', () => {
  // The verbatim announcement string from the plan-eng/plan-design SKILL.md
  // templates. If the template rewording drifts, THIS fixture fails first —
  // before the paid plan-mode smokes silently degrade to vacuous asserts.
  const TEMPLATE_ANNOUNCEMENT =
    'Scope gate: plan mode — auto-selected B (reviewing <target>).';

  describe('isScopeGateQuestionVisible', () => {
    test('matches the clean prose gate render (question + option bodies)', () => {
      const sample = `
What should I review?
A) The current branch diff — the work in progress on this branch.
B) A plan or design doc I'll paste or point you to.
C) A specific file, directory, or path.
Recommendation: A when a branch diff exists, otherwise B.
`;
      expect(isScopeGateQuestionVisible(sample)).toBe(true);
    });

    test('matches the native numbered render (no lettered markers)', () => {
      const sample = `
  What should I review?

  ❯ 1. The current branch diff — the work in progress on this branch.
    2. A plan or design doc I'll paste or point you to.
    3. A specific file, directory, or path.
`;
      expect(isScopeGateQuestionVisible(sample)).toBe(true);
    });

    test('matches the PTY-collapsed render (stripAnsi squished spaces)', () => {
      const sample = 'WhatshouldIreview?A)Thecurrentbranchdiff—theworkinprogress';
      expect(isScopeGateQuestionVisible(sample)).toBe(true);
    });

    test('stays false on narration quoting only the question', () => {
      const sample =
        "Normally I'd ask 'What should I review?' but plan mode is active, so I'm proceeding.";
      expect(isScopeGateQuestionVisible(sample)).toBe(false);
    });

    test('stays false on unrelated review prose', () => {
      const sample = 'I will review the current branch diff and report findings.';
      expect(isScopeGateQuestionVisible(sample)).toBe(false);
    });
  });

  describe('isScopeGateAutoSelectVisible', () => {
    test('matches the verbatim template announcement', () => {
      expect(isScopeGateAutoSelectVisible(TEMPLATE_ANNOUNCEMENT)).toBe(true);
    });

    test('matches a real announcement with a concrete target', () => {
      const sample =
        'Scope gate: plan mode — auto-selected B (reviewing ~/.claude/plans/my-feature.md). Running the Design Doc Check next.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(true);
    });

    test('matches the PTY-collapsed announcement', () => {
      const sample = 'Scopegate:planmode—auto-selectedB(reviewingPLAN.md).';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(true);
    });

    test('stays false on narration about the behavior', () => {
      const sample = "In plan mode I'd auto-select B and review the active plan.";
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });

    test('stays false on a VERBATIM QUOTE of the announcement (negation narration)', () => {
      // The exact announcement line sits quoted in the skill context, so a
      // model explaining why it is NOT firing it can reproduce it byte-exact
      // inside quotes — that must not trip a must-stay-false assert.
      const sample =
        'Not in plan mode, so I won\'t announce "Scope gate: plan mode — auto-selected B (reviewing <target>)." and will ask instead.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });

    test('a later real render still matches after an earlier quoted mention', () => {
      const sample =
        'Earlier I said I would render "Scope gate: plan mode — auto-selected B (…)" and now:\n' +
        'Scope gate: plan mode — auto-selected B (reviewing PLAN.md).';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(true);
    });

    test('matches tense paraphrases WITH the announcement prefix (auto-selecting / auto-selects)', () => {
      expect(
        isScopeGateAutoSelectVisible('Scope gate: plan mode — auto-selecting B (reviewing the drafted plan).'),
      ).toBe(true);
      expect(isScopeGateAutoSelectVisible('Scope gate: plan mode — auto-selects B.')).toBe(true);
    });

    test('stays false on tense paraphrases WITHOUT the announcement prefix', () => {
      expect(isScopeGateAutoSelectVisible('Auto-selecting B since we are in plan mode.')).toBe(false);
    });

    test('stays false on AUTO_DECIDE preamble output', () => {
      const sample = 'Auto-decided scope question → B (your preference). Change with /plan-tune.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });

    test('stays false on a bare "selected B" without the announcement prefix', () => {
      const sample = 'I selected B as the review target.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });
  });
});

describe('isProseAUQVisible', () => {
  test('matches 4 lettered options A) B) C) D) at line starts (plan-eng prose AUQ shape)', () => {
    const sample = `
What would you like me to review? Options:
A) Point me at an existing design doc or plan file (path).
B) Describe new work you're planning — I'll explore the codebase.
C) You meant /review for the diff already on this branch.
D) Something else (tell me).
Recommendation: A if you have a doc in mind, otherwise B.
❯
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('matches 2 lettered options (minimum threshold)', () => {
    const sample = `
A) First option
B) Second option
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('matches 3 numbered options 1. 2. 3. without ❯ 1. cursor (autoplan prose AUQ shape)', () => {
    const sample = `
What's the task? A few options:
  1. You have a plan idea in mind — describe it.
  2. You want to review an existing plan elsewhere.
  3. You meant a different command — /plan-ceo-review etc.
❯
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false when ❯ 1. cursor is present in the recent tail (native UI handled by isNumberedOptionListVisible)', () => {
    const sample = `
❯ 1. First option
  2. Second option
  3. Third option
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('does NOT suppress numbered-prose detection when ❯ 1. is only in early scrollback (trust dialog)', () => {
    // Boot trust dialog rendered ❯ 1. Yes at startup, then a long body of
    // model output, then prose-rendered numbered options now. The historic
    // ❯ 1. is in the full buffer but NOT in the recent tail. Should detect
    // the prose AUQ.
    const trustHeader = '❯ 1. Yes, trust\n  2. No\n';
    const filler = 'x'.repeat(5000); // pushes trust dialog out of last 4KB tail
    const proseAUQ = `\n  1. Review the docs\n  2. Investigate the code\n  3. Defer to next session\n❯  \n`;
    const sample = trustHeader + filler + proseAUQ;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false on single lettered option', () => {
    const sample = `
A) Only one option mentioned in passing.
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('matches 2 numbered options (threshold matches lettered branch — tails miss option 1)', () => {
    const sample = `
1. First note.
2. Second note.
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false on a single numbered option', () => {
    const sample = `
1. Only one option mentioned.
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('does not match mid-prose lettered text like "(see option B) above"', () => {
    const sample = `
This refers to (see option B) above and also to point A) earlier.
`;
    // The B) and A) markers are mid-line, not at line starts, so they don't count.
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('matches with leading whitespace and ❯ prefix on options', () => {
    const sample = `
   A) Option with whitespace prefix
❯  B) Option with cursor prefix
   C) Another option
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false on plain text with no option markers', () => {
    expect(isProseAUQVisible('Just some plain text output from the model.')).toBe(false);
    expect(isProseAUQVisible('')).toBe(false);
  });

  // Pattern 3: markdown bold-bullet options — office-hours renders its mode
  // question this way under --disallowedTools, with no letter/number marker.
  test('matches office-hours markdown bold-bullet mode question (Pattern 3)', () => {
    const sample = `
> Before we dig in — what's your goal with this?
>
> - **Building a startup** (or thinking about it)
> - **Intrapreneurship** — internal project at a company, need to ship fast
> - **Hackathon / demo** — time-boxed, need to impress
> - **Open source / research** — building for a community
> - **Learning** — teaching yourself to code
❯
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('bold-bullets require a preceding interrogative — no "?" => false', () => {
    // 3+ bold bullets but no question stem: this is a feature list, not an AUQ.
    const sample = `
Here is what shipped:
- **Faster builds** via caching
- **Smaller binaries** through tree-shaking
- **Better errors** with source maps
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('a question with fewer than 3 bold bullets stays false (guard)', () => {
    const sample = `
Which approach do you prefer?
- **Option one** is simpler
- **Option two** is faster
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('plain (non-bold) bullets after a question do not trigger Pattern 3', () => {
    // Only bold bullets count — plain "- text" prose lists are too common.
    const sample = `
What should we do about this?
- run the tests
- ship the fix
- file a follow-up
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('Pattern 3 still defers to a live native cursor list (❯ 1.)', () => {
    const sample = `
> What's your goal?
❯ 1. **Building a startup**
  2. **Intrapreneurship**
  3. **Hackathon**
`;
    // The ❯1. cursor gate fires first — native list handling owns this.
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  // Pattern 4/5: collapsed-form prose AUQ. stripAnsi destroys the newlines +
  // inter-word spaces, so a real prose AUQ arrives collapsed and defeats the
  // line-anchored Patterns 1-3. These are the dominant Shape-B render mode in
  // the plan-design smoke + floor timeouts — verbatim de-spinnered bytes from
  // the real failing runs (bdm3sucql.output).
  test('matches the real collapsed floor render (colon-delimited, Pattern 4/5)', () => {
    const sample =
      'The review is blocked on D1—reply withA, B, r Cabovetocontinue:' +
      '- A(recommended): Spec thefull P1AskUserQuestioncopy in this review' +
      '-B:LeaveP1copytotheimplementerwithstructuralrequirements' +
      'C: Add a placeholder template to the plan';
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('matches the real collapsed plan-mode render (Recommendation + collapsed A)/B), Pattern 4/5)', () => {
    const sample =
      'Recommendation:A—writethecopynow.(recommended)A) Writ the fullcopy in thisdesign review— now.' +
      '(recommended) Completeness:10/10 B) Leveit to theimplemente — task spec is enough.' +
      'Reply withA (write the copy now)orB(leavetoimplementer)';
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('collapsed-form requires BOTH signals — single B) + word "recommendation" stays false', () => {
    // Only one punctuated letter marker: the two-signal contract is not met.
    const sample =
      'We should consider option B) here. My recommendation is to do it now.';
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('collapsed-form requires letter punctuation — comma-only "ReplywithA,B,orC" stays false', () => {
    // Reply-instruction present, but the letters carry no ) : or ( punctuation,
    // so they could be incidental enumerations in running prose. Stays false.
    const sample = 'ReplywithA,B,orC';
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('collapsed-form does not regress the existing FP guard (see option B) ... point A))', () => {
    // The classic citation FP: a model referencing prior options in prose.
    // No reply-instruction / recommendation marker on its own line, so the
    // collapsed-form signal does not fire either.
    const sample =
      'As noted (see option B) above, and the earlier point A) we discussed, this is fine.';
    expect(isProseAUQVisible(sample)).toBe(false);
  });
});

describe('classifyVisible (runtime path through the runner classifier)', () => {
  // These tests call the actual classifier so a future contributor who
  // reorders branches (e.g. moves the permission short-circuit before
  // isPlanReadyVisible) is caught deterministically.

  test('skill question → returns asked', () => {
    const visible = `
      D1 — Choose your scope mode

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
        3. SELECTIVE EXPANSION
        4. SCOPE REDUCTION
    `;
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('asked');
  });

  test('permission dialog (Bash) → returns null (skip, keep polling)', () => {
    const visible = `
      Bash command \`gstack-update-check\` requires permission to run.

      ❯ 1. Yes
        2. No
    `;
    expect(isNumberedOptionListVisible(visible)).toBe(true); // pre-filter
    expect(classifyVisible(visible)).toBeNull(); // post-filter
  });

  test('plan-ready confirmation → returns plan_ready (wins over asked)', () => {
    const visible = `
      Ready to execute the plan?

      ❯ 1. Yes, proceed
        2. No, keep planning
    `;
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('plan_ready');
  });

  test('silent write to unsanctioned path → returns silent_write', () => {
    const visible = `
      ⏺ Write(src/app/dangerous-write.ts)
      ⎿  Wrote 42 lines
    `;
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('silent_write');
    expect(result?.summary).toContain('src/app/dangerous-write.ts');
  });

  test('write to sanctioned path (.claude/plans) → returns null (allowed)', () => {
    const visible = `
      ⏺ Write(/Users/me/.claude/plans/some-plan.md)
      ⎿  Wrote 42 lines
    `;
    expect(classifyVisible(visible)).toBeNull();
  });

  test('write while a permission dialog is on screen → returns null (gated, not silent, not asked)', () => {
    const visible = `
      ⏺ Write(src/app/edit-with-permission.ts)

      Edit to src/app/edit-with-permission.ts

      Do you want to proceed?

      ❯ 1. Yes
        2. No
    `;
    // The numbered prompt is a permission dialog (Edit to + Do you want to proceed?);
    // silent_write is suppressed because a numbered prompt is visible, AND
    // 'asked' is suppressed because the prompt is a permission dialog.
    expect(classifyVisible(visible)).toBeNull();
  });

  test('write while a real skill question is on screen → returns asked (write is captured but not silent)', () => {
    const visible = `
      ⏺ Write(src/app/foo.ts)

      D1 — Choose your scope mode

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    // The numbered prompt is a skill question, not a permission dialog;
    // silent_write is suppressed (numbered prompt is visible) and the
    // outcome is 'asked' — Step 0 fired.
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('asked');
  });

  test('idle / no signals → returns null', () => {
    const visible = `
      Some prose without any classifier signals.
    `;
    expect(classifyVisible(visible)).toBeNull();
  });

  test('TAIL_SCAN_BYTES is exported as 1500', () => {
    // Shared between runner and routing test; a regression that desyncs the
    // recent-tail window would surface here.
    expect(TAIL_SCAN_BYTES).toBe(1500);
  });

  // D4-B: strictPlanWrites detector. Catches the transcript bug where the
  // model writes findings to the plan file before any AskUserQuestion fires.
  test('strictPlanWrites: plan write before any AUQ → wrote_findings_before_asking', () => {
    const visible = `
      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)
      ⎿  Updated 12 lines
    `;
    const result = classifyVisible(visible, { strictPlanWrites: true });
    expect(result?.outcome).toBe('wrote_findings_before_asking');
    expect(result?.summary).toContain('.claude/plans/some-plan.md');
  });

  test('strictPlanWrites: plan write AFTER an AUQ render → not flagged', () => {
    // AUQ renders first, then the model writes the plan post-answer. This is
    // the legitimate end-of-workflow flow and must NOT trigger the detector.
    const visible = `
      D1 — Some scope question

      ❯ 1. Option A
        2. Option B

      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)
      ⎿  Updated 12 lines
    `;
    const result = classifyVisible(visible, { strictPlanWrites: true });
    // Outcome is 'asked' (the numbered list rendered); the post-AUQ plan
    // write is ignored by the detector.
    expect(result?.outcome).toBe('asked');
  });

  test('strictPlanWrites: AUQ first then plan write — write_pos > auq_pos → not flagged', () => {
    // Same scenario, more explicit ordering: the regex finds the write at a
    // position AFTER the numbered list. Detector lets it through.
    const visible = [
      'D1 — Choose your approach',
      '',
      '❯ 1. Approach A',
      '  2. Approach B',
      '',
      '⏺ Write(/Users/me/.claude/plans/draft.md)',
      '⎿  Wrote 42 lines',
    ].join('\n');
    const result = classifyVisible(visible, { strictPlanWrites: true });
    expect(result?.outcome).toBe('asked');
  });

  test('strictPlanWrites: only a permission dialog visible → plan write still flagged', () => {
    // A permission dialog ❯ 1./2. is NOT an AUQ; pre-AUQ plan writes still
    // hit the detector even when a permission prompt is on screen.
    const visible = `
      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)

      Edit to /Users/me/.claude/plans/some-plan.md

      Do you want to proceed?

      ❯ 1. Yes
        2. No
    `;
    const result = classifyVisible(visible, { strictPlanWrites: true });
    expect(result?.outcome).toBe('wrote_findings_before_asking');
  });

  test('strictPlanWrites OFF: plan write before AUQ → returns null (legacy behavior preserved)', () => {
    const visible = `
      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)
      ⎿  Updated 12 lines
    `;
    // Without strictPlanWrites, the sanctioned-path list lets this through.
    expect(classifyVisible(visible)).toBeNull();
  });
});

describe('parseNumberedOptions', () => {
  test('does not combine an old AUQ prompt with the later ordinary test-case list', () => {
    // B CEO retry, 2026-09-08: the old prompt cursor slid outside the
    // option parser's 4KB window. Its prose fallback then supplied a new
    // five-item test list while the prompt parser retained the old AUQ.
    const visible = '☐Stripe event types\nWhich event should the handler accept?\n' +
      '❯1.Specify one canonical event\n2.Accept all events\n' + '·'.repeat(4200) + '\n' +
      'Minimum required test cases (all must be specified in the plan):\n' +
      '1.Happypath:validcanonicalevent,knownuser→userupdated,emailsent\n' +
      '2.Email failure:emailthrows→userupdated,errorlogged,HTTP200\n' +
      '3.DB timeout: DB throws onuser update →exceptin ropagates, non-200\n' +
      '4.Unkown event typ: non-canonical event→ HTTP200,nouserupdate\n' +
      '5.Unknown user: valid event, usernotinDB→existingguard→HTTP200\n❯1\n';
    const seen = new Set<string>();
    expect(capturePlanCountQuestion(visible, seen, 0, false)).toBeNull();
    expect(seen.size).toBe(0);
  });

  test('extracts options from a clean cursor list', () => {
    const visible = `
      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    const opts = parseNumberedOptions(visible);
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual({ index: 1, label: 'HOLD SCOPE' });
    expect(opts[1]).toEqual({ index: 2, label: 'SCOPE EXPANSION' });
  });

  test('returns empty array on prose-with-numbers (no cursor)', () => {
    expect(parseNumberedOptions('text 1. one 2. two')).toEqual([]);
  });

  test('extracts options when the cursor is INLINE with prompt header (box-layout)', () => {
    // Real /plan-ceo-review rendering: the TTY's cursor-positioning escapes
    // collapse divider + header + prompt + cursor onto one logical line.
    // Subsequent options (2..7) still start their own lines.
    const visible = [
      '────────────────────────────────────────',
      '☐ Review scope                                                     What scope do you want me to CEO-review?                                                     ❯ 1. The branch\'s diff vs main',
      '   Review the full branch: ~10K LOC.',
      '2. A specific plan file or design doc',
      '   You point me at a file (path) and I review that.',
      '3. An idea you\'ll describe inline',
      '4. Cancel — wrong skill',
      '5. Type something.',
      '────────────────────────────────────────',
      '6. Chat about this',
      '7. Skip interview and plan immediately',
    ].join('\n');
    const opts = parseNumberedOptions(visible);
    expect(opts).toHaveLength(7);
    expect(opts[0]).toEqual({ index: 1, label: "The branch's diff vs main" });
    expect(opts[1]?.index).toBe(2);
    expect(opts[6]?.index).toBe(7);
    expect(opts[6]?.label).toBe('Skip interview and plan immediately');
  });

  test('inline-cursor and start-of-line cursor both produce 7 options for the box-layout case', () => {
    // The inline path captures option 1 from the cursor line itself; the
    // subsequent-lines path captures 2..7 with the existing optionRe.
    const inlineLayout = [
      'header text                                                     ❯ 1. first option',
      '2. second',
      '3. third',
    ].join('\n');
    expect(parseNumberedOptions(inlineLayout)).toEqual([
      { index: 1, label: 'first option' },
      { index: 2, label: 'second' },
      { index: 3, label: 'third' },
    ]);

    const cleanLayout = [
      '  ❯ 1. first option',
      '    2. second',
      '    3. third',
    ].join('\n');
    expect(parseNumberedOptions(cleanLayout)).toEqual([
      { index: 1, label: 'first option' },
      { index: 2, label: 'second' },
      { index: 3, label: 'third' },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Per-finding count primitives — Section 3 unit tests #1–#5, #7, #12.
// ────────────────────────────────────────────────────────────────────────────

describe('optionsSignature', () => {
  test('returns a "|"-joined `index:label` string for a clean list', () => {
    const sig = optionsSignature([
      { index: 1, label: 'HOLD SCOPE' },
      { index: 2, label: 'SCOPE EXPANSION' },
    ]);
    expect(sig).toBe('1:HOLD SCOPE|2:SCOPE EXPANSION');
  });

  test('order-independent: shuffled inputs produce the same signature', () => {
    // parseNumberedOptions already returns sorted, but defensive sort means
    // a future caller that hands us shuffled input still produces a stable
    // dedupe signature.
    const a = optionsSignature([
      { index: 2, label: 'B' },
      { index: 1, label: 'A' },
      { index: 3, label: 'C' },
    ]);
    const b = optionsSignature([
      { index: 1, label: 'A' },
      { index: 2, label: 'B' },
      { index: 3, label: 'C' },
    ]);
    expect(a).toBe(b);
  });

  test('empty list returns empty string', () => {
    expect(optionsSignature([])).toBe('');
  });

  test('single-item list returns just that entry', () => {
    expect(optionsSignature([{ index: 1, label: 'Only' }])).toBe('1:Only');
  });
});

describe('COMPLETION_SUMMARY_RE', () => {
  test('matches GSTACK REVIEW REPORT heading', () => {
    expect(COMPLETION_SUMMARY_RE.test('## GSTACK REVIEW REPORT')).toBe(true);
  });

  test('matches Completion Summary heading (ceo + eng)', () => {
    expect(COMPLETION_SUMMARY_RE.test('## Completion Summary')).toBe(true);
    expect(COMPLETION_SUMMARY_RE.test('## Completion summary')).toBe(true);
  });

  test('matches Status: clean (CEO review-log shape)', () => {
    expect(COMPLETION_SUMMARY_RE.test('Status: clean')).toBe(true);
    expect(COMPLETION_SUMMARY_RE.test('Status: issues_open')).toBe(true);
  });

  test('matches VERDICT: line', () => {
    expect(COMPLETION_SUMMARY_RE.test('VERDICT: CLEARED — Eng Review passed')).toBe(true);
  });

  test('does NOT match prose mentions of "verdict" mid-line', () => {
    // VERDICT must be at the start of a line to count.
    expect(COMPLETION_SUMMARY_RE.test('the final verdict: undecided')).toBe(false);
  });

  test('does NOT treat source or proposed diff rows as assistant completion', () => {
    for (const line of [
      '409 +## GSTACK REVIEW REPORT',
      '419 +**VERDICT:** Design Review complete — 8 decisions made.',
      '+## GSTACK REVIEW REPORT',
      '409→## GSTACK REVIEW REPORT',
      'The plan must end with ## GSTACK REVIEW REPORT.',
    ]) expect(COMPLETION_SUMMARY_RE.test(line)).toBe(false);
  });
});

describe('classifyPlanCountFrame replay', () => {
  test('waits through proposed Write approval and tool output, then accepts the actual report', () => {
    // Sanitized rows and native prompt from the failed design-count attempt.
    const proposedDiff = [
      '409 +## GSTACK REVIEW REPORT',
      '416 +| Design Review | 1 | issues_open | score: 2/10 → 8/10, 8 decisions |',
      '419 +**VERDICT:** Design Review complete — 8 decisions made.',
    ].join('\n');
    const permission = [
      'Doyouwanttooverwritegstack-test-plan-design.md?',
      '❯1.Yes',
      '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession;Yes,and',
      'alwaysallowaccessto/tmp/fixtureforthissession',
      '3.No',
      'Esctocancel·Tabtoamend',
    ].join('\n');
    const frames = [
      `${proposedDiff}\n${permission}`,
      `${proposedDiff}\n⏺ Updated gstack-test-plan-design.md`,
      `${proposedDiff}\n⏺ ## GSTACK REVIEW REPORT\nDesign Review complete — 8 decisions made.`,
    ];
    expect(frames.map(classifyPlanCountFrame)).toEqual(['permission', null, 'completion_summary']);
  });

  test('a pending native permission beats even an unnumbered report heading', () => {
    const visible = '## GSTACK REVIEW REPORT\nDoyouwanttooverwriteplan.md?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
    expect(classifyPlanCountFrame(visible)).toBe('permission');
  });

  test('a later report supersedes the granted menu still in short scrollback', () => {
    const permission = 'Doyouwanttooverwriteplan.md?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
    expect(classifyPlanCountFrame(permission)).toBe('permission');
    expect(classifyPlanCountFrame(`${permission}\n● ## GSTACK REVIEW REPORT`)).toBe('completion_summary');
  });

  test('an active question after a prior report keeps the counter running', () => {
    expect(classifyPlanCountFrame('## GSTACK REVIEW REPORT\nOne more choice\n❯1.Add to plan\n2.Defer')).toBeNull();
  });

  test('an active AUQ supersedes a granted permission menu in short scrollback', () => {
    const permission = 'Doyouwanttooverwriteplan.md?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
    const question = '☐ Error handling\nWhich failure path should we test?\n❯1.Timeout\n2.Refusal';
    expect(classifyPlanCountFrame(`${permission}\n${question}`)).toBeNull();
  });

  test('preserves actual report variants and the native plan-ready terminal', () => {
    for (const report of [
      '## GSTACK REVIEW REPORT', '⏺##GSTACKREVIEWREPORT', '●GSTACKREVIEWREPORT',
      '## Completion Summary', '● ## Completion Summary', 'Status: clean', 'Status: issues_open',
      'VERDICT: CLEARED — Eng Review passed', '**VERDICT:** Design Review complete.',
    ]) expect(classifyPlanCountFrame(report)).toBe('completion_summary');
    expect(classifyPlanCountFrame('Ready to execute the plan?\n❯1.Yes\n2.No, keep planning')).toBe('plan_ready');
  });
});

describe('planCountSubmissionInput replay', () => {
  test('uses the captured DevEx panel anchors when the Submit button label is damaged', () => {
    const captured = [
      '←  ☒ Routing setup  ☐ Cross-project  ✔ Submit  →',
      'Review your answers',
      '⚠You have not answere all questions',
      ' │ ●D1 — Shouldgstack add skill routingrulestothisproject\'sCLAUDE.md?<gstack-qid:routing-injection>',
      '→dd routing rules (Recmmeded)',
      'Ready to submit your answers?',
      '❯1.Sbmi answers',
      '2Cancel',
    ].join('\r\r');
    expect(planCountSubmissionInput(captured)).toBe('\x1b[Z');
    expect(planCountSubmissionInput(captured.replace('☐ Cross-project', '☒ Cross-project'))).toBe('\r');
    expect(planCountSubmissionInput(captured + '\r☐ Retry spec\rRetry once?\r❯1.Yes\r2.No')).toBeNull();
    expect(planCountSubmissionInput(captured + '\r☐ Proposal\rSend this proposal?\r❯1.Submit proposal\r2.Keep editing')).toBeNull();
    expect(planCountSubmissionInput(captured + '\r☐ Retry spec\rRetry once?\r❯2.No\r3.Other')).toBeNull();
    expect(planCountSubmissionInput(captured.replace('Review your answers', 'Review context'))).toBeNull();
    expect(planCountSubmissionInput(captured.replace('Ready to submit your answers?', 'Read the proposed answers.'))).toBeNull();
  });

  test('the captured mode Submit panel with a damaged caption and dotless cursor returns to its unanswered tab', () => {
    // Exact final active panel from targeted-a's SCOPE EXPANSION retry.
    const captured = [
      '←  ☒ Routing rule  ☐ Design doc  ✔ Submit  →',
      '',
      'Review your answrs',
      '⚠ You hvenot answered all questions',
      " ● Add gstack skill routing rules tothisproject'sCLAUDE.md?",
      '→dd routing rues (Recommnded)',
      '',
      'Ready to submit your answers?',
      '',
      '❯1Submit answers',
      '  2. Cancel',
    ].join('\r');
    expect(planCountSubmissionInput(captured)).toBe('\x1b[Z');
    const answered = captured.replace('☐ Design doc', '☒ Design doc').replace('⚠ You hvenot answered all questions', '');
    expect(planCountSubmissionInput(answered)).toBe('\r');
    expect(planCountSubmissionInput(captured + '\r☐ Design doc\rRun office hours?\r❯1Run now\r2.Skip')).toBeNull();
  });

  const incomplete = [
    '←  ☒ Learnings scope  ☐ Approach  ✔ Submit  →',
    'Review your answers',
    '⚠You have not answered all questions',
    ' │ ●D1 — Cross-project learnings: Enable searching learnings from your other local projects?',
    '→Enable cross-project (Recommended)',
    'Ready t submit your answers?',
    '❯1.Submit aswers',
    '2Cancel',
  ].join('\r\r');

  test('returns to the unanswered tab, then submits only after both answers', () => {
    expect(planCountSubmissionInput(incomplete)).toBe('\x1b[Z');
    const nextQuestion = [
      '←  ☒ Learnings scope  ☐ Approach  ✔ Submit  →',
      '│ Which approach should this plan use?',
      '❯1.Extend the existing dispatcher',
      '2.Add a separate handler',
    ].join('\r\r');
    expect(planCountSubmissionInput(`${incomplete}\r${nextQuestion}`)).toBeNull();
    const question = capturePlanCountQuestion(nextQuestion, new Set(), 0, true);
    expect(question?.promptSnippet).toContain('Which approach');
    expect(question?.options).toHaveLength(2);
    const answered = incomplete.replace('☐ Approach', '☒ Approach').replace('⚠You have not answered all questions', '');
    expect(planCountSubmissionInput(answered)).toBe('\r');
  });

  test('navigates to the first unanswered tab when more than one remains', () => {
    const frame = incomplete.replace('☒ Learnings scope  ☐ Approach', '☐ Learnings scope  ☐ Approach  ☒ Mode');
    expect(planCountSubmissionInput(frame)).toBe('\x1b[Z\x1b[Z\x1b[Z');
  });

  test('does not revisit a stale submit panel when a later single question is active', () => {
    expect(planCountSubmissionInput(`${incomplete}\r☐ Retry spec\rRetry once?\r❯1.Yes\r2.No`)).toBeNull();
    expect(planCountSubmissionInput('Ready to submit the plan?\n❯1.Submit\n2.Cancel')).toBeNull();
  });
});
