/**
 * Deterministic unit tests for the per-skill boundary predicates (test/helpers/pty/boundaries.ts).
 * Split along the W4 module seams from the former claude-pty-runner.unit.test.ts;
 * tests import the public barrel, test/helpers/claude-pty-runner.ts.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  auqFingerprint,
  capturePlanCountQuestion,
  ceoStep0Boundary,
  engStep0Boundary,
  engSetupAUQ,
  engFirstReviewAUQ,
  designStep0Boundary,
  planCountQuestionPhase,
  nativePlanCallFingerprint,
  devexStep0Boundary,
  type AskUserQuestionFingerprint,
  pickDesignFocusAll,
} from './claude-pty-runner';

describe('Step0BoundaryPredicate per-skill', () => {
  // Helper to build a synthetic fingerprint for predicate tests.
  function fp(promptSnippet: string, optionLabels: string[]): AskUserQuestionFingerprint {
    const options = optionLabels.map((label, i) => ({ index: i + 1, label }));
    return {
      signature: auqFingerprint(promptSnippet, options),
      promptSnippet,
      options,
      observedAtMs: 0,
      preReview: true,
    };
  }

  describe('native Cross-project onboarding boundary', () => {
    // Fresh paid run D, 2026-09-08: native question stems, labels and
    // successful answers. Long explanatory paragraphs are omitted; they
    // must not determine this structural setup boundary.
    const captured = [
  {
    "header": "Routing rules",
    "question": "Should I add gstack skill routing rules to your project's CLAUDE.md? (Note: we're in plan mode — if you pick A, I'll make the edit after we exit plan mode.)",
    "options": [
      "Add routing rules (recommended)",
      "Skip — invoke manually"
    ],
    "answer": "Add routing rules (recommended)"
  },
  {
    "header": "Scope challenge",
    "question": "D2 — The plan introduces 4 new classes across 12 files. Should I flag scope reduction as a primary recommendation in the review, or accept the 4-class design and focus findings on quality issues?",
    "options": [
      "Accept 4-class design, focus on quality",
      "Flag scope reduction as primary finding (recommended)"
    ],
    "answer": "Accept 4-class design, focus on quality"
  },
  {
    "header": "Cross-project",
    "question": "D3 — Should gstack search learnings from your other projects on this machine when reviewing?",
    "options": [
      "Enable cross-project learnings (recommended)",
      "Keep learnings project-scoped only"
    ],
    "answer": "Enable cross-project learnings (recommended)"
  },
  {
    "header": "AuthCache race",
    "question": "D4 — AuthCache is shared mutable state mutated by two services with no serialization. How should we fix it?",
    "options": [
      "Single-writer: AuthBroker owns all writes (recommended)",
      "Immutable cache + versioned replace",
      "Accept and document the race"
    ],
    "answer": "Single-writer: AuthBroker owns all writes (recommended)"
  },
  {
    "header": "Double-cache risk",
    "question": "D5 — The plan introduces a new AuthCache class but doesn't say what happens to the existing cache adapter. Are they running in parallel?",
    "options": [
      "AuthCache replaces the adapter — add migration to plan (recommended)",
      "AuthCache wraps the adapter — adapter stays as storage layer",
      "Leave ambiguous — clarify in implementation"
    ],
    "answer": "AuthCache replaces the adapter — add migration to plan (recommended)"
  },
  {
    "header": "Error swallowing",
    "question": "D6 — validateAndDispatch() swallows three different error classes across nested try/catch blocks. How should this be resolved in the plan?",
    "options": [
      "Decompose + typed error results (recommended)",
      "Keep structure, add logging + rethrow",
      "Leave as-is — document that swallowing is intentional"
    ],
    "answer": "Decompose + typed error results (recommended)"
  },
  {
    "header": "Invalidation tests",
    "question": "D7 — When AuthCache replaces the existing adapter (per D5), the existing invalidation tests (logout, revocation, tenant suspension) become dead — they're testing a retired object. Should the plan explicitly require migrating them?",
    "options": [
      "Migrate invalidation tests to AuthCache — add to plan (recommended)",
      "Scope to new component tests only — leave invalidation as follow-up",
      "Assume existing tests cover it — no explicit migration step"
    ],
    "answer": "Migrate invalidation tests to AuthCache — add to plan (recommended)"
  },
  {
    "header": "IDP parallelization",
    "question": "D8 — The plan identifies 5 sequential IDP calls that are independent and could be parallelized with Promise.all. Should we include the fix in this PR or defer it?",
    "options": [
      "Parallelize with Promise.all in this PR (recommended)",
      "Defer to TODOS.md",
      "Leave sequential — document as known limitation"
    ],
    "answer": "Parallelize with Promise.all in this PR (recommended)"
  }
];
    const fingerprint = (index: number) => {
      const row = captured[index];
      return nativePlanCallFingerprint({
        sessionId: 'fresh-eng-cross-project', toolUseId: `call-${index}`, answered: true,
        questions: [{ header: row.header, question: row.question, options: row.options.map(label => ({ label })) }],
        answers: { [row.question]: row.answer },
      }, index, true);
    };

    test('keeps D3 as setup and counts each following actual review call', () => {
      let started = false;
      const phases = captured.map((_, i) => {
        const phase = planCountQuestionPhase(fingerprint(i), started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
        started = phase.reviewStarted;
        return phase;
      });
      expect(phases.slice(0, 3).map(p => p.preReview)).toEqual([true, true, true]);
      expect(phases[2].reviewStarted).toBe(true);
      expect(phases.slice(3).map(p => p.preReview)).toEqual([false, false, false, false, false]);
    });

    test('the captured no-qid scope decision stays setup after Learnings scope', () => {
      let started = false;
      const phases = [0, 2, 1, 3, 4, 5, 6, 7].map(i => {
        const phase = planCountQuestionPhase(fingerprint(i), started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
        started = phase.reviewStarted;
        return phase;
      });
      expect(phases.slice(0, 3).map(p => p.preReview)).toEqual([true, true, true]);
      expect(phases.slice(3).map(p => p.preReview)).toEqual([false, false, false, false, false]);
      const call = structuredClone(fingerprint(1).nativeCall!);
      call.questions[0].header = 'Scope complexity';
      call.questions[0].options.reverse();
      call.answers = { [call.questions[0].question]: call.questions[0].options[0].label };
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(true);
      // Even with opposed scope labels, an ordinary per-issue finding lacks
      // the captured whole-plan classes/files identity.
      call.questions[0].question = 'How should we reduce shared mutable cache complexity?';
      call.answers = { [call.questions[0].question]: call.questions[0].options[0].label };
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
    });

    test('uses the native opposed scope choices without depending on a prompt suffix', () => {
      const fp = fingerprint(2);
      expect(engStep0Boundary(fp)).toBe(true);
      const q = fp.nativeCall!.questions[0];
      q.question = 'Should local lessons from other repositories be included during reviews?';
      q.options.reverse();
      fp.nativeCall!.answers = { [q.question]: q.options[0].label };
      expect(engStep0Boundary(nativePlanCallFingerprint(fp.nativeCall!, 0, true))).toBe(true);
    });

    test("an unanswered Cross-project tab cannot borrow another tab's answer", () => {
      const call = structuredClone(fingerprint(2).nativeCall!);
      const other = { header: 'Routing rules', question: 'Add routing rules?', options: [{ label: 'Add rules' }, { label: 'Skip' }] };
      call.questions.push(other);
      call.answers = { [other.question]: 'Add rules' };
      expect(engStep0Boundary(nativePlanCallFingerprint(call, 0, true))).toBe(false);
      call.answers = { [call.questions[0].question]: call.questions[0].options[1].label };
      expect(engStep0Boundary(nativePlanCallFingerprint(call, 0, true))).toBe(true);
    });

    test('pending, failed, missing native metadata and ordinary review questions are not this gate', () => {
      const fp = fingerprint(2);
      expect(engStep0Boundary({ ...fp, nativeCall: undefined })).toBe(false);
      for (const alter of [
        (call: any) => { call.answered = false; },
        (call: any) => { call.failed = true; },
        (call: any) => { call.questions[0].header = 'Architecture issue'; call.questions[0].question = 'D1 — Architecture issue: should the cross-project feature use shared storage?'; },
        (call: any) => { call.questions[0].options = [{ label: 'Enable cross-project search' }, { label: 'Disable all search' }]; },
        (call: any) => { call.questions[0].options = [{ label: 'Enable cross-project search with project-scoped storage' }, { label: 'Discuss later' }]; },
        (call: any) => { call.questions[0].question = 'How should concurrent AuthCache writes across projects be serialized?';
          call.questions[0].options = [{ label: 'Serialize mutations' }, { label: 'Use project-scoped locks' }]; },
      ]) {
        const call = structuredClone(fp.nativeCall!);
        alter(call);
        call.answers = { [call.questions[0].question]: call.questions[0].options[0].label };
        expect(engStep0Boundary(nativePlanCallFingerprint(call, 0, true))).toBe(false);
      }
    });
  });

  describe('ceoStep0Boundary', () => {
    test('FIRES on retained letter-prefixed mode labels, not letter-prefixed architecture', () => {
      expect(ceoStep0Boundary(fp('D3 — Which review mode should this CEO review run in?', [
        'C — HOLD SCOPE (Recommended)', 'B — SELECTIVE EXPANSION', 'A — SCOPE EXPANSION', 'D — SCOPE REDUCTION',
      ]))).toBe(true);
      expect(ceoStep0Boundary(fp('D2 — Which implementation approach should this plan follow?', [
        'B — Ideal Architecture (Recommended)', 'A — Fix-Only (Minimal Viable)',
      ]))).toBe(false);
      expect(ceoStep0Boundary(fp('Prefer HOLD SCOPE for this decision?', ['C — Keep the dispatcher', 'A — Replace it']))).toBe(false);
    });
    test('parenthesized mode labels end setup, while approach labels and mode mentions do not', () => {
      expect(ceoStep0Boundary(fp('D1 — Which CEO review mode should I run?', [
        'A) SCOPE EXPANSION', 'B) SELECTIVE EXPANSION (recommended)', 'C) HOLD SCOPE', 'D) SCOPE REDUCTION',
      ]))).toBe(true);
      expect(ceoStep0Boundary(fp('D2 — Which implementation approach?', ['B) Ideal Architecture', 'A) Fix-Only']))).toBe(false);
      expect(ceoStep0Boundary(fp('Prefer HOLD SCOPE?', ['Discuss C) HOLD SCOPE', 'A) Replace it']))).toBe(false);
    });
    test('FIRES on Step 0F mode-pick AUQ (HOLD SCOPE in options)', () => {
      const f = fp('Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION']);
      expect(ceoStep0Boundary(f)).toBe(true);
    });

    test('FIRES on collapsed mode labels captured from the 2026-09-08 paid controls', () => {
      // Test each captured label independently: a spaced sibling option can
      // otherwise conceal the mismatch and leave every review AUQ in Step 0.
      const labels = [
        'HOLDSCOPE—makeitbulletproof(Recommended)',
        'SELECTIVEEXPANSION┌────────────────────────────────────────────────────────────────────────────────────┐\r    (ecommnded)                │SELECTIVEEXPANSION│',
        'SCOPEEXPANSION│Neutralposture:presentopportunities,stateeffort,youdecide.│\r                           │  Good for: substantialfeaturewithsolidfoundation,shippedbeforescopelock.│\r└────────────────────────────────────────────────────────────────────┘',
        'SCOPEREDUCTION—findtheminimalversion',
      ];
      for (const label of labels) {
        expect(ceoStep0Boundary(fp('Pick a mode', [label, 'Type something.']))).toBe(true);
      }
    });

    test('FIRES on scope-selection AUQ with "Skip interview" option (skip-interview path)', () => {
      // After calibration run 1: plan-ceo's first AUQ is scope-selection,
      // and we route via "Skip interview and plan immediately" to bypass
      // Step 0 entirely. Boundary must fire on this AUQ so subsequent
      // AUQs go to reviewCount.
      const f = fp(
        'What scope do you want me to CEO-review?',
        [
          "The branch's diff vs main",
          'A specific plan file',
          "An idea you'll describe inline",
          'Cancel — wrong skill',
          'Type something.',
          'Chat about this',
          'Skip interview and plan immediately',
        ],
      );
      expect(ceoStep0Boundary(f)).toBe(true);
    });

    test('does NOT fire on premise challenge AUQs', () => {
      const f = fp('D1 — Premise check: is this the right problem?', ['Yes', 'No', 'Other']);
      expect(ceoStep0Boundary(f)).toBe(false);
    });

    test('does NOT fire on review-section AUQs', () => {
      const f = fp('Architecture: bypass helper?', ['Reuse existing', 'Roll new', 'Defer']);
      expect(ceoStep0Boundary(f)).toBe(false);
    });
  });

  describe('engStep0Boundary', () => {
    // Captured native question text, labels and answers from targeted-b's
    // engineering retry. Descriptions are immaterial to the phase boundary.
    const captured = [
      {
        "header": "Scope",
        "question": "D1 — Multi-tenant Auth Refactor complexity check: 12 files + 4 new classes. Reduce scope or proceed as-is? <gstack-qid:plan-eng-scope-complexity>",
        "options": [
          "Proceed as-is",
          "Reduce: cut TokenStore + RequestPolicy",
          "Reduce: single-pass strangler"
        ],
        "answer": "Proceed as-is"
      },
      {
        "header": "Shared Cache",
        "question": "D2 — Arch issue 1: AuthBroker and SessionMint both mutate a global shared AuthCache via module-level export. How should this be fixed? <gstack-qid:plan-eng-shared-mutable-cache>",
        "options": [
          "Inject AuthCache as a dependency (recommended)",
          "Make mutations go through a single owner",
          "Accept the risk for now, document it"
        ],
        "answer": "Inject AuthCache as a dependency (recommended)"
      },
      {
        "header": "TOCTOU",
        "question": "D3 — Arch issue 2: TOCTOU window during tenant suspension. The plan says AuthCache invalidates entries on tenant suspension, but with two services mutating the cache, a token validation begun before suspension completes may still succeed after the tenant is suspended. How should this be addressed? <gstack-qid:plan-eng-toctou-suspension>",
        "options": [
          "Add suspension check at session issuance boundary (recommended)",
          "Add invalidation ordering guarantee to the plan",
          "Accept the window, note it as an edge case"
        ],
        "answer": "Add suspension check at session issuance boundary (recommended)"
      },
      {
        "header": "Error handling",
        "question": "D4 — Code quality issue 1: validateAndDispatch() swallows three distinct error classes in nested catch blocks with no re-throw, logging, or metrics. Errors disappear silently. How should this be handled? <gstack-qid:plan-eng-error-swallowing>",
        "options": [
          "Refactor to flat error handling with explicit re-throw or typed result (recommended)",
          "Add logging inside each catch, keep structure",
          "Leave it, add a lint rule to catch new instances"
        ],
        "answer": "Refactor to flat error handling with explicit re-throw or typed result (recommended)"
      },
      {
        "header": "Test coverage",
        "question": "D5 — Test issue 1: 0/18 code paths covered in the plan. The plan scopes tests to 'new components and their success/error paths' but omits: cache invalidation edge cases, all three catch blocks in validateAndDispatch(), and the 5 IDP call failure modes. Should the test scope be expanded? <gstack-qid:plan-eng-test-coverage>",
        "options": [
          "Expand test scope to cover all 18 paths (recommended)",
          "Cover new paths only, defer legacy and edge cases",
          "Accept current test scope as stated in the plan"
        ],
        "answer": "Expand test scope to cover all 18 paths (recommended)"
      },
      {
        "header": "IDP calls",
        "question": "D6 — Performance issue 1: token validation makes 5 sequential IDP API calls. The plan acknowledges they are independent and could be parallelized via Promise.all. Should this be fixed in this PR or deferred? <gstack-qid:plan-eng-idp-sequential-calls>",
        "options": [
          "Parallelize now with Promise.all (recommended)",
          "Defer to a follow-up PR, add a TODO",
          "Add a concurrency cap via Promise.all with limit"
        ],
        "answer": "Parallelize now with Promise.all (recommended)"
      },
      {
        "header": "Cache bounds",
        "question": "D7 — Performance issue 2 (medium confidence): AuthCache evicts on token expiry but the plan doesn't mention a max-size bound. In a high-tenant deployment, long-lived non-expiring tokens could grow the cache without bound. Is there already a size cap, or should one be added? <gstack-qid:plan-eng-cache-unbounded>",
        "options": [
          "Verify existing cap exists and document it in the plan",
          "Add explicit max-size eviction policy to AuthCache (recommended)",
          "Defer, this is a scaling concern not a correctness one"
        ],
        "answer": "Verify existing cap exists and document it in the plan"
      },
      {
        "header": "TODO",
        "question": "D8 — TODO candidate: Auth failure observability. The plan replaces silently-swallowed errors with typed errors, but adds no metrics, logs, or alerts for auth failure patterns. This gap won't surface until production incidents occur. Add a TODO? <gstack-qid:plan-eng-todo-observability>",
        "options": [
          "Add to TODOS.md (recommended)",
          "Build it now in this PR instead of deferring",
          "Skip — not valuable enough"
        ],
        "answer": "Add to TODOS.md (recommended)"
      }
    ];
    function nativeScopeFingerprint(index = 0): AskUserQuestionFingerprint {
      const row = captured[index];
      return nativePlanCallFingerprint({
        sessionId: 'captured-eng-retry', toolUseId: `call-${index}`, answered: true,
        questions: [{ header: row.header, question: row.question, options: row.options.map(label => ({ label })) }],
        answers: { [row.question]: row.answer },
      }, index, true);
    }

    test('keeps captured scope-complexity setup and counts the six following findings', () => {
      let started = false;
      const phases = captured.map((_, index) => {
        const question = nativeScopeFingerprint(index);
        const phase = planCountQuestionPhase(question, started, engStep0Boundary);
        started = phase.reviewStarted;
        return phase;
      });
      expect(phases[0]).toEqual({ preReview: true, reviewStarted: true });
      expect(phases.slice(1, 7).filter(phase => !phase.preReview)).toHaveLength(6);
      // The later answered observability TODO retains the existing phase policy.
      expect(phases.filter(phase => !phase.preReview)).toHaveLength(7);
    });

    test('requires an answered native scope decision with its opposed scope choices', () => {
      const original = nativeScopeFingerprint();
      expect(engStep0Boundary(original)).toBe(true);
      expect(engStep0Boundary({ ...original, nativeCall: undefined })).toBe(false);
      const pending = structuredClone(original);
      pending.nativeCall!.answered = false;
      delete pending.nativeCall!.answers;
      expect(engStep0Boundary(pending)).toBe(false);
      const unansweredScope = structuredClone(original);
      unansweredScope.nativeCall!.answers = { 'Separate answered setup question': 'Continue' };
      expect(engStep0Boundary(unansweredScope)).toBe(false);
      for (const alter of [
        (q: any) => { q.question = 'D1 — Architecture issue: the plan touches 12 files and introduces 4 classes, but AuthCache has a race. Reduce cache scope? <gstack-qid:plan-eng-cache-complexity>'; },
        (q: any) => { q.options = [{ label: 'Change cache size' }, { label: 'Keep cache size' }]; },
      ]) {
        const unrelated = structuredClone(original);
        alter(unrelated.nativeCall!.questions[0]);
        unrelated.nativeCall!.answers = { [unrelated.nativeCall!.questions[0].question]: captured[0].answer };
        expect(engStep0Boundary(unrelated)).toBe(false);
      }
    });

    test('FIRES on cross-project learnings prompt', () => {
      const f = fp('Enable cross-project learnings on this machine?', ['Yes', 'No']);
      expect(engStep0Boundary(f)).toBe(true);
    });

    test('recognizes the captured cross-project gate after cursor spacing collapses', () => {
      const frame = [
        '☐Cross-project gstackcansearchlearningsfromyourotherprojectsonthismachinetofindpatternsthatmightapplytothisreview.Enablecross-projectlearnings?',
        '❯1.Enablecross-projectlearnings(Recommended)',
        '2.Keeplearningsproject-scopedonly',
      ].join('\r\r');
      const question = capturePlanCountQuestion(frame, new Set(), 0, true)!;
      expect(question).not.toBeNull();
      expect(engStep0Boundary(question)).toBe(true);
      expect(engStep0Boundary(fp('Scopereductionrecommendation:cuttoMVP?', ['Reduce', 'Proceed']))).toBe(true);
    });

    test('FIRES on scope reduction recommendation', () => {
      const f = fp('Scope reduction recommendation: cut to MVP?', ['Reduce', 'Proceed', 'Modify']);
      expect(engStep0Boundary(f)).toBe(true);
    });

    test('does NOT fire on review-section AUQs', () => {
      const f = fp('Architecture: shared mutable state?', ['Refactor', 'Defer', 'Skip']);
      expect(engStep0Boundary(f)).toBe(false);
    });
  });

  describe('designStep0Boundary', () => {
    const focusTemplate = readFileSync(new URL('../../plan-design-review/SKILL.md.tmpl', import.meta.url), 'utf8')
      .match(/### 0D\. Focus Areas\nAskUserQuestion: "([^\n]+)"/)?.[1] ?? '';
    const focusQuestion = (gaps: string) => focusTemplate.replace('{N}', '4').replace('{X, Y, Z}', gaps);
    const focusOptions = ['Review all 7 dimensions', 'Focus on specific areas'];
    const nativeFocus = (question: string): AskUserQuestionFingerprint => {
      const fingerprint = nativePlanCallFingerprint({
        sessionId: 'design-focus-session', toolUseId: 'toolu-design-focus',
        answered: true, failed: false, answers: { [question]: focusOptions[0]! },
        unansweredQuestionIndices: [],
        questions: [{ question, header: 'Focus areas', multiSelect: false,
          options: focusOptions.map(label => ({ label, description: label })) }],
      }, 0, true);
      fingerprint.promptSnippet = question.slice(0, 240);
      return fingerprint;
    };
  });

  describe('design review begins without an optional focus question', () => {
    // Captured in the second07:53 paid attempt: real D1-D7 questions were
    // all incorrectly marked preReview, producing reviewCount=0 at completion.
    const questions = [
      '☐Buttonstyle │D1—Howshouldthe4headerbuttons(Save,Reset,Cancel,Export)bevisuallydifferentiated? │<gstack-qid:plan-design-review-butn-hierarchy>',
      '☐ Loading UX │D2—Whatloadingindicatorshouldappearduringthe2-5secondSaveoperation? │<gtack-qid:plan-esign-review-loadig-indicator>',
      '☐ Spacing │D3—Whichspacingscaleshouldthesettingspagestandardizeon?<gstack-qid:plan-design-review-spacing-scale>',
      '☐Typography │D4—Which2-sizetypographysystemshouldthesettingspageuse?<gstack-qid:plan-design-review-type-system>',
      '☐Mobile layout │D5 — On obile (<768px), how should the4-buton header behave?<gstack-qid:plan-design-review-mobile-header>',
      '☐DEIGN.md TODO │D6 — TODO: Create a DESIGN.md file codifying the5 decisions mdein this revew <gstack-qid:plan-design-review-todo-designmd>',
      '☐PartialfailTODO │D7—TODO:Specifythepartial-failurestate—whatdoestheuserseeifSavesucceedsforsomefieldsbutfailsfor others? <gstack-qid:plan-design-review-todo-partialfail>',
    ];
  });

  describe('devexStep0Boundary', () => {
  });
});

describe('native Eng setup ordering (captured F)', () => {
  // Exact native question stems and choice labels: two setup calls followed
  // by five real findings. Descriptions do not establish phase identity.
  const rows = [
  {
    "header": "Learnings scope",
    "question": "D1 \u2014 Should gstack search learnings from your other projects on this machine? <gstack-qid:cross-project-learnings>",
    "options": [
      "Enable cross-project (Recommended)",
      "Project-scoped only"
    ],
    "answer": "Enable cross-project (Recommended)"
  },
  {
    "header": "Scope complexity",
    "question": "D2 \u2014 The plan introduces 4 new classes across 12 files. That's above the complexity threshold (>2 classes / >8 files). Should we reduce scope or proceed as-is? <gstack-qid:plan-eng-scope-complexity>",
    "options": [
      "Reduce: merge to 2 classes (Recommended)",
      "Proceed as-is \u2014 4 classes, 12 files",
      "Reduce further: 1 new class only"
    ],
    "answer": "Reduce: merge to 2 classes (Recommended)"
  },
  {
    "header": "Arch: shared state",
    "question": "D3 \u2014 Architecture Issue 1: AuthCache is a global mutable singleton exported at module level; both AuthBroker and (previously) SessionMint mutate it. This creates concurrent-mutation risk across tenant requests and makes the services untestable in isolation. <gstack-qid:plan-eng-arch-global-cache>",
    "options": [
      "Inject AuthCache via constructor (Recommended)",
      "Keep global, add locking",
      "Proceed as-is"
    ],
    "answer": "Inject AuthCache via constructor (Recommended)"
  },
  {
    "header": "Code quality",
    "question": "D4 \u2014 Code Quality Issue 1: validateAndDispatch() is 60 lines with three nested try/catch blocks, each swallowing a different error class. Swallowed errors mean callers can't distinguish an IDP timeout from a policy rejection from a token parse failure \u2014 all three silently return the same result. <gstack-qid:plan-eng-quality-error-handling>",
    "options": [
      "Extract + typed error union (Recommended)",
      "Add logging to each catch, keep structure",
      "Proceed as-is"
    ],
    "answer": "Extract + typed error union (Recommended)"
  },
  {
    "header": "Test: regression",
    "question": "D5 \u2014 Test Issue 1 (IRON RULE): legacyAuthFlow() is being rewritten with no regression test for its prior behavior. The plan explicitly says coverage 'does not exercise legacyAuthFlow() or assert compatibility with its prior behavior.' A rewrite without a behavioral snapshot means any regression is invisible until production. <gstack-qid:plan-eng-test-legacy-regression>",
    "options": [
      "Add characterization tests before rewrite (Recommended)",
      "Document expected behavior, manual verify",
      "Skip regression coverage"
    ],
    "answer": "Add characterization tests before rewrite (Recommended)"
  },
  {
    "header": "Test: isolation",
    "question": "D6 \u2014 Test Issue 2: The plan says 'unit and integration coverage is planned for success/error paths' but makes no mention of cross-tenant isolation tests. The AuthCache key includes tenant ID, issuer, audience, and policy version \u2014 a key-construction bug would let Tenant A read Tenant B's cached tokens. This is the highest-severity failure mode in a multi-tenant auth system. <gstack-qid:plan-eng-test-tenant-isolation>",
    "options": [
      "Add explicit cross-tenant isolation tests (Recommended)",
      "Cover via integration tests only",
      "Proceed with existing test plan"
    ],
    "answer": "Add explicit cross-tenant isolation tests (Recommended)"
  },
  {
    "header": "Perf: IDP calls",
    "question": "D7 \u2014 Performance Issue 1: Token validation makes 5 sequential API calls to the IDP. The plan itself notes they are independent and could be parallelized via Promise.all 'trivially.' Sequential calls add latency proportional to IDP round-trip time x5 on every auth request. At p99 IDP latency of 100ms, that's 500ms of unnecessary serialization per login. <gstack-qid:plan-eng-perf-parallel-idp>",
    "options": [
      "Parallelize with Promise.all in this PR (Recommended)",
      "Defer to follow-up ticket",
      "Defer with in-code TODO comment"
    ],
    "answer": "Parallelize with Promise.all in this PR (Recommended)"
  }
];
  const fingerprint = (index: number): AskUserQuestionFingerprint => {
    const row = rows[index]!;
    return nativePlanCallFingerprint({
      sessionId: 'captured-f-eng', toolUseId: `f-${index}`, answered: true, failed: false,
      questions: [{ header: row.header, question: row.question, options: row.options.map(label => ({ label })) }],
      answers: { [row.question]: row.answer },
    }, index, true);
  };
  const phasesFor = (indices: number[]) => {
    let started = false;
    return indices.map(index => {
      const phase = planCountQuestionPhase(fingerprint(index), started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = phase.reviewStarted;
      return phase;
    });
  };

  test('both setup orders exclude setup and include the first of five actual findings', () => {
    for (const order of [[0, 1], [1, 0]]) {
      const phases = phasesFor([...order, 2, 3, 4, 5, 6]);
      expect(phases.slice(0, 2).map(p => p.preReview)).toEqual([true, true]);
      expect(phases[1]!.reviewStarted).toBe(true);
      expect(phases[2]!.preReview).toBe(false);
      expect(phases.filter(p => !p.preReview)).toHaveLength(5);
    }
  });

  test('setup IDs plus opposed answered choices survive header and question-body variants', () => {
    for (const index of [0, 1]) {
      const original = fingerprint(index).nativeCall!;
      const id = index === 0 ? 'cross-project-learnings' : 'plan-eng-scope-complexity';
      for (const header of ['Learnings scope', 'Scope complexity', 'Architecture', '']) {
        const call = structuredClone(original);
        const q = call.questions[0]!;
        q.header = header;
        q.question = `Choose the setup scope. <gstack-qid:${id}>`;
        q.options.reverse();
        call.answers = { [q.question]: q.options[0]!.label };
        const fp = nativePlanCallFingerprint(call, 0, true);
        expect(engSetupAUQ(fp)).toBe(true);
        expect(engStep0Boundary(fp)).toBe(true);
      }
    }
  });

  test('repeated setup does not become a finding after the boundary opens', () => {
    const phases = phasesFor([0, 0, 1, 1, 2, 3, 4, 5, 6]);
    expect(phases.slice(0, 4).every(p => p.preReview)).toBe(true);
    expect(phases.filter(p => !p.preReview)).toHaveLength(5);
  });

  test('only successful answered setup metadata can exclude a call', () => {
    for (const index of [0, 1]) {
      const fp = fingerprint(index);
      expect(engSetupAUQ({ ...fp, nativeCall: undefined })).toBe(false);
      for (const alter of [
        (call: any) => { call.answered = false; },
        (call: any) => { call.failed = true; },
        (call: any) => { call.answers = {}; },
        (call: any) => { call.questions[0].question = 'Review cache isolation. <gstack-qid:plan-eng-cache-complexity>'; },
        (call: any) => { call.questions[0].options = [{ label: 'Apply fix' }, { label: 'Defer finding' }]; },
        (call: any) => { call.questions[0].options = [{ label: 'Enable cross-project with project-scoped storage; proceed as-is or reduce' }, { label: 'Discuss' }]; },
      ]) {
        const call = structuredClone(fp.nativeCall!);
        alter(call);
        // Keep a successful answer after question/option mutations, so those
        // controls exercise identity/actions rather than an absent answer key.
        if (Object.keys(call.answers ?? {}).length) {
          call.answers = { [call.questions[0].question]: call.questions[0].options[0].label };
        }
        expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
      }
    }
  });

  test('an answered sibling cannot turn an unanswered setup tab or mixed finding packet into setup', () => {
    const call = structuredClone(fingerprint(0).nativeCall!);
    const issue = fingerprint(2).nativeCall!.questions[0]!;
    call.questions.push(issue);
    call.answers = { [issue.question]: issue.options[0]!.label };
    expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
    call.answers[call.questions[0]!.question] = call.questions[0]!.options[0]!.label;
    const fp = nativePlanCallFingerprint(call, 0, false);
    expect(engSetupAUQ(fp)).toBe(false);
    expect(planCountQuestionPhase(fp, true, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ).preReview).toBe(false);
  });

  test('the optional predicate leaves other callers and substantive Eng qids unchanged', () => {
    const fp = fingerprint(2);
    expect(engSetupAUQ(fp)).toBe(false);
    expect(planCountQuestionPhase(fp, true, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ).preReview).toBe(false);
    // Historical boundary detection can also fire on actual review qids;
    // those must never be reused as the late-setup exclusion predicate.
    fp.promptSnippet += ' <gstack-qid:plan-eng-review-global-cache>';
    expect(engStep0Boundary(fp)).toBe(true);
    expect(planCountQuestionPhase(fp, true, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ).preReview).toBe(false);
    const setup = fingerprint(0);
    expect(planCountQuestionPhase(setup, true, engStep0Boundary).preReview).toBe(false);
  });
});

describe('native Eng first packet and registry identities', () => {
  const scope = {
    header: 'Scope complexity',
    question: 'D1 — Choose the whole-plan scope. <gstack-qid:plan-eng-review-scope-reduce>',
    options: [{ label: 'Reduce: merge two classes (Recommended)' }, { label: 'Proceed as-is: four classes' }],
  };
  const finding = {
    header: 'Arch: shared state',
    question: 'D3 — Architecture Issue 1: AuthCache is a global mutable singleton exported at module level. <gstack-qid:plan-eng-arch-global-cache>',
    options: [{ label: 'Inject an owned cache' }, { label: 'Keep the global cache' }],
  };
  const callWith = (questions: typeof scope[], answers: Record<string, string>) => ({
    sessionId: 'eng-first-packet', toolUseId: 'mixed-call', answered: true, failed: false,
    questions, answers,
  });
  const phase = (call: ReturnType<typeof callWith>) => planCountQuestionPhase(
    nativePlanCallFingerprint(call, 0, true), false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ,
  );

  test('registry setup qids stay setup and require opposed scope actions', () => {
    const call = callWith([scope], { [scope.question]: scope.options[0]!.label });
    const fp = nativePlanCallFingerprint(call, 0, true);
    expect(engSetupAUQ(fp)).toBe(true);
    expect(engFirstReviewAUQ(fp)).toBe(false);
    expect(phase(call)).toEqual({ preReview: true, reviewStarted: true });
    call.questions = [{ ...scope, options: [{ label: 'Change cache size' }, { label: 'Keep cache size' }] }];
    call.answers = { [scope.question]: 'Change cache size' };
    expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, true))).toBe(false);
    const learnings = {
      header: 'Learnings scope', question: 'Choose local learning scope. <gstack-qid:preamble-cross-project-learnings>',
      options: [{ label: 'Enable cross-project learnings' }, { label: 'Keep project-scoped only' }],
    };
    expect(engSetupAUQ(nativePlanCallFingerprint(callWith([learnings], {
      [learnings.question]: learnings.options[0]!.label,
    }), 0, true))).toBe(true);
  });

  test('a first packet with answered setup and a real finding counts as one review call', () => {
    const call = callWith([scope, finding], {
      [scope.question]: scope.options[0]!.label,
      [finding.question]: finding.options[0]!.label,
    });
    expect(phase(call)).toEqual({ preReview: false, reviewStarted: true });
    // The packet is one call even with two answered tabs; the reader/counter
    // dedups the unchanged session/tool-use ID rather than counting each tab.
    expect(nativePlanCallFingerprint(call, 0, true).signature).toBe('eng-first-packet:mixed-call');
    for (const questions of [[scope, finding], [finding, scope]]) {
      expect(phase({ ...call, questions }).preReview).toBe(false);
    }
  });

  test('an unanswered or failed finding cannot start review from a setup packet', () => {
    const call = callWith([scope, finding], { [scope.question]: scope.options[0]!.label });
    expect(phase(call)).toEqual({ preReview: true, reviewStarted: true });
    call.answers = { [finding.question]: finding.options[0]!.label };
    expect(phase(call).preReview).toBe(false);
    for (const invalid of [{ ...call, answered: false }, { ...call, failed: true }, { ...call, answers: {} }]) {
      expect(engFirstReviewAUQ(nativePlanCallFingerprint(invalid, 0, true))).toBe(false);
    }
  });

  test('only positive substantive native question identity starts review', () => {
    for (const qid of ['plan-eng-review-scope-reduce', 'plan-eng-scope-complexity', 'cross-project-learnings', 'plan-eng-review-next-steps']) {
      const q = { ...finding, question: finding.question.replace('plan-eng-arch-global-cache', qid) };
      expect(engFirstReviewAUQ(nativePlanCallFingerprint(callWith([q], { [q.question]: q.options[0]!.label }), 0, true))).toBe(false);
    }
    for (const qid of ['plan-eng-review-arch-finding', 'plan-eng-review-test-gap']) {
      const q = { ...finding, question: finding.question.replace('plan-eng-arch-global-cache', qid) };
      expect(engFirstReviewAUQ(nativePlanCallFingerprint(callWith([q], { [q.question]: q.options[0]!.label }), 0, true))).toBe(true);
    }
    for (const qid of ['plan-eng-arch-focus', 'plan-eng-test-focus', 'plan-eng-quality-mode', 'plan-eng-perf-next-steps']) {
      const q = { ...finding, header: 'Review setup', question: `Choose which issue to review first. <gstack-qid:${qid}>` };
      expect(engFirstReviewAUQ(nativePlanCallFingerprint(callWith([q], { [q.question]: q.options[0]!.label }), 0, true))).toBe(false);
    }
    const testScope = { ...finding, header: 'Test scope', question: 'D3 — Test Issue: no coverage of the rewritten legacy flow is specified. <gstack-qid:plan-eng-test-scope>' };
    expect(engFirstReviewAUQ(nativePlanCallFingerprint(callWith([testScope], { [testScope.question]: testScope.options[0]!.label }), 0, true))).toBe(true);
    const q = { ...finding, header: 'Architecture', question: 'Choose a review focus. <gstack-qid:plan-eng-review-arch-finding>' };
    expect(engFirstReviewAUQ(nativePlanCallFingerprint(callWith([q], { [q.question]: q.options[0]!.label }), 0, true))).toBe(false);
  });
});

describe('native Eng setup semantics (captured G)', () => {
  // Exact native question stems, offered actions and answers. Five findings
  // and both substantive TODO decisions must remain in review coverage.
  const rows = [
  {
    "header": "Cross-project",
    "question": "gstack can search learnings from your other projects on this machine to find patterns that might apply to this auth refactor review. This stays local \u2014 no data leaves your machine. Enable cross-project learnings? <gstack-qid:cross-project-learnings>",
    "options": [
      "Enable (recommended)",
      "Project-scoped only"
    ],
    "answer": "Enable (recommended)"
  },
  {
    "header": "Scope",
    "question": "D1 \u2014 Scope challenge: this plan touches 12 files and introduces 4 new classes. Reduce scope or proceed as-is? <gstack-qid:plan-eng-scope-challenge>",
    "options": [
      "Reduce: phase it (recommended)",
      "Proceed as-is",
      "Investigate first"
    ],
    "answer": "Reduce: phase it (recommended)"
  },
  {
    "header": "Arch: cache wiring",
    "question": "D2 \u2014 Architecture issue 1: AuthBroker and SessionMint share a global mutable AuthCache via module-level export. Module-level singletons prevent test isolation and break in multi-process deployments (cluster, serverless, worker threads). How should AuthCache be wired? <gstack-qid:plan-eng-arch-cache-wiring>",
    "options": [
      "Dependency injection (recommended)",
      "Keep module-level export"
    ],
    "answer": "Dependency injection (recommended)"
  },
  {
    "header": "Arch: concurrency",
    "question": "D3 \u2014 Architecture issue 2: the plan explicitly states mutations to AuthCache are not serialized. With two services writing concurrently (e.g., AuthBroker evicting a token while SessionMint reads-then-writes it), you get classic check-then-act races. How should this be handled? <gstack-qid:plan-eng-arch-mutation-serialization>",
    "options": [
      "Make mutations idempotent + last-write-wins (recommended)",
      "Add an async mutex per cache key",
      "Document and defer"
    ],
    "answer": "Make mutations idempotent + last-write-wins (recommended)"
  },
  {
    "header": "Code quality",
    "question": "D4 \u2014 Code quality issue 1: validateAndDispatch() is 60 lines with three nested try/catch blocks, each silently swallowing a different error class. Swallowed errors mean silent failures in production \u2014 a token validation error looks identical to a dispatch error from the outside. Fix approach? <gstack-qid:plan-eng-cq-error-swallowing>",
    "options": [
      "Extract + typed errors (recommended)",
      "Add structured logging before swallowing",
      "Proceed as-is"
    ],
    "answer": "Extract + typed errors (recommended)"
  },
  {
    "header": "Tests",
    "question": "D5 \u2014 Test issue: all 13 new code paths in AuthCache and AuthBroker are untested (0% coverage planned). The plan mentions unit and integration coverage for success/error paths, but specifics are absent. Add explicit test requirements to the plan now? <gstack-qid:plan-eng-test-coverage>",
    "options": [
      "Add explicit test plan (recommended)",
      "Keep plan vague, trust implementation"
    ],
    "answer": "Add explicit test plan (recommended)"
  },
  {
    "header": "Performance",
    "question": "D6 \u2014 Performance issue: token validation makes 5 sequential IDP API calls. The plan notes they are independent and could be parallelized via Promise.all trivially. Fix in this PR or defer? <gstack-qid:plan-eng-perf-idp-parallelization>",
    "options": [
      "Fix in this PR with Promise.all (recommended)",
      "Defer to follow-up TODO"
    ],
    "answer": "Fix in this PR with Promise.all (recommended)"
  },
  {
    "header": "TODO: PR 2",
    "question": "D7 \u2014 TODO: capture PR 2 scope (SessionMint, TokenStore, RequestPolicy) in TODOS.md so it doesn\u2019t get lost after PR 1 ships. Add it? <gstack-qid:plan-eng-todo-pr2-scope>",
    "options": [
      "Add to TODOS.md (recommended)",
      "Skip \u2014 not valuable enough"
    ],
    "answer": "Add to TODOS.md (recommended)"
  },
  {
    "header": "TODO: IDP retry",
    "question": "D8 \u2014 TODO: IDP circuit breaker. Token validation makes 5 IDP calls (now parallelized). If the IDP is degraded, all 5 fail together \u2014 no retry, no fallback, no circuit breaker in the plan. Add a TODO to add circuit breaker / exponential retry logic around IDP calls? <gstack-qid:plan-eng-todo-idp-circuit-breaker>",
    "options": [
      "Add to TODOS.md (recommended)",
      "Build it now in this PR",
      "Skip \u2014 not valuable enough"
    ],
    "answer": "Add to TODOS.md (recommended)"
  }
];
  const callAt = (index: number) => {
    const row = rows[index]!;
    return { sessionId: 'captured-g-eng', toolUseId: `g-${index}`, answered: true, failed: false,
      questions: [{ header: row.header, question: row.question, options: row.options.map(label => ({ label })) }],
      answers: { [row.question]: row.answer } };
  };
  const setup = (call: ReturnType<typeof callAt>) => engSetupAUQ(nativePlanCallFingerprint(call, 0, false));
  const change = (index: number, question: string, labels?: string[]) => {
    const call = callAt(index); const q = call.questions[0]!;
    q.question = question;
    if (labels) q.options = labels.map(label => ({ label }));
    call.answers = { [question]: q.options[0]!.label };
    return call;
  };
  test('two setup calls precede five findings and two substantive TODO calls', () => {
    for (const order of [[0, 1], [1, 0]]) {
      let started = false;
      const phases = [...order, 2, 3, 4, 5, 6, 7, 8].map(index => {
        const phase = planCountQuestionPhase(nativePlanCallFingerprint(callAt(index), 0, !started),
          started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
        started = phase.reviewStarted; return phase;
      });
      expect(phases.map(p => p.preReview)).toEqual([true, true, false, false, false, false, false, false, false]);
      expect(phases.filter(p => !p.preReview)).toHaveLength(7);
    }
    expect(setup(callAt(0))).toBe(true);
    expect(setup(callAt(1))).toBe(true);
    for (const index of [2, 3, 4, 5, 6, 7, 8]) expect(setup(callAt(index))).toBe(false);
  });
  test('whole-plan scope uses its premise and opposed actions, not a model-chosen qid or header', () => {
    for (const question of [
      'D1 — Scope challenge: this plan touches 12 files and introduces 4 new classes. Reduce scope or proceed as-is?',
      'The plan introduces 4 new services. Reduce the scope or proceed as-is? <gstack-qid:plan-eng-unfamiliar-size-check>',
      'Complexity check: the plan spans 12 files. Reduce scope or proceed as-is? <gstack-qid:another-scope-name>',
    ]) {
      const call = change(1, question); call.questions[0]!.header = 'Review setup';
      expect(setup(call)).toBe(true);
      call.questions[0]!.options.reverse();
      call.answers = { [question]: call.questions[0]!.options[0]!.label };
      expect(setup(call)).toBe(true);
    }
  });
  test('abbreviated enable requires explicit cross-project learnings and an opposed project-scoped action', () => {
    for (const question of [
      'Should gstack search learnings from your other projects on this machine?',
      'Enable cross-project learnings for this review? <gstack-qid:model-selected-learning-scope>',
    ]) {
      const call = change(0, question); call.questions[0]!.header = 'Review setup';
      expect(setup(call)).toBe(true);
      call.questions[0]!.options.reverse();
      call.answers = { [question]: call.questions[0]!.options[0]!.label };
      expect(setup(call)).toBe(true);
    }
    for (const question of ['Enable the new feature?', 'Choose setup. <gstack-qid:cross-project-learnings>']) {
      expect(setup(change(0, question))).toBe(false);
    }
    expect(setup(change(0, rows[0]!.question, ['Enable (recommended)', 'Discuss later']))).toBe(false);
  });
  test('individual issues and TODOs cannot borrow whole-plan scope or cross-project words', () => {
    for (const [index, question, header] of [
      [1, 'D1 — Architecture issue: this plan touches 12 files and adds 4 classes, but the AuthCache has a race. Reduce scope or proceed as-is?', 'Architecture issue'],
      [1, 'D1 — Scope challenge: this cache spans 12 files and introduces 4 classes. Reduce scope or proceed as-is?', 'Scope'],
      [1, 'D1 — Test gap: the plan spans 12 files. Reduce test scope or proceed as-is?', 'Tests'],
      [1, 'The plan spans 12 files. Reduce scope or proceed as-is?', 'TODO: deferred implementation'],
      [0, 'D1 — Security issue: cross-project learnings leak client data. Enable the feature or use project-scoped storage?', 'Security issue'],
    ] as const) {
      const call = change(index, question); call.questions[0]!.header = header;
      expect(setup(call)).toBe(false);
    }
    expect(setup(change(1, rows[1]!.question, ['Reduce token scope', 'Investigate']))).toBe(false);
  });
  test('the captured retry scope heading and letter-prefixed native actions remain setup', () => {
    const retry = {
  "header": "Scope",
  "question": "D2 \u2014 Scope reduction: 12 files + 4 new classes exceeds the complexity threshold\nProject/branch/task: Multi-tenant Auth Refactor on main\nELI10: The plan introduces 4 new classes (TokenStore, SessionMint, AuthCache, RequestPolicy) across 12 files. That\u2019s a lot of new surface area at once. Auth refactors are already high-risk (broken auth = all users locked out). Adding 4 new abstractions simultaneously makes the blast radius of a mistake much larger. A simpler split \u2014 just AuthBroker + SessionMint, collapsing TokenStore into AuthCache and inlining RequestPolicy \u2014 would achieve the same goal with 2 new classes and fewer files touched.\nStakes if we pick wrong: With 4 new classes landing together, a single bug in any one of them could take down auth for all tenants simultaneously. Fewer classes = smaller blast radius, easier rollback, faster onboarding for the next engineer.\nRecommendation: B (proceed as-is) \u2014 the plan already has the existing cache adapter retained, and the 4-class split may reflect genuine domain separations the plan description doesn\u2019t fully explain. Review the design at full scope, flag individual issues per section.\nCompleteness: Note: options differ in kind, not coverage \u2014 no completeness score.\nPros / cons:\nA) Reduce scope \u2014 collapse TokenStore into AuthCache, inline RequestPolicy\n  \u2705 Fewer moving parts: 2 new classes instead of 4, smaller blast radius if auth fails\n  \u2705 Easier to review, test, and roll back each piece independently\n  \u274c May discard intentional domain separation the plan author had in mind\n  \u274c Requires re-planning before implementation can start\nB) Proceed as-is with full review (recommended)\n  \u2705 Respects the planned architecture and lets the full review surface real issues per section\n  \u2705 Faster path to implementation if the 4-class split turns out to be justified\n  \u274c Higher blast radius: 4 simultaneous new classes touching 12 files is more fragile to ship\n  \u274c The legacyAuthFlow rewrite without a regression test is a landmine that needs explicit attention\nNet: You\u2019re trading blast-radius safety (fewer classes) against re-planning delay. Recommend B \u2014 proceed at full scope, but treat each class boundary and the missing regression test as explicit issues in the review. <gstack-qid:plan-eng-review-scope-challenge>",
  "options": [
    "A) Reduce scope",
    "B) Proceed as-is (Recommended)"
  ],
  "answer": "A) Reduce scope"
};
    const call = change(1, retry.question, retry.options);
    call.questions[0]!.header = retry.header;
    call.answers = { [retry.question]: retry.answer };
    expect(setup(call)).toBe(true);
    // A numerical component issue cannot borrow the whole-plan sentence in
    // the explanatory body and the same Reduce/Proceed choices.
    const issue = change(1, retry.question.replace('Scope reduction:', 'AuthCache issue:'), retry.options);
    expect(setup(issue)).toBe(false);
    const partial = change(1, retry.question.replace('ELI10: The plan introduces', 'ELI10: AuthCache introduces'), retry.options);
    expect(setup(partial)).toBe(false);
    const missingOpposition = change(1, retry.question, ['A) Reduce scope', 'B) Investigate']);
    expect(setup(missingOpposition)).toBe(false);
  });
  test('late setup cannot hide earlier or later substantive findings', () => {
    const order = [2, 1, 3, 0, 4, 5, 6, 7, 8];
    let started = false;
    const phases = order.map(index => {
      const phase = planCountQuestionPhase(nativePlanCallFingerprint(callAt(index), 0, !started),
        started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = phase.reviewStarted; return phase;
    });
    expect(phases.map(p => p.preReview)).toEqual([false, true, false, true, false, false, false, false, false]);
    expect(phases.filter(p => !p.preReview)).toHaveLength(7);
  });
  test('pending, failed, uncertain and mixed answered calls never become wholly setup', () => {
    for (const index of [0, 1]) {
      const original = callAt(index);
      expect(engSetupAUQ({ ...nativePlanCallFingerprint(original, 0, false), nativeCall: undefined })).toBe(false);
      for (const mutate of [
        (c: ReturnType<typeof callAt>) => { c.answered = false; },
        (c: ReturnType<typeof callAt>) => { c.failed = true; },
        (c: ReturnType<typeof callAt>) => { c.answers = {}; },
        (c: ReturnType<typeof callAt>) => { c.answers = { [c.questions[0]!.question]: 'Uncertain; I have not selected a choice' }; },
      ]) { const c = structuredClone(original); mutate(c); expect(setup(c)).toBe(false); }
      const mixed = structuredClone(original); const finding = callAt(2).questions[0]!;
      mixed.questions.push(finding);
      mixed.answers[finding.question] = finding.options[0]!.label;
      expect(setup(mixed)).toBe(false);
      expect(planCountQuestionPhase(nativePlanCallFingerprint(mixed, 0, true), false,
        engStep0Boundary, engFirstReviewAUQ, engSetupAUQ).preReview).toBe(false);
      mixed.answers = { [finding.question]: finding.options[0]!.label };
      expect(setup(mixed)).toBe(false);
    }
  });
});

describe('native file/class complexity gate classification', () => {
  const rows = [
  {
    "id": "toolu_01HJHA5nCKyCAEPRVnm84udk",
    "header": "Prerequisite",
    "question": "D1 — No design doc found for this branch. Run /office-hours first? <gstack-qid:plan-eng-review-office-hours-prereq>",
    "labels": [
      "Skip — proceed with review (Recommended)",
      "Run /office-hours first"
    ],
    "answer": "Skip — proceed with review (Recommended)"
  },
  {
    "id": "toolu_01BF2LE9pqkt3Cs8PxC1uPaA",
    "header": "Scope",
    "question": "D2 — Complexity check triggered: 12 files, 4+ new classes. Reduce scope or proceed as-is? <gstack-qid:plan-eng-review-complexity-check>",
    "labels": [
      "Proceed as-is",
      "Reduce scope (Recommended)"
    ],
    "answer": "Proceed as-is"
  },
  {
    "id": "toolu_01J9SZHLFAuHjn19o9XFJvHo",
    "header": "Learnings",
    "question": "D3 — Cross-project learnings: search past sessions from other projects on this machine? <gstack-qid:plan-eng-review-cross-project-learnings>",
    "labels": [
      "Enable cross-project (Recommended)",
      "Project-scoped only"
    ],
    "answer": "Enable cross-project (Recommended)"
  },
  {
    "id": "toolu_01CRbNCM44doMT1ubMAtcuBp",
    "header": "Architecture",
    "question": "D4 — Architecture A1: Two services mutate a shared AuthCache with no mutation serialization. How should this be resolved? <gstack-qid:plan-eng-review-arch-shared-mutable-cache>",
    "labels": [
      "Single write-coordinator (Recommended)",
      "Serialize via mutex/queue",
      "Accept the risk, add monitoring"
    ],
    "answer": "Single write-coordinator (Recommended)"
  },
  {
    "id": "toolu_01UwpB3rC52W99ZB6g6FMV6K",
    "header": "Architecture",
    "question": "D5 — Architecture A2: legacyAuthFlow() gets rewritten with no regression tests capturing prior behavior. Approach? <gstack-qid:plan-eng-review-arch-legacy-rewrite>",
    "labels": [
      "Regression tests first (Recommended)",
      "Strangler fig",
      "Big-bang rewrite as planned"
    ],
    "answer": "Regression tests first (Recommended)"
  },
  {
    "id": "toolu_011biwzYyT1qCzVL8rn8gmTe",
    "header": "Code Quality",
    "question": "D6 — Code Quality CQ1: validateAndDispatch() has 3 nested try/catch blocks that each swallow a different error class. Fix? <gstack-qid:plan-eng-review-cq-validate-dispatch>",
    "labels": [
      "Decompose + surface errors (Recommended)",
      "Flatten catch hierarchy only",
      "Leave as-is"
    ],
    "answer": "Decompose + surface errors (Recommended)"
  },
  {
    "id": "toolu_01HbUJX6fD6CN3obeoyh8S5Z",
    "header": "Code Quality",
    "question": "D7 — Code Quality CQ2: AuthCache shared via module-level export (implicit global). Switch to dependency injection? <gstack-qid:plan-eng-review-cq-module-export>",
    "labels": [
      "Dependency injection (Recommended)",
      "Keep module export"
    ],
    "answer": "Dependency injection (Recommended)"
  },
  {
    "id": "toolu_019jNc2fhvrJhHkNZKTdztUm",
    "header": "Tests",
    "question": "D8 — Tests T1: No described test for coordinator ordering under concurrent mutations. Add concurrency tests to the plan? <gstack-qid:plan-eng-review-test-concurrency>",
    "labels": [
      "Add concurrency tests (Recommended)",
      "Defer to code review"
    ],
    "answer": "Add concurrency tests (Recommended)"
  },
  {
    "id": "toolu_0132EDXRcCffruHaV1E4kKRH",
    "header": "Tests",
    "question": "D9 — Tests T2: No E2E tests planned for core auth flows (cross-tenant validation, suspension, logout, revocation). Add them? <gstack-qid:plan-eng-review-test-e2e-auth>",
    "labels": [
      "Add E2E tests for auth flows (Recommended)",
      "Unit/integration only as planned"
    ],
    "answer": "Add E2E tests for auth flows (Recommended)"
  },
  {
    "id": "toolu_01C2sC9k9YbvAvgyWHGZUTyb",
    "header": "Performance",
    "question": "D10 — Performance P1: 5 sequential IDP calls per token validation. Parallelize or eliminate? <gstack-qid:plan-eng-review-perf-idp-calls>",
    "labels": [
      "Local JWT validation (Recommended)",
      "Promise.all parallelization",
      "Leave sequential as-is"
    ],
    "answer": "Local JWT validation (Recommended)"
  }
];

  function callAt(index: number) {
    const row = rows[index]!;
    return {
      sessionId: '122ddb02-2346-4a38-9824-f04f9d5d8cae',
      toolUseId: row.id,
      answered: true,
      failed: false,
      questions: [{
        header: row.header,
        question: row.question,
        options: row.labels.map(label => ({ label })),
        multiSelect: false,
      }],
      answers: { [row.question]: row.answer },
      unansweredQuestionIndices: [],
    };
  }

  test('actual ten calls remain three setup and seven independent review decisions in either setup order', () => {
    for (const order of [[0, 1, 2], [0, 2, 1]]) {
      let started = false;
      const phases = [...order, 3, 4, 5, 6, 7, 8, 9].map(index => {
        const phase = planCountQuestionPhase(nativePlanCallFingerprint(callAt(index), 0, !started),
          started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
        started = phase.reviewStarted;
        return phase;
      });
      expect(phases.map(p => p.preReview)).toEqual([true, true, true, false, false, false, false, false, false, false]);
      expect(phases.filter(p => !p.preReview)).toHaveLength(7);
    }
  });

  test('the answered numeric complexity gate does not depend on qid or action order', () => {
    for (const qid of ['plan-eng-review-complexity-check', 'model-chosen-size-gate']) {
      const call = callAt(1);
      const q = call.questions[0]!;
      q.question = q.question.replace('plan-eng-review-complexity-check', qid);
      for (const reverse of [false, true]) {
        if (reverse) q.options.reverse();
        call.answers = { [q.question]: q.options[0]!.label };
        expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(true);
      }
    }
  });

  test('a component finding, TODO, missing count, or missing whole-scope opposition stays substantive', () => {
    for (const mutate of [
      (call: ReturnType<typeof callAt>) => { call.questions[0]!.header = 'Architecture issue'; },
      (call: ReturnType<typeof callAt>) => { call.questions[0]!.header = 'TODO: scope'; },
      (call: ReturnType<typeof callAt>) => { call.questions[0]!.question = call.questions[0]!.question.replace('Complexity check triggered:', 'AuthCache complexity issue:'); },
      (call: ReturnType<typeof callAt>) => { call.questions[0]!.question = call.questions[0]!.question.replace('12 files, 4+ new classes', '12 cache entries'); },
      (call: ReturnType<typeof callAt>) => { call.questions[0]!.options[1]!.label = 'Reduce cache lock scope'; },
      (call: ReturnType<typeof callAt>) => { call.questions[0]!.options[0]!.label = 'Investigate the cache'; },
    ]) {
      const call = callAt(1);
      mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
    }
  });

  test('failed, pending, unoffered and mixed answered calls cannot be discarded as setup', () => {
    for (const mutate of [
      (call: ReturnType<typeof callAt>) => { call.answered = false; },
      (call: ReturnType<typeof callAt>) => { call.failed = true; },
      (call: ReturnType<typeof callAt>) => { call.answers = {}; },
      (call: ReturnType<typeof callAt>) => { call.answers = { [call.questions[0]!.question]: 'Add a new cache repair instead' }; },
      (call: ReturnType<typeof callAt>) => {
        const issue = callAt(3);
        call.questions.push(issue.questions[0]!);
        Object.assign(call.answers, issue.answers);
      },
    ]) {
      const call = callAt(1);
      mutate(call);
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
    }
  });
});

describe('explicit whole-plan scope complexity premise', () => {
 const calls = [
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_01RY4Ec4BVKuX7JRycy5Y7zB",
    "questions": [
      {
        "question": "D1 — The plan's scope (12 files, 4 new classes) triggers the complexity smell check. Proceed as-is or reduce scope first? <gstack-qid:plan-eng-complexity-check>",
        "header": "Scope",
        "multiSelect": false,
        "options": [
          {
            "label": "Proceed as-is (recommended)",
            "description": "Review all 4 planned classes (TokenStore, SessionMint, AuthCache, RequestPolicy) across 12 files. The plan already flags this as a smell worth investigating — we'll scrutinize every class boundary during the Architecture section and call out anything that should be merged or deferred. Completeness: 10/10"
          },
          {
            "label": "Reduce scope first",
            "description": "Propose a minimal-surface version before reviewing: collapse TokenStore into the existing cache adapter extension and defer RequestPolicy extraction (it's just a slice of validateAndDispatch()). This yields ~2 new classes and ~6-8 files. The Architecture section would then review the leaner design. Completeness: 7/10 — defers policy extraction"
          },
          {
            "label": "Skip complexity and go straight to issues",
            "description": "Treat scope as fixed, skip the scope challenge, and dive directly into the 4 review sections (Architecture, Code Quality, Tests, Performance). Fastest path but misses the structural smell the plan itself flagged. Completeness: 7/10"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D1 — The plan's scope (12 files, 4 new classes) triggers the complexity smell check. Proceed as-is or reduce scope first? <gstack-qid:plan-eng-complexity-check>": "Proceed as-is (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T20:58:36.032Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_01Vz57KiddxkZg3v4NiWKzsC",
    "questions": [
      {
        "question": "D2 — Architecture: shared global mutable AuthCache between AuthBroker and SessionMint, with no serialization, in a multi-tenant system. <gstack-qid:plan-eng-arch-shared-cache>",
        "header": "Architecture",
        "multiSelect": false,
        "options": [
          {
            "label": "Inject via constructor (recommended)",
            "description": "[P1] (confidence: 9/10) Plan says: 'Two new services share a global mutable AuthCache instance via module-level export. Both services mutate it' and 'they do not serialize mutations.' In a multi-tenant system, concurrent mutations from AuthBroker (e.g., evict-on-logout) and SessionMint (e.g., write-on-mint) to the same cache can corrupt tenant isolation boundaries without any test catching it. Fix: pass AuthCache as a constructor argument to both services. Each test provides a fresh instance; production wires it once at startup. Zero mutations to the existing adapter. Effort: human ~1h / CC ~5min. Completeness: 10/10"
          },
          {
            "label": "Add a mutation coordinator",
            "description": "Keep the module-level export but wrap all mutating calls in a queue or lock. Protects against races but does not fix the coupling (tests still share state, import side-effects are still global). Higher complexity than DI. Effort: human ~2h / CC ~10min. Completeness: 8/10 — misses the testability problem"
          },
          {
            "label": "Accept as-is",
            "description": "Trust the underlying adapter's existing invalidation hooks to prevent cross-tenant reads. This works only if the adapter already serializes all writes — the plan does not state this, and 'they do not serialize mutations' explicitly says it does not. Accepted risk of cross-tenant cache corruption on concurrent requests. Completeness: 5/10"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D2 — Architecture: shared global mutable AuthCache between AuthBroker and SessionMint, with no serialization, in a multi-tenant system. <gstack-qid:plan-eng-arch-shared-cache>": "Inject via constructor (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T20:59:24.191Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_01MpiyqoPfnhoFmN1hBtNHdu",
    "questions": [
      {
        "question": "D3 — Architecture: the plan describes 5 IDP API calls for token validation but says nothing about partial failure semantics. <gstack-qid:plan-eng-arch-idp-partial-failure>",
        "header": "Architecture",
        "multiSelect": false,
        "options": [
          {
            "label": "Add explicit failure semantics to the plan (recommended)",
            "description": "[P1] (confidence: 9/10) Plan: 'Token validation issues 5 sequential API calls to the IDP.' No text covers what happens when call 3 of 5 returns a 503. In an auth system, the fail-open vs fail-closed decision is load-bearing for security. Recommendation: add a plan section stating the rule explicitly — 'on any IDP call failure, token validation fails closed (reject the token, return 401, do not cache a partial result).' Effort: human ~30min / CC ~3min. Completeness: 10/10"
          },
          {
            "label": "Defer to implementation",
            "description": "Leave the failure semantics undecided in the plan; let implementers decide per-call. Risk: two developers make different assumptions and one path fails open (accepts a partially-validated token). In auth systems, a silent fail-open is a security hole, not just a bug. Completeness: 5/10"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D3 — Architecture: the plan describes 5 IDP API calls for token validation but says nothing about partial failure semantics. <gstack-qid:plan-eng-arch-idp-partial-failure>": "Add explicit failure semantics to the plan (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T20:59:52.277Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_019eGcLXXteu52dC67WNtJyL",
    "questions": [
      {
        "question": "D4 — Architecture: TokenStore is listed as one of 4 new classes but the plan never describes its responsibility. The existing cache adapter already stores tokens keyed by tenant/issuer/audience/policy. <gstack-qid:plan-eng-arch-tokenstore-purpose>",
        "header": "Architecture",
        "multiSelect": false,
        "options": [
          {
            "label": "Define TokenStore's boundary in the plan (recommended)",
            "description": "[P2] (confidence: 8/10) Without a description, implementers may duplicate the existing adapter's logic inside TokenStore, producing two storage layers for the same data. The plan should state: what TokenStore does that the existing adapter does not, whether it holds in-memory tokens separately from the cache adapter, and how AuthCache (the facade) relates to TokenStore vs the adapter. Effort: human ~20min / CC ~2min. Completeness: 10/10"
          },
          {
            "label": "Keep it implicit",
            "description": "Accept that TokenStore's boundary will be defined during implementation. Risk: two interpretations surface mid-sprint — one where TokenStore wraps the adapter (double indirection) and one where it holds state independently (split storage, double-write bugs). Completeness: 5/10"
          },
          {
            "label": "Merge TokenStore into AuthCache",
            "description": "If TokenStore is just a typed wrapper around what AuthCache already exposes, drop it and let AuthCache handle all token storage concerns. Reduces new-class count from 4 to 3 without losing capability. Completeness: 9/10 — assumes they genuinely overlap"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D4 — Architecture: TokenStore is listed as one of 4 new classes but the plan never describes its responsibility. The existing cache adapter already stores tokens keyed by tenant/issuer/audience/policy. <gstack-qid:plan-eng-arch-tokenstore-purpose>": "Define TokenStore's boundary in the plan (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:00:16.358Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_01WXRQF8z4JKkKvnwH7h6U6Z",
    "questions": [
      {
        "question": "D5 — Code Quality: validateAndDispatch() is 60 lines with 3 nested try/catch blocks, each swallowing a different error class. <gstack-qid:plan-eng-cq-validate-dispatch>",
        "header": "Code Quality",
        "multiSelect": false,
        "options": [
          {
            "label": "Refactor as part of this PR (recommended)",
            "description": "[P1] (confidence: 9/10) Plan: 'each catch swallows a different error class.' In auth code, a swallowed error is a silent failure — a rejection that should surface as a 401 becomes invisible, or a partial validation looks like success. Since this PR already touches the function (RequestPolicy extraction), refactoring it is a same-diff change. Fix: extract each catch branch into a named handler, propagate errors explicitly via throw or typed Result<T,E>; add one log line per catch so failures appear in traces. Effort: human ~2h / CC ~10min. Completeness: 10/10"
          },
          {
            "label": "Add logging, keep structure",
            "description": "Add a structured log at each catch site so failures are at least visible, but leave the nesting and swallowing in place. Reduces debuggability debt without restructuring. Still leaves the logical errors silently absorbed — a 401 that should have been thrown may still become a phantom pass. Effort: human ~30min / CC ~5min. Completeness: 7/10 — errors are visible but not propagated"
          },
          {
            "label": "Defer to follow-up",
            "description": "Capture as a TODO and address in a later PR. Risk: the refactor grows harder once 4 new classes depend on the current swallowing behavior. The 'right behavior' becomes ambiguous when callers have already been written against the current (broken) semantics. Completeness: 3/10"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D5 — Code Quality: validateAndDispatch() is 60 lines with 3 nested try/catch blocks, each swallowing a different error class. <gstack-qid:plan-eng-cq-validate-dispatch>": "Refactor as part of this PR (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:00:40.446Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_01UwMPiH1hZutbzPCGGQ3sUZ",
    "questions": [
      {
        "question": "D6 — Tests: IDP partial failure (calls 1-4 of 5 succeed, call 5 fails) has no test coverage in the plan. We just added the fail-closed semantic in D3. <gstack-qid:plan-eng-test-idp-partial>",
        "header": "Tests",
        "multiSelect": false,
        "options": [
          {
            "label": "Add to plan as required test (recommended)",
            "description": "[P1] (confidence: 9/10) We added 'fail closed on any IDP error' as explicit plan language in D3. That semantic needs a test that stubs each IDP call position as the one that fails (5 separate test cases, or one parametrized one) and asserts the validator returns 401 and writes nothing to cache. Without this, the fail-closed rule is a comment in a doc, not a contract in code. Effort: human ~1h / CC ~8min. Completeness: 10/10"
          },
          {
            "label": "Cover only all-pass and all-fail",
            "description": "Test the two extreme cases (all 5 calls succeed, all fail) and skip partial-failure positions. Simpler, but misses the case where calls 1-4 succeeded and call 5 fails — the most likely real-world scenario when an IDP endpoint degrades under load. Completeness: 6/10"
          },
          {
            "label": "Defer",
            "description": "Capture as TODO and address post-merge. Risk: the fail-closed rule we just added has no verification path; a future refactor could silently revert it and no test would catch it. Completeness: 3/10"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D6 — Tests: IDP partial failure (calls 1-4 of 5 succeed, call 5 fails) has no test coverage in the plan. We just added the fail-closed semantic in D3. <gstack-qid:plan-eng-test-idp-partial>": "Add to plan as required test (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:02:00.740Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_0152qGvSSuBnRkqTe8ix2WTj",
    "questions": [
      {
        "question": "D7 — Tests: the plan says coverage for 'new components and their success/error paths' is planned, but validateAndDispatch() is an existing function being refactored. Its 3 catch blocks that currently swallow errors need explicit tests for each error branch. <gstack-qid:plan-eng-test-validate-dispatch-errors>",
        "header": "Tests",
        "multiSelect": false,
        "options": [
          {
            "label": "Add 3 explicit error-path tests to the plan (recommended)",
            "description": "[P2] (confidence: 8/10) After the refactor from D5, each of the 3 catch blocks becomes a named handler. Each named handler needs a test: trigger error class A/B/C, assert the function returns the expected error response (not silently succeeds). Without these tests, the refactor from D5 has no verification that the new explicit error handling is correct. Effort: human ~1h / CC ~8min. Completeness: 10/10"
          },
          {
            "label": "Cover in integration tests only",
            "description": "Rely on integration tests that exercise validateAndDispatch() indirectly through AuthBroker. Lower signal — integration tests that cover error paths often don't isolate which branch triggered, making regressions hard to pinpoint. Completeness: 6/10"
          },
          {
            "label": "Defer",
            "description": "Leave error-path test coverage for a follow-up. Risk: the refactored function's error behavior is unverified until the next sprint. Completeness: 3/10"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D7 — Tests: the plan says coverage for 'new components and their success/error paths' is planned, but validateAndDispatch() is an existing function being refactored. Its 3 catch blocks that currently swallow errors need explicit tests for each error branch. <gstack-qid:plan-eng-test-validate-dispatch-errors>": "Add 3 explicit error-path tests to the plan (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:02:10.780Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_0194VcsnAMMDRFEafkx4dEsQ",
    "questions": [
      {
        "question": "D8 — Performance: token validation makes 5 sequential IDP API calls that the plan itself identifies as trivially parallelizable. <gstack-qid:plan-eng-perf-idp-parallel>",
        "header": "Performance",
        "multiSelect": false,
        "options": [
          {
            "label": "Parallelize as part of this PR (recommended)",
            "description": "[P2] (confidence: 9/10) Plan: 'Token validation issues 5 sequential API calls to the IDP; they could be parallelized via Promise.all trivially (calls are independent).' The plan identifies the fix itself. In a multi-tenant system, token validation is on the hot path for every authenticated request. Sequential IDP calls multiply latency by 5x unnecessarily. Fix: wrap the 5 calls in Promise.all(); the refactor from D5 (validateAndDispatch extraction) is the natural point to do this. Effort: human ~30min / CC ~5min. Completeness: 10/10"
          },
          {
            "label": "Defer to performance pass",
            "description": "Merge first, profile in production, then optimize. Risk: the plan already identifies this as trivial to fix. Deferring a known, safe, low-effort improvement costs real latency on every auth request from day 1 of deployment. Completeness: 6/10"
          },
          {
            "label": "Add to TODOS.md only",
            "description": "Capture in TODOS.md and address when performance metrics confirm it matters. Lowest risk of introducing a bug, but leaves 5x unnecessary serial latency in prod indefinitely. Completeness: 4/10"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D8 — Performance: token validation makes 5 sequential IDP API calls that the plan itself identifies as trivially parallelizable. <gstack-qid:plan-eng-perf-idp-parallel>": "Parallelize as part of this PR (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:02:26.856Z"
  },
  {
    "sessionId": "3326e31d-a9e2-41ea-9489-f99013a81de8",
    "toolUseId": "toolu_01AHbQGxj8dc6F4MPYhsPo2q",
    "questions": [
      {
        "question": "D9 — TODOS: the plan has no mention of IDP circuit breaker or timeout per call. With 5 calls now running in parallel (D8 decision), an IDP outage generates 5 concurrent timeouts per request. <gstack-qid:plan-eng-todo-idp-circuit-breaker>",
        "header": "TODO",
        "multiSelect": false,
        "options": [
          {
            "label": "Add to TODOS.md (recommended)",
            "description": "Capture as a deferred item: add per-call timeout + a circuit breaker so that IDP degradation fails fast instead of hanging. Not blocking this PR, but the parallelization we added in D8 increases the concurrent timeout surface. Concrete TODO: implement exponential backoff + circuit breaker with configurable open/half-open thresholds."
          },
          {
            "label": "Skip — not valuable enough",
            "description": "Accept that IDP timeout handling is the IDP library's responsibility, or that network timeouts are set at the HTTP client level. No additional app-level circuit breaker needed."
          },
          {
            "label": "Build it now in this PR",
            "description": "Add circuit breaker logic as part of the validateAndDispatch refactor (D5). The refactor is already touching that function; adding a circuit breaker is incremental. Effort: human ~4h / CC ~20min. Higher complexity, but IDP outages in auth systems have severe user impact."
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D9 — TODOS: the plan has no mention of IDP circuit breaker or timeout per call. With 5 calls now running in parallel (D8 decision), an IDP outage generates 5 concurrent timeouts per request. <gstack-qid:plan-eng-todo-idp-circuit-breaker>": "Add to TODOS.md (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:03:23.081Z"
  }
];

  test('captured retry counts its scope as setup but keeps all eight substantive decisions above the original ceiling', () => {
    let started = false;
    const phases = calls.map(call => {
      const phase = planCountQuestionPhase(nativePlanCallFingerprint(call, 0, !started),
        started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = phase.reviewStarted;
      return phase;
    });
    expect(phases.map(p => p.preReview)).toEqual([true, false, false, false, false, false, false, false, false]);
    expect(phases.filter(p => !p.preReview)).toHaveLength(8);
  });

  test('an individual component, missing numeric premise, or a finding cannot borrow a scope label', () => {
    for (const mutate of [
      (call: typeof calls[number]) => { call.questions[0]!.question = call.questions[0]!.question.replace("The plan's scope", "The cache's scope"); },
      (call: typeof calls[number]) => { call.questions[0]!.question = call.questions[0]!.question.replace('12 files, 4 new classes', '12 cached tokens'); },
      (call: typeof calls[number]) => { call.questions[0]!.question = call.questions[0]!.question.replace('triggers the complexity smell check', 'has a race in AuthCache'); },
      (call: typeof calls[number]) => { call.questions[0]!.header = 'Architecture finding'; },
    ]) {
      const call = structuredClone(calls[0]!);
      mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
    }
  });
});

describe('explicit Step 0 complexity gate with size in native choices', () => {
  const calls = [
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01UbyixE6kojrR1enUcpg1bT",
    "questions": [
      {
        "question": "D1 — Add gstack skill routing rules to CLAUDE.md? <gstack-qid:routing-injection>",
        "header": "Routing setup",
        "multiSelect": false,
        "options": [
          {
            "label": "Add routing rules (recommended)"
          },
          {
            "label": "Skip — invoke manually"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D1 — Add gstack skill routing rules to CLAUDE.md? <gstack-qid:routing-injection>": "Add routing rules (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:51:39.918Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01JswH5HdmeQvdAGx8P6tApN",
    "questions": [
      {
        "question": "D2 — Should gstack search learnings from your other projects on this machine? <gstack-qid:cross-project-learnings>",
        "header": "Learnings scope",
        "multiSelect": false,
        "options": [
          {
            "label": "Enable cross-project learnings (recommended)"
          },
          {
            "label": "Keep learnings project-scoped"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D2 — Should gstack search learnings from your other projects on this machine? <gstack-qid:cross-project-learnings>": "Enable cross-project learnings (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:51:59.954Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01Hqr5i8DN2iukjCGmj1DQro",
    "questions": [
      {
        "question": "D3 — Step 0 Scope Challenge: This plan triggers the complexity gate. Proceed at full scope or reduce? <gstack-qid:plan-eng-step0-complexity>",
        "header": "Step 0 scope",
        "multiSelect": false,
        "options": [
          {
            "label": "Proceed at full scope (recommended)",
            "description": "Review and implement as written: 4 new classes (TokenStore, SessionMint, AuthCache, RequestPolicy) across 12 files in one pass. The plan already self-flags this as a scope smell, and the reviewer will dig into the specific overbuilt pieces in the Architecture section.",
            "preview": "Scope: 4 classes, 12 files, 2 new services\nRisk: larger blast radius; harder to roll back\nENG REVIEW will call out any specific over-abstractions"
          },
          {
            "label": "Reduce to two phases",
            "description": "Split into Phase 1 (core auth services: AuthBroker + SessionMint with direct adapter calls) and Phase 2 (TokenStore + RequestPolicy as follow-up). AuthCache facade may be mergeable into the existing adapter. Smaller blast radius, easier review. (human: +1 day planning / CC: ~10 min)",
            "preview": "Phase 1: AuthBroker + SessionMint (core flow)\nPhase 2: TokenStore + RequestPolicy\nRisk: sequencing overhead; Phase 2 may stall"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D3 — Step 0 Scope Challenge: This plan triggers the complexity gate. Proceed at full scope or reduce? <gstack-qid:plan-eng-step0-complexity>": "Proceed at full scope (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:52:54.081Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01LT7ctyJNE1UqyTvLdQkULD",
    "questions": [
      {
        "question": "D4 — Architecture A1: Global mutable AuthCache shared via module-level export, no mutation serialization. How should this be fixed? <gstack-qid:plan-eng-arch-global-cache>",
        "header": "Arch: global cache",
        "multiSelect": false,
        "options": [
          {
            "label": "Inject AuthCache as constructor dependency (recommended)"
          },
          {
            "label": "Keep global export, add write serialization"
          },
          {
            "label": "Accept as-is — verify adapter serializes internally"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D4 — Architecture A1: Global mutable AuthCache shared via module-level export, no mutation serialization. How should this be fixed? <gstack-qid:plan-eng-arch-global-cache>": "Inject AuthCache as constructor dependency (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:53:50.210Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01LTXTWs6w4qhdo7FVRXFKdZ",
    "questions": [
      {
        "question": "D5 — Architecture A2: Cache adapter failure posture is unstated. What should happen when the cache adapter is unavailable? <gstack-qid:plan-eng-arch-cache-failure>",
        "header": "Arch: cache failmode",
        "multiSelect": false,
        "options": [
          {
            "label": "Fail closed (recommended) — state this explicitly in the plan"
          },
          {
            "label": "Fail open with logging — state this explicitly in the plan"
          },
          {
            "label": "Accept as-is — inherited from existing adapter"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D5 — Architecture A2: Cache adapter failure posture is unstated. What should happen when the cache adapter is unavailable? <gstack-qid:plan-eng-arch-cache-failure>": "Fail closed (recommended) — state this explicitly in the plan"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:54:24.301Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01MCM7KMWBJyKPBeD5D5xQXE",
    "questions": [
      {
        "question": "D6 — Code Quality Q1: validateAndDispatch() — 60 lines, 3 nested try/catch blocks each swallowing a different error class. How do you want to address this? <gstack-qid:plan-eng-cq-validate-dispatch>",
        "header": "CQ: swallowed errors",
        "multiSelect": false,
        "options": [
          {
            "label": "Refactor — split function + typed error returns (recommended)"
          },
          {
            "label": "Keep structure, convert to catch-and-log"
          },
          {
            "label": "Defer — leave for follow-up PR"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D6 — Code Quality Q1: validateAndDispatch() — 60 lines, 3 nested try/catch blocks each swallowing a different error class. How do you want to address this? <gstack-qid:plan-eng-cq-validate-dispatch>": "Refactor — split function + typed error returns (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:55:06.409Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01THi9A5uG6H6YGD4FQgL6vJ",
    "questions": [
      {
        "question": "D7 — Tests T1: The plan says success/error paths will be covered, but doesn't include a test for the fail-closed cache behavior (cache adapter unavailable → auth rejected). Add it? <gstack-qid:plan-eng-test-fail-closed>",
        "header": "Tests: fail-closed",
        "multiSelect": false,
        "options": [
          {
            "label": "Add explicit fail-closed test (recommended)"
          },
          {
            "label": "Note as TODO — rely on adapter's existing coverage"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D7 — Tests T1: The plan says success/error paths will be covered, but doesn't include a test for the fail-closed cache behavior (cache adapter unavailable → auth rejected). Add it? <gstack-qid:plan-eng-test-fail-closed>": "Add explicit fail-closed test (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:56:50.701Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01379PhfvZ4iX43gReT87gob",
    "questions": [
      {
        "question": "D8 — Tests T2: Concurrent mint + revoke for the same tenant has no planned test. AuthBroker and SessionMint both write to the shared AuthCache instance. Add a concurrency test? <gstack-qid:plan-eng-test-concurrent>",
        "header": "Tests: concurrency",
        "multiSelect": false,
        "options": [
          {
            "label": "Add concurrent access test (recommended)"
          },
          {
            "label": "Defer — note in TODOS.md"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D8 — Tests T2: Concurrent mint + revoke for the same tenant has no planned test. AuthBroker and SessionMint both write to the shared AuthCache instance. Add a concurrency test? <gstack-qid:plan-eng-test-concurrent>": "Add concurrent access test (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:57:14.766Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_0112YwENaKQsigFNvBDmZiUa",
    "questions": [
      {
        "question": "D9 — Performance P1: 5 sequential IDP calls during token validation — the plan identifies this as trivially parallelizable. Address it in this PR? <gstack-qid:plan-eng-perf-idp-calls>",
        "header": "Perf: IDP calls",
        "multiSelect": false,
        "options": [
          {
            "label": "Parallelize in this PR with Promise.all (recommended)"
          },
          {
            "label": "Defer to a follow-up PR"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D9 — Performance P1: 5 sequential IDP calls during token validation — the plan identifies this as trivially parallelizable. Address it in this PR? <gstack-qid:plan-eng-perf-idp-calls>": "Parallelize in this PR with Promise.all (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:57:34.827Z"
  },
  {
    "sessionId": "bb1c2502-5944-4872-aab4-0cc8a34296b2",
    "toolUseId": "toolu_01YFVEdfATVrYA8LbWUmzN72",
    "questions": [
      {
        "question": "D10 — TODO: Add p99 latency metric for IDP calls before/after Promise.all parallelization. Add to TODOS.md? <gstack-qid:plan-eng-todo-idp-metrics>",
        "header": "TODO: IDP metrics",
        "multiSelect": false,
        "options": [
          {
            "label": "Add to TODOS.md (recommended)"
          },
          {
            "label": "Skip — not valuable enough"
          }
        ]
      }
    ],
    "answered": true,
    "failed": false,
    "answers": {
      "D10 — TODO: Add p99 latency metric for IDP calls before/after Promise.all parallelization. Add to TODOS.md? <gstack-qid:plan-eng-todo-idp-metrics>": "Add to TODOS.md (recommended)"
    },
    "unansweredQuestionIndices": [],
    "answeredAt": "2026-09-08T21:58:35.032Z"
  }
];
  const scopeCall = () => structuredClone(calls[2]!);

  test('captured sequence keeps three setup calls and all seven substantive decisions', () => {
    let started = false;
    const phases = calls.map(call => {
      const phase = planCountQuestionPhase(nativePlanCallFingerprint(call, 0, !started),
        started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = phase.reviewStarted;
      return phase;
    });
    expect(phases.map(phase => phase.preReview)).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(phases.filter(phase => !phase.preReview)).toHaveLength(7);
    expect(calls.at(-1)!.questions[0]!.header).toBe('TODO: IDP metrics');
  });

  test('native offered-answer binding does not depend on model qid or option order', () => {
    for (const reverse of [false, true]) {
      const call = scopeCall();
      const question = call.questions[0]!;
      question.question = question.question.replace('plan-eng-step0-complexity', 'different-model-id');
      if (reverse) question.options.reverse();
      call.answers = { [question.question]: question.options[0]!.label };
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(true);
    }
  });

  test('component findings, TODOs and incomplete scope evidence remain review decisions', () => {
    for (const mutate of [
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.header = 'Architecture finding'; },
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.header = 'TODO: scope'; },
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.question = call.questions[0]!.question.replace('This plan triggers the complexity gate', 'This cache triggers the complexity gate'); },
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.question = call.questions[0]!.question.replace('Step 0 Scope Challenge:', 'Architecture issue:'); },
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.options[0]!.description = 'Inspect 12 files for a cache race.'; },
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.options[0]!.description = 'Implement as written: 4 new classes for token validation.'; },
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.options[0]!.label = 'Proceed with a cache lock'; },
      (call: ReturnType<typeof scopeCall>) => { call.questions[0]!.options[1]!.label = 'Investigate cache failures'; },
    ]) {
      const call = scopeCall();
      mutate(call);
      call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
    }
  });

  test('pending, failed, unoffered and mixed answered packets cannot be discarded as setup', () => {
    for (const mutate of [
      (call: ReturnType<typeof scopeCall>) => { call.answered = false; },
      (call: ReturnType<typeof scopeCall>) => { call.failed = true; },
      (call: ReturnType<typeof scopeCall>) => { call.answers = {}; },
      (call: ReturnType<typeof scopeCall>) => { call.answers = { [call.questions[0]!.question]: 'Add a new cache repair' }; },
      (call: ReturnType<typeof scopeCall>) => {
        const finding = structuredClone(calls[3]!);
        call.questions.push(finding.questions[0]!);
        Object.assign(call.answers, finding.answers);
      },
    ]) {
      const call = scopeCall();
      mutate(call);
      expect(engSetupAUQ(nativePlanCallFingerprint(call, 0, false))).toBe(false);
    }
  });
});

describe('pickDesignFocusAll: the seed-declared all-seven answer for the pending 0D focus menu', () => {
  const captured = require('../fixtures/design-floor-focus-36597762183.json');
  const q = () => structuredClone(captured.question);
  test('census 36597762183 pending menu selects the all-seven option', () => {
    expect(pickDesignFocusAll(q())).toBe(1);
  });
  test.each([
    ['a different title', (x: any) => { x.question = x.question.replace('Review all 7 design dimensions, or focus?', 'Which fixes should I apply?'); }],
    ['a non-narrowing alternative', (x: any) => { x.options[1].label = 'Approve every fix now'; }],
    ['two all-seven options', (x: any) => { x.options[1].label = 'All seven dimensions'; }],
    ['a bundled product approval', (x: any) => { x.question = x.question.replace('Net:', 'Also approve the CTA redesign.\nNet:'); }],
    ['a foreign plan context', (x: any) => { x.question = x.question.replace('plan-design-review of PLAN.md', 'plan-design-review of OTHER.md'); }],
    ['multi select', (x: any) => { x.multiSelect = true; }],
  ])('%s is not answered', (_name, mutate) => {
    const x = q(); mutate(x); expect(pickDesignFocusAll(x)).toBeNull();
  });
});
