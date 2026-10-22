/**
 * Deterministic unit tests for AskUserQuestion fingerprinting and native matching (test/helpers/pty/auq.ts).
 * Split along the W4 module seams from the former claude-pty-runner.unit.test.ts;
 * tests import the public barrel, test/helpers/claude-pty-runner.ts.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseNumberedOptions,
  parseQuestionPrompt,
  stripAnsi,
  auqFingerprint,
  classifyPlanCountFrame,
  capturePlanCountQuestion,
  matchesNativePlanQuestion,
  createPlanCountPermissionGuard,
  planCountPrerequisitePick,
  engStep0Boundary,
  planCountQuestionPhase,
} from './claude-pty-runner';

describe('pending native question on a damaged option render', () => {
  // Exact final B CEO Test scope shape. The native call had been read in
  // an in-progress snapshot, but option 2's missing dot prevented input.
  const frame = [
    '☐Test scope',
    '│Section 6 (Tests) — Theplanhasnotestsforanewpaymentprocessingcodepath.Theexistingintegrationsuitehas',
    '│never seen this handlerand cannotcatchregressionsinit.Minimumviabletestplanforminimalpatch:5unittests',
    '│(happy path, mal failur, DB timeout, unknowneventtype,unknownuser).Shouldtheplanalsoincludeanintegration',
    '│testhittingthefullwebhookstack?<gstack-qid:plan-ceo-test-scope>',
    '❯1.Unittestsonlyfornow(recommended)',
    '5 unit tests covering the criticalpaths. No integration stin v1.',
    '2Uni tsts + one integration test',
    '5 uit tsts + on ed-to-end integrationtestsendiga signe Stripeevent.',
    '3.Integrationtestonly',
    '4.Typesomething.',
    '5. Chataboutthis',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    '❯1',
  ].join('\n');
  const pending = {
    sessionId: '66fb6218-4a68-4f1a-a729-6407f14fd6b8',
    toolUseId: 'toolu_017DicePqWNVyDsLCd2Y2MCi', answered: false,
    questions: [{ header: 'Test scope', question: 'Should the plan also include an integration test hitting the full webhook stack? <gstack-qid:plan-ceo-test-scope>',
      options: ['Unit tests only for now (recommended)', 'Unit tests + one integration test', 'Integration test only'].map(label => ({ label })) }],
  };

  test('uses lossless pending options after a positively matched native question has rendered', () => {
    const seen = new Set<string>();
    const captured = capturePlanCountQuestion(frame, seen, 0, false, pending);
    expect(captured?.nativeCall).toBe(pending);
    expect(captured?.options).toEqual(pending.questions[0].options.map((o, i) => ({ index: i + 1, label: o.label })));
    expect(capturePlanCountQuestion(frame, seen, 1, false, pending)).toBeNull();
    // A corrected redraw is still the same pending native question.
    expect(capturePlanCountQuestion(frame.replace('2Uni tsts', '2.Unit tests'), seen, 2, false, pending)).toBeNull();
    expect(capturePlanCountQuestion(frame.replace('2Uni tsts', '2.Unit tests'), seen, 3, false)).toBeNull();
    expect(seen.has(captured!.signature)).toBe(true);
  });

  test('binds delayed native metadata to the already-answered visible question', () => {
    const seen = new Set<string>();
    const clean = frame.replace('2Uni tsts', '2.Unit tests');
    expect(capturePlanCountQuestion(clean, seen, 0, false)).not.toBeNull();
    expect(capturePlanCountQuestion(clean, seen, 1, false, pending)).toBeNull();
    expect(capturePlanCountQuestion(frame, seen, 2, false, pending)).toBeNull();
  });

  test('requires pending single-question metadata, matching current header, cursor, and navigation footer', () => {
    for (const call of [undefined, { ...pending, answered: true }, { ...pending, failed: true },
      { ...pending, questions: [...pending.questions, ...pending.questions] },
      { ...pending, questions: [{ ...pending.questions[0], header: 'Prior decision' }] },
      { ...pending, questions: [{ ...pending.questions[0], question: 'Different issue <gstack-qid:plan-ceo-different-test-scope>' }] }]) {
      expect(capturePlanCountQuestion(frame, new Set(), 0, false, call)).toBeNull();
    }
    for (const altered of [frame.replace('☐Test scope', 'Test scope'), frame.replace('❯1.', '1.'),
      frame.replace('Enter to select · ↑/↓ to navigate · Esc to cancel', ''),
      frame + '\n☐Different question\n❯1.Waiting for its choices']) {
      expect(capturePlanCountQuestion(altered, new Set(), 0, false, pending)).toBeNull();
    }
  });
});

describe('parseQuestionPrompt', () => {
  test('keeps the captured boxed learnings header across native CR and blank borders', () => {
    // Exact active-menu bytes from the targeted-a engineering batching run.
    // Its answered setup AUQ lost the title at the standalone box border,
    // leaving every later finding classified as preReview.
    const raw = "☐ Learnings\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B│ D1 — Cross-project learnings scope <gstack-qid:learnings-cross-project>\u001b[K\r\u001b[1B│\u001b[3G\u001b[K\r\r\n│\u001b[3Ggstack\u001b[10Gcan\u001b[14Gsearch\u001b[21Glearnings\u001b[31Gfrom\u001b[36Gyour\u001b[41Gother\u001b[47Gprojects\u001b[56Gon\u001b[59Gthis\u001b[64Gmachine\u001b[72Gto\u001b[75Gfind\u001b[80Gpatterns\u001b[89Gthat\u001b[94Gmight\u001b[100Gapply\u001b[106Ghere.\u001b[112GThis\r\r\n│\u001b[3Gstays\u001b[9Glocal\u001b[15G—\u001b[17Gno\u001b[20Gdata\u001b[25Gleaves\u001b[32Gyour\u001b[37Gmachine.\u001b[46GRecommended\u001b[58Gfor\u001b[62Gsolo\u001b[67Gdevelopers.\u001b[79GSkip\u001b[84Gif\u001b[87Gyou\u001b[91Gwork\u001b[96Gon\u001b[99Gmultiple\u001b[108Gclient\r\r\n│\u001b[3Gcodebases\u001b[13Gwhere\u001b[19Gcross-contamination\u001b[39Gwould\u001b[45Gbe\u001b[48Ga\u001b[50Gconcern.\r\r\n\r\r\n❯\u001b[3G1.\u001b[6GEnable\u001b[13Gcross-project\u001b[27Glearnings\u001b[37G(Recommended)\r\r\n\u001b[6GSearch\u001b[13Glearnings\u001b[23Gfrom\u001b[28Gall\u001b[32Gprojects\u001b[41Gon\u001b[44Gthis\u001b[49Gmachine\u001b[57G—\u001b[59Gsurfaces\u001b[68Gpatterns\u001b[77Gand\u001b[81Gpitfalls\u001b[90Gfrom\u001b[95Gprior\u001b[101Gsessions.\r\r\n\u001b[3G2.\u001b[6GKeep\u001b[11Glearnings\u001b[21Gproject-scoped\u001b[36Gonly\r\r\n\u001b[6GOnly\u001b[11Guse\u001b[15Glearnings\u001b[25Gfrom\u001b[30Gthis\u001b[35Gproject.\u001b[44GSafe\u001b[49Gfor\u001b[53Gmulti-client\u001b[66Genvironments.\r\r\n\u001b[3G3.\u001b[6GType\u001b[11Gsomething.\r\r\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\r\n\u001b[3G4.\u001b[6GChat\u001b[11Gabout\u001b[17Gthis\r\r\n\r\r\nEnter\u001b[7Gto\u001b[10Gselect\u001b[17G·\u001b[19G↑/↓\u001b[23Gto\u001b[26Gnavigate\u001b[35G·\u001b[37GEsc\u001b[41Gto\u001b[44Gcancel";
    const visible = stripAnsi(raw);
    const question = capturePlanCountQuestion(visible, new Set(), 0, true)!;
    expect(question.promptSnippet).toStartWith('Learnings D1 — Cross-project learnings scope');
    expect(question.promptSnippet).toContain('<gstack-qid:learnings-cross-project>');
    expect(engStep0Boundary(question)).toBe(true);
    const phase = planCountQuestionPhase(question, false, engStep0Boundary);
    expect(phase).toEqual({ preReview: true, reviewStarted: true });
  });

  test('keeps a long boxed question identity instead of its closing recommendation', () => {
    const frame = [
      'Planning: /tmp/hermetic/.claude/plans/review.md',
      '─'.repeat(120),
      '☐ Architecture',
      '│ D2 — Architecture: custom retry scheduler vs library built-in <gstack-qid:arch-custom-retry-vs-library>',
      '│',
      ...Array.from({ length: 12 }, (_, i) => `│ Review context line ${i}: the proposed retry behavior and its tradeoffs.`),
      '│',
      '│ Net: If the library hook is configurable, use the existing implementation.',
      '❯1.Use library built-in (Recommended)',
      '2.Extract shared retry envelope',
    ].join('\r\r\n');
    const seen = new Set<string>();
    const question = capturePlanCountQuestion(frame, seen, 0, false)!;
    expect(question.promptSnippet).toStartWith('Architecture D2 — Architecture: custom retry scheduler');
    expect(question.promptSnippet).toContain('<gstack-qid:arch-custom-retry-vs-library>');
    expect(question.promptSnippet).not.toContain('Planning:');
    expect(question.promptSnippet.length).toBeLessThanOrEqual(240);
    expect(capturePlanCountQuestion(frame + '\n' + '·'.repeat(6000), seen, 1, false)).toBeNull();
  });

  test('does not reuse an old boxed header for a later unboxed menu', () => {
    const visible = [
      '☐ Old setup',
      'D1 — Cross-project learnings scope',
      '❯1.Enable',
      '2.Skip',
      'Planning: /tmp/hermetic/.claude/plans/review.md',
      'D2 — Choose the retry behavior',
      '❯1.Use library built-in',
      '2.Extract shared retry envelope',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toBe('D2 — Choose the retry behavior');
    expect(prompt).not.toContain('Old setup');
  });

  test('captures 1-line prompt above the cursor', () => {
    const visible = `
      D1 — Pick a mode

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toBe('D1 — Pick a mode');
  });

  test('captures multi-line prompt above the cursor', () => {
    const visible = `
      D2 — Approach selection

      Which architecture should we follow?

      ❯ 1. Bypass existing helper
        2. Reuse existing helper
    `;
    const prompt = parseQuestionPrompt(visible);
    // Multi-line prompts get joined with single spaces.
    expect(prompt).toContain('D2 — Approach selection');
    expect(prompt).toContain('Which architecture should we follow?');
  });

  test('returns "" when no cursor is rendered', () => {
    expect(parseQuestionPrompt('Just some prose.\nNo cursor.')).toBe('');
  });

  test('truncates to 240 chars', () => {
    const longPrompt = 'A'.repeat(500);
    const visible = `${longPrompt}\n\n      ❯ 1. yes\n        2. no`;
    expect(parseQuestionPrompt(visible).length).toBeLessThanOrEqual(240);
  });

  test('does not pull text from a previous numbered list above', () => {
    const visible = `
      ❯ 1. previous answered question
        2. previous option two

      D2 — A new question text

      ❯ 1. fresh option A
        2. fresh option B
    `;
    const prompt = parseQuestionPrompt(visible);
    // Stops at the previous numbered-list line; should NOT contain "previous answered question".
    expect(prompt).toContain('D2 — A new question text');
    expect(prompt).not.toContain('previous answered question');
  });

  test('normalizes whitespace (collapses runs of spaces and tabs)', () => {
    const visible = `D1   —    Spaced     out

      ❯ 1. yes
        2. no`;
    expect(parseQuestionPrompt(visible)).toBe('D1 — Spaced out');
  });

  test('inline-cursor box-layout: extracts prompt text BEFORE ❯1. on the cursor line', () => {
    // Real /plan-ceo-review rendering: divider + ☐ header + prompt text +
    // cursor are all on one logical line because TTY cursor-positioning
    // escapes collapse the box layout under stripAnsi.
    const visible = [
      '──────────────────',
      '☐ Review scope                                                     What scope do you want me to CEO-review?                                                     ❯ 1. The branch\'s diff vs main',
      '2. A specific plan file',
      '3. An idea inline',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    // Should extract "Review scope" and the prompt text, dropping the ☐ box-drawing sigil.
    expect(prompt).toContain('Review scope');
    expect(prompt).toContain('What scope do you want me to CEO-review?');
    expect(prompt).not.toContain('❯');
    expect(prompt).not.toMatch(/^☐/);
  });

  test('keeps the captured design scope prompt ahead of long Planning chrome', () => {
    // The first failed live attempt fingerprinted only the divider/Planning
    // path. Its actual AUQ was later on the active cursor line.
    const visible = [
      '─'.repeat(120),
      `Planning: /tmp/hermetic/.claude/plans/${'long-path-'.repeat(24)}plan.md`,
      '─'.repeat(120),
      "☐Reviewfocus I've rated this Settings Page UI redesign plan 2/10 on design completeness. Want me to focus on specific areas? ❯1.All7passes(Recommended)",
      '2.All7passesbutskipmockups',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toStartWith('Reviewfocus');
    expect(prompt).toContain('design completeness');
    expect(prompt).not.toContain('Planning:');
  });

  test('keeps the captured devex persona header when cursor spacing collapses', () => {
    const visible = [
      `Planning: /tmp/hermetic/.claude/plans/${'long-path-'.repeat(24)}plan.md`,
      '─'.repeat(120),
      '☐Targetpersona D2—WhoistheprimarydeveloperthisSDKtargets? ❯1.AIappbuilder/startupfounder(Recommended)',
      '2.Backend/platformengineer',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toStartWith('Targetpersona');
  });

  test('retains a multiline question while excluding the preceding CLI divider', () => {
    const visible = [
      'Planning: /tmp/hermetic/.claude/plans/plan.md',
      '─'.repeat(120),
      '☐ Review focus',
      'This plan is 2/10 on design completeness.',
      'Want me to focus on specific areas? ❯1.All 7 passes',
      '2.Skip mockups',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toContain('Review focus');
    expect(prompt).toContain('design completeness');
    expect(prompt).toContain('specific areas?');
    expect(prompt).not.toContain('Planning:');
  });
});

describe('auqFingerprint', () => {
  test('returns the same fingerprint for identical inputs', () => {
    const opts = [
      { index: 1, label: 'A' },
      { index: 2, label: 'B' },
    ];
    expect(auqFingerprint('hello', opts)).toBe(auqFingerprint('hello', opts));
  });

  test('different prompts with shared option labels produce DIFFERENT fingerprints', () => {
    // The collision regression Codex F1 caught: option-label-only fingerprints
    // collapsed multiple distinct findings into one when they shared menu shape.
    const sharedOpts = [
      { index: 1, label: 'Add to plan' },
      { index: 2, label: 'Defer' },
      { index: 3, label: 'Build now' },
    ];
    const fpFinding1 = auqFingerprint('D5 — Architecture: bypass helper?', sharedOpts);
    const fpFinding2 = auqFingerprint('D6 — Tests: zero coverage?', sharedOpts);
    expect(fpFinding1).not.toBe(fpFinding2);
  });

  test('same prompt with different options produces DIFFERENT fingerprints', () => {
    const prompt = 'D1 — Pick a mode';
    const fpA = auqFingerprint(prompt, [
      { index: 1, label: 'HOLD SCOPE' },
      { index: 2, label: 'SCOPE EXPANSION' },
    ]);
    const fpB = auqFingerprint(prompt, [
      { index: 1, label: 'HOLD SCOPE' },
      { index: 2, label: 'SCOPE REDUCTION' },
    ]);
    expect(fpA).not.toBe(fpB);
  });

  test('whitespace-only differences in prompt do NOT change the fingerprint', () => {
    // Same content, different rendering whitespace (TTY redraw artifact)
    // must produce the same fingerprint so dedupe survives reflow.
    const opts = [{ index: 1, label: 'A' }, { index: 2, label: 'B' }];
    const fpA = auqFingerprint('Pick   a     mode', opts);
    const fpB = auqFingerprint('Pick a mode', opts);
    expect(fpA).toBe(fpB);
  });

  test('empty prompt + same options collide (caller must guard against this)', () => {
    // Documents the contract: empty-prompt fingerprints WILL collide if the
    // caller fingerprints them. runPlanSkillCounting must skip empty-prompt
    // AUQs and re-poll instead.
    const opts = [{ index: 1, label: 'A' }];
    expect(auqFingerprint('', opts)).toBe(auqFingerprint('', opts));
  });
});

describe('capturePlanCountQuestion replay', () => {
  test('keeps captured CEO/eng fingerprints stable as later output trims the trailing window', () => {
    // Exact prompt/option fields from the 07:30 corrected paid attempts.
    // Both counted an answered Step0 question again as a review finding
    // once the moving tail omitted the beginning of its prompt.
    const captures = [
      {
        prompt: '☐ RevewMode Which review mode should I use for the remaining sections?',
        labels: [
          'HOLD SCOPE — make it         ┌┐',
          'SELECTIVEEXPANSION—│Focus:catcheverylandmineinApproachA│',
          'SCOPEREDUCTION—strip│Tests:whatmustbecovered│',
          'SCOPEEXPANSION—think│Observability:whatlogs/metricsareneeded│',
        ],
      },
      {
        prompt: '☐ Scope cut │ D2 — Scope reduction proposal: drop TokenStore and RequestPolicy as standalone classes, inject AuthCache rather than │ exportitglobally.Acceptthisreductionbeforethesection-by-sectionreviewbegins? │ <gstack-qid:plan-eng-review-',
        labels: [
          'Acceptscopereduction┌───────────────────────────────────────────────────┐',
          'Proceedfullscopeas-is│AuthBroker│',
        ],
      },
    ];
    for (const capture of captures) {
      const options = capture.labels.map((label, i) => `${i === 0 ? '❯' : ''}${i + 1}.${label}`).join('\n');
      const frame = `${capture.prompt}\n${options}`;
      const seen = new Set<string>();
      const first = capturePlanCountQuestion(frame, seen, 0, true)!;
      expect(first).not.toBeNull();
      // Leave the original menu within the trailing4KB, but move the
      // start of that window into its question text, twice in succession.
      const paddingLength = 4096 - options.length - 30;
      for (const extra of [0, 15]) {
        const advanced = frame + '\n' + '·'.repeat(paddingLength + extra - 1);
        expect(advanced.slice(-4096)).not.toContain(capture.prompt);
        expect(parseNumberedOptions(advanced)).toEqual(first.options);
        expect(parseQuestionPrompt(advanced)).toBe(first.promptSnippet);
        expect(auqFingerprint(parseQuestionPrompt(advanced), parseNumberedOptions(advanced))).toBe(first.signature);
        expect(capturePlanCountQuestion(advanced, seen, extra + 1, false)).toBeNull();
      }
      const next = `${frame}\n${'·'.repeat(paddingLength)}\n☐ Next decision Should the revised plan use these same choices?\n${options}`;
      const distinct = capturePlanCountQuestion(next, seen, 20, false)!;
      expect(distinct).not.toBeNull();
      expect(distinct.signature).not.toBe(first.signature);
      expect(distinct.preReview).toBe(false);
      expect(seen.size).toBe(2);
    }
  });

  test('counts consecutive findings with identical choices and ignores redraws', () => {
    const options = '\n❯1.Add to plan\n2.Defer\n3.Skip';
    const seen = new Set<string>();
    const frames = [
      `D5 — SQL: interpolate the request parameter?${options}`,
      `D5  —   SQL: interpolate the request parameter?${options}`,
      `D6 — Tests: no coverage for the webhook?${options}`,
      `D6 — Tests: no coverage for the webhook?${options}`,
    ];
    const captured = frames.map((frame, i) => capturePlanCountQuestion(frame, seen, i, false));
    expect(captured.map((question) => question !== null)).toEqual([true, false, true, false]);
    expect(captured[0]?.signature).not.toBe(captured[2]?.signature);
    expect(captured[2]?.promptSnippet).toContain('Tests: no coverage');
  });

  test('does not consume an incomplete frame before its prompt arrives', () => {
    const seen = new Set<string>();
    const options = '❯1.Add to plan\n2.Defer';
    expect(capturePlanCountQuestion(options, seen, 0, true)).toBeNull();
    expect(capturePlanCountQuestion(`D1 — Pick an approach\n${options}`, seen, 1, true)).not.toBeNull();
  });

  test('answers the captured CEO retry question with a numeric-leading first label', () => {
    // The live timeout sat on this question because the first label begins
    // with "1retryattempt"; it was incorrectly rejected as a decimal token.
    const frame = [
      ' ☐ Retry spec',
      "│ Section 5/6 finding: 'retry-with-backoff fires once, then fails clean' is ambiguous.",
      "│ What does 'fires once' mean?",
      '❯1.1retryattempt—Stripecalledexactly2timestotal(Recommended)',
      'Themostnaturalreading:1originalattempt+1retry=2totalStripecalls.',
      '2.Addaclarifyingcommenttotheplan—lettheimplementerdecide',
      '3.Theretrymechanismhandlesit—justassertfailureisreturned',
      '4.Typesomething.',
      '5.Chataboutthis',
      'Entertoselect·↑/↓tonavigate·Esctocancel',
    ].join('\r\r');
    const question = capturePlanCountQuestion(frame, new Set(), 0, false);
    expect(question?.options.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5]);
    expect(question?.options[0]?.label).toBe('1retryattempt—Stripecalledexactly2timestotal(Recommended)');
    expect(question?.promptSnippet).toContain('Section 5/6 finding');
    expect(question?.promptSnippet).not.toContain('Planning:');
  });

  test('still ignores decimal numbers inside option labels', () => {
    const frame = 'Choose the retry delay\r❯1.1.5 seconds\r2.Wait 2.5 seconds\r3.No retry';
    expect(parseNumberedOptions(frame)).toEqual([
      { index: 1, label: '1.5 seconds' },
      { index: 2, label: 'Wait 2.5 seconds' },
      { index: 3, label: 'No retry' },
    ]);
  });
});

describe('planCountPrerequisitePick replay', () => {
  test('declines captured office-hours prerequisite menus by label in either order', () => {
    // Captured 2026-09-08 CEO/Devex prerequisite surfaces: the default index
    // sometimes starts office-hours, changing the seeded review's input.
    const captures = [
      {
        prompt: 'No design doc found for this branch. `/office-hours` produces a structured problem statement, premise challenge, and explored alternatives — it gives this review much sharper input. Run it now, or skip and proceed with standard review?',
        labels: ['Skip — proceed with standard review (Recommended)', 'Run /office-hours first'],
      },
      {
        prompt: 'D2 — No design doc found. Run /office-hours first? <gstack-qid:plan-ceo-prereq-office-hours>',
        labels: ['Skip — standard review (recommended)', 'Run /office-hours now'],
      },
      {
        prompt: 'D3 — Run /office-hours first to produce a design doc for sharper input?',
        labels: ['Skip — proceed with standard review (recommended)', 'Run /office-hours now'],
      },
    ];
    for (const { prompt, labels } of captures) {
      for (const reversed of [false, true]) {
        for (const collapsed of [false, true]) {
          const ordered = reversed ? [...labels].reverse() : labels;
          const text = ['☐ Prerequisite', prompt, `❯1.${ordered[0]}`, `2.${ordered[1]}`, '3.Type something.', '4.Chat about this'].join('\r');
          const frame = collapsed ? text.replace(/ /g, '') : text;
          const fp = capturePlanCountQuestion(frame, new Set(), 0, true)!;
          expect(fp).not.toBeNull();
          expect(planCountPrerequisitePick(fp)).toBe(reversed ? 2 : 1);
          expect(planCountPrerequisitePick({ ...fp, preReview: false })).toBeNull();
        }
      }
    }
  });

  test('keeps existing answers for incomplete, unrelated, and ambiguous menus', () => {
    const fp = capturePlanCountQuestion(
      '☐ Prerequisite\rNo design doc found. Run /office-hours first?\r❯1.Run /office-hours now\r2.Skip — proceed with standard review',
      new Set(), 0, true,
    )!;
    expect(planCountPrerequisitePick({ ...fp, promptSnippet: 'No design doc found.' })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, promptSnippet: 'Should /office-hours skip the required SDK validation finding?' })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, promptSnippet: 'Want a second opinion from /office-hours?' })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [{ index: 1, label: 'Run /office-hours now' }, { index: 2, label: 'Skip' }] })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [{ index: 1, label: 'Add to plan' }, fp.options[1]] })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [...fp.options, { index: 3, label: 'Skip — standard review' }] })).toBeNull();
  });
});

describe('file permission lifecycle replay', () => {
  const permission = (file = 'gstack-test-plan-design.md') => [
    `Do you want to make this edit to ${file}?`,
    '❯ 1. Yes',
    '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession;Yes,and',
    'alwaysallowaccessto/tmp/fixtureforthissession',
    '3.No',
    'Esctocancel·Tabtoamend',
  ].join('\n');

  test('ignores the granted menu and its redraw until a new request follows file-tool completion', () => {
    const guard = createPlanCountPermissionGuard();
    const first = permission();
    expect(guard(first)).toBe('grant');
    expect(guard(first)).toBe('handled');
    const redraw = first + '\n' + permission();
    expect(guard(redraw)).toBe('handled');
    const completed = redraw + '\n●Write(/tmp/fixture/gstack-test-plan-design.md)\n' +
      '⎿ Wrote320linesto../fixture/gstack-test-plan-design.md\n' + '·'.repeat(1600);
    expect(classifyPlanCountFrame(completed)).toBeNull();
    expect(guard(completed)).toBe('handled');
    expect(guard(completed + '\n' + permission())).toBe('grant');
  });

  test('singular native Write/Edit results release a fresh identical permission', () => {
    for (const result of ['⎿ Added1line,removed1line', '⎿ Wrote1lineto../fixture/plan.md', '⎿ Removed1line', '⎿\u00a0Wrote320linesto../fixture/plan.md']) {
      const guard = createPlanCountPermissionGuard();
      const first = permission();
      expect(guard(first)).toBe('grant');
      const completed = first + '\n' + result;
      expect(guard(completed)).toBe('handled');
      expect(guard(completed + '\n' + permission())).toBe('grant');
    }
  });

  test('the captured active Edit menu remains a permission behind a long diff repaint', () => {
    const visible = permission('gstack-test-plan-ceo.md') + '\n' +
      '  89 +The plan adds StripePaymentWebhookHandler outside WebhookDispatcher.\n'.repeat(40);
    expect(visible.length).toBeLessThan(4096);
    expect(classifyPlanCountFrame(visible)).toBeNull(); // The old 1.5 KB scan misses it.
    const guard = createPlanCountPermissionGuard();
    expect(guard(visible)).toBe('grant');
    expect(guard(visible)).toBe('handled');
  });

  test('a completed Write invalidates an old menu even if polling missed the original grant', () => {
    const visible = permission() + '\n⎿ Wrote320linesto../fixture/gstack-test-plan-design.md';
    expect(createPlanCountPermissionGuard()(visible)).toBe('handled');
  });

  test('proposed results and tool headers do not release the same pending permission', () => {
    const guard = createPlanCountPermissionGuard();
    let visible = permission();
    expect(guard(visible)).toBe('grant');
    for (const line of ['320 +⎿ Wrote320lines', '●Write(/tmp/fixture/plan.md)', '⎿ Tip: use /btw', '⎿ Error: denied']) {
      visible += '\n' + line + '\n' + permission();
      expect(guard(visible)).toBe('handled');
    }
  });

  test('a different file and a genuine native file-policy question retain their own input', () => {
    const guard = createPlanCountPermissionGuard();
    const first = permission('first.md');
    expect(guard(first)).toBe('grant');
    expect(guard(first + '\n' + permission('FIRST.md'))).toBe('grant'); // Targets remain case-sensitive.
    expect(guard(first + '\n' + permission('second.md'))).toBe('grant');
    const question = '\n☐ File policy\nDo you want to create first.md?\n❯1.Yes\n2.No\n' +
      'Enter to select · ↑/↓ to navigate · Esc to cancel';
    expect(guard(first + question)).toBeNull();
    expect(capturePlanCountQuestion(first + question, new Set(), 0, true)?.promptSnippet).toContain('File policy');
  });
});

describe('completed permission cannot become a queued review answer (captured G)', () => {
  // Exact captured post-Write frame; the temporary repository path is sanitized.
  // The damaged "wat" came from the CLI redraw, not the underlying question.
  const captured = " real,specificgaps (Visual Hierachy, Spacing, Color, Typography,Motion)\r22-Itpreservesstrongaccessibilityandresponsivespecsfromtheexistingbehaviordescription\r23 -DESIGN.md exist andsuppliescorrectvaluesforall5gaps\r24\r 25 A 10/10would:\r26-Specifytheexactchangeforeachgap(concretetoken,before→after)\r27 -Add intection state table(loading,empty,error,success,partial)\r28-Storyboardtheuserjourney\r 29- Call out which DESIGN.md tokens each fix applies\r30-Resolveallimplementationambiguitiesbeforeadeveloperpicksitup\r31\r32 **DESIGN.md status:** Presnt and detailed. Spacing scale, clor system, typography,interacton patterns,andc\r  omponentbehavior re all specified. This review calbrates against it.\r33\r34 **Exsting design lverage:**\r35 -Button, Field, InlineStatus,ErrorSummary,ConfirmationDialogcomponentsreusedas-is\r36-Focusring:2pxsolid#1d4ed8,offset2px(alreadyspecified)\r37 -8px bae spacingscalealreadyestablished\r38\r39 ---\r40\r41 ## Review Passes\r42\r43*(Populatedprogressivelyasthereviewproceeds)*\r44\r╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\r Do you wat to create gstack-test-plan-design.md?\r❯ 1. Yes\r2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)for this session; Yes,an\r      always allow access to /tmp/fixture for this session\r  3.Nohift+tab)\r\rEsc to cancl ·Tab to amend\u000f\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\rRan1shellcommand\r\r●Scopegate:planmodeactive—auto-selectingB(reviewingPLAN.mdintheworkingdirectory).\r\rSkippingroutinginjection—thisisareviewfixturerepo.Nowrunningthepre-reviewaudit.\r\rRead2 files, ran1 shell command\r\r●Now let me read the review sectons fil as required by theskill.\r\rRead file, ran 1shellcommand\r\r●Nopriorlearnings found. Cross-project config isnot set — will ask once Ihavetheuser'sattention.\r\rPreReview System Audit:\r- DESIGN.md:exists and comprehensive (spacing, typography, color, interactionpatternsallspecified)\r- UIscope:APPUIclassifier—account-settingsformwithProfile+Notificationssections\r- 5 gaps explicily listed in the plan; l have corresponding specin DESIGN.md\r-N rior design reviews inth reviewlog\r- NoTODOS.mdexists\r\rStep0 Assessment:\r\rInitial scor: 5/10. The plan correctly identifies5realgapsandpreservesstrongaccessibilityandresponsivespecs\rinheritedfromtheexistingbehaviordescription.A10/10wouldspecifyHOWeachgapisresolved(concretecomponent\rchanges,tokenvalues,before/afterlayout),notjustnametheproblem.TheDESIGN.mdalreadyhasallcorrectvalues;\rtheplanjustneedstoreferencethem.\r\rWritingtheinitialplanfilenowbeforeaskingStep0D.\r\r●Write(/tmp/fixture/gstack-test-plan-design.md)\r\r✢ Undulatig… (2m 0s ·↓ 5.4 okens)\r ⎿  Tip:Use/btwtoaskaquicksidequestionwithoutinterruptingClaude'scurrentwork\r                                                                                   ● high · /effort\r────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r❯ \r────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r ⏸ plan mod on(shift+tab tocycle)·esctointerrupt·←foragents\u001b[?25h\u001b[?25l\r●No prior earnings found.Cross-projectconfigisnotset—willaskonceIhavetheuser'sattention.\r Pre-Review System Audit:\r-DESIGN.md:existsandcomprehensive(spacing,typography,color,interactionpatternsallspecified)\r- UI scope: APP UI classifier — account-settings fomwith Prfile + Notifications sctions\r-5gapsexplicitlylistedintheplan;allhavecorrespondingspecinDESIGN.md\r- Noprior desigreviwsin the reviewlog\r-NoTODOS.mdexists\r\rStep0Assessment:\r\rInitialscore:5/10.Theplancorrectlyidentifies5realgapsandpreservesstrongaccessibilityandresponsivespecs\r inheted from theexisting behavir desription.A 10/10would specify HOWechgapi eolved (ccretecomponent\rchanges,tokenvalues,before/afterlayout),notjustnametheproblem.TheDESIGN.mdalreadyhasallcorrectvalues;\rth plan just neds to referencethem.\r\rWriting theinitial plan lenow before ask Step 0D.\r\r●Write(/tmp/fixture/gstack-test-plan-design.md)\r⎿ Wrote 44 lines";

  test('a missed grant followed by native Write completion sends no stale answer', () => {
    const guard = createPlanCountPermissionGuard();
    expect(classifyPlanCountFrame(captured)).toBeNull();
    expect(guard(captured)).toBe('handled');
    expect(capturePlanCountQuestion(captured, new Set(), 0, true)).toBeNull();
  });

  test('the same damaged active file permission grants once and never counts as a finding', () => {
    const menu = captured.slice(captured.indexOf('Do you wat'), captured.indexOf('Esc to cancl')) + 'Esc to cancl ·Tab to amend';
    const guard = createPlanCountPermissionGuard();
    expect(guard(menu)).toBe('grant');
    expect(guard(menu)).toBe('handled');
    expect(capturePlanCountQuestion(menu, new Set(), 0, false)).toBeNull();
    const completed = menu + '\n⎿ Wrote 44 lines';
    expect(guard(completed)).toBe('handled');
    expect(guard(completed + '\n' + menu)).toBe('grant');
  });

  test('plain legacy file decisions remain questions without native permission controls', () => {
    const frame = 'Do you want to create first.md?\n❯1.Create the reviewed file\n2.Keep the current layout';
    expect(classifyPlanCountFrame(frame)).toBeNull();
    expect(createPlanCountPermissionGuard()(frame)).toBeNull();
    expect(capturePlanCountQuestion(frame, new Set(), 0, false)?.options).toHaveLength(2);
  });

  test('a matching native finding can discuss file permissions without being consumed', () => {
    const question = {
      header: 'File policy',
      question: 'Should we create a file that documents always allow access to the project?',
      options: [{ label: 'Create it' }, { label: 'Keep current policy' }],
    };
    const pending = { sessionId: 'file-policy', toolUseId: 'file-finding', answered: false, questions: [question] };
    const frame = captured + '\n☐ ' + question.header + '\n' + question.question +
      '\n❯1.Create it\n2.Keep current policy\nEnter to select · ↑/↓ to navigate · Esc to cancel';
    expect(classifyPlanCountFrame(frame)).toBeNull();
    expect(createPlanCountPermissionGuard()(frame)).toBeNull();
    expect(capturePlanCountQuestion(frame, new Set(), 0, false, pending)?.nativeCall).toBe(pending);
    expect(capturePlanCountQuestion(frame, new Set(), 0, false)?.promptSnippet).toContain('File policy');
  });
});

describe('native question identity outranks permission wording', () => {
  const question = {
    header: 'File policy',
    question: 'D1 — Should we create a file that documents always allow access to the project? <gstack-qid:plan-eng-review-file-policy>',
    options: [{ label: 'Create it' }, { label: 'Keep current policy' }],
  };
  const pending = { sessionId: 'file-policy', toolUseId: 'finding', answered: false, questions: [question] };
  const frame = '☐ File policy\n' + question.question + '\n❯1.Create it\n2.Keep current policy\nEnter to select · ↑/↓ to navigte · Esc to cancel';
  test('full native question and every option establish identity despite a damaged footer', () => {
    // This is the formerly conflicting pure classifier result. The counting
    // loop must consult native identity before taking its permission action.
    expect(classifyPlanCountFrame(frame)).toBe('permission');
    expect(matchesNativePlanQuestion(frame, pending)).toBe(true);
    const seen = new Set<string>();
    expect(capturePlanCountQuestion(frame, seen, 0, false, pending)?.nativeCall).toBe(pending);
    expect(capturePlanCountQuestion(frame, seen, 1, false, pending)).toBeNull();
  });
  test('same header, changed choices, missing identity and an overlaid real permission cannot borrow a native call', () => {
    for (const different of [
      frame.replace('Should we create a file', 'Should we delete the file'),
      frame.replace('2.Keep current policy', '2.Allow all edits'),
      frame.replace(question.question, 'A different question with the same header?'),
      frame + '\nDo you want to create actual.md?\n❯1.Yes\n2.Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel · Tab to amend',
    ]) expect(matchesNativePlanQuestion(different, pending)).toBe(false);
    expect(capturePlanCountQuestion(frame, new Set(), 0, false, { ...pending, failed: true })).toBeNull();
    expect(capturePlanCountQuestion(frame, new Set(), 0, false)).toBeNull();
  });
});
