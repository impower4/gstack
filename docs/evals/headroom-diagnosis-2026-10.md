# Headroom diagnosis, October 2026 (A1-A3)

Per-phase timings for the cases the reliability plan named as slow, measured from
stored CI artifacts of census 37198445662 (head `fd6854b`) and, for the one red,
37176837432. Native captures carry message timestamps; PTY cases carry the
assistant-message timestamps their observation files keep. Durations in the
trial history (`wave-trials`) for multi-test files are the JUnit **sum** of tests
that run concurrently, not wall time or session time, so they overstate headroom
for `plan-mode-no-op` and `plan-ceo-mode-routing`.

## A1. ship-docsync-completion and -store (session budget 585 s)

History: completion 349-517 s, store 377-466 s across the eight wave censuses.

| Phase (37198445662) | completion | store |
|---|---|---|
| Prepare: read phase, skills, Git state, fixture files; snapshot | 85 s (two thinking gaps of 9 s and 26 s) | 99 s (33 s thinking) |
| Compose child prompt (9.5 KB / 7.1 KB `Agent` input) | 43 s | 32 s |
| Child (`document-release`, foreground) | 122 s | 118 s |
| Validate (compare, Git reads, small file reads) | 3 s tool time, 38 s thinking | 3 s tool time, 13 s thinking |
| Write records after the child | 45 s (section copy, report, result JSON with typed hashes) | 78 s (child output copy, section, record, report) |
| Publish stand-in, verify, final message | 32 s | 25 s |

Tool time in the parent is about 1 s per session. Reading release-file contents
does not dominate (10 small files, ~1 s), so the parent keeps its reads and the
child result contract stays unchanged. The parent's own model time dominates
(~270 s of ~390 s). Two parts are cuttable without weakening the gate:

- **Records after the child** (product): the parent retyped hash maps and child
  output into several files. The gate now records post-child hashes by rerunning
  the `gstack-docs-candidate snapshot` command (`--out <audit-id>-post.json`),
  Step 16 runs `compare` on it, and each record is saved once and cited by path.
- **Child prompt copy** (fixture only): ~70% of the child prompt is the fixture's
  observation interface, which the fixture tells the parent to copy into child
  prompts (`docsNativeInterface`, "include this interface in child prompts").
  Writing that interface to a fixture file the child reads would save ~30-40 s per
  session; it touches the shared detector/actor module, so it is a lane D request.

## A2. plan-mode-no-op and plan-ceo-mode-routing

**plan-mode-no-op is not a headroom problem.** Its six PTY sessions start
concurrently; 37198445662's file wall is 263 s (slice entry 271.6 s) while the
JUnit sum is 518 s. The slowest session is 159 s of its 300 s observation budget
(53%). It runs in gate slice 4, not the 711 s critical-path slice 11.

**plan-ceo-mode-routing** runs two concurrent sessions (wall 378 s, sum 687 s).
The slowest session (HOLD SCOPE) is 378 s of 600 s (63%). The tight budget is the
test's 240 s post-selection window:

| HOLD SCOPE session (37198445662) | elapsed |
|---|---|
| Preamble | 17 s |
| Pre-review audit batch | 46 s |
| Setup questions and answers | 45 s |
| Learnings search, Step 0 analysis written to the plan | 50 s |
| Mode question rendered and answered | 20 s |
| Handoff helper, plan write, two section reads, Codex probe, then posture chat | 114 s |
| HOLD continuation question and posture assessment | 76 s |

In the red (37176837432) the session skipped the handoff helper and paraphrased
the mode ("holding scope"), then spent ~60 s per decision on the ledger
save/read-back/ask cycle until the 240 s window closed. The skill now sends the
handoff line before any other tool call, plan write or section load, and never
skips the helper. The remaining time is model latency of the decision procedure
(about 60 s per question: comparison grid, save, Read-back, ask); cutting that
would weaken the question-persistence gate, so it stays a named item.

## A3. Census critical path

Gate slice 11 (711 s, the census critical path) holds 17 short files. Their
recorded estimates (`scripts/paid-test-durations.json`, recorded 2026-09-29)
total 1078 s; they ran 1353 s. Four files ran about twice their estimate in
every wave census:

| File | estimate | wave census range |
|---|---|---|
| `skill-e2e-plan.test.ts#plan-review-report` | 76 s | 168-273 s |
| `skill-e2e-plan-ceo-plan-mode.test.ts` | 37 s | 85-120 s |
| `skill-e2e-deploy.test.ts#benchmark-workflow` | 62 s | 59-121 s |
| `skill-e2e-safety-codex-consult.test.ts` | 83 s | 111-212 s |

None is near its own budget (plan-review-report peaks at 46% of 600 s). The fix
is a refreshed duration seed so the planner packs slice 11 within the 540 s slice
budget (lane F / integrator). review-army-perf and plan-design-review-plan-mode
need no work.

## plan-eng-multi-finding-batching: 975 s in census 37228573062 (GSTA-23 branch)

The red trial ran 975 s of its 1,500 s armed session (65%), against 313-409 s
in the nine earlier censuses (37162480720 … 37198445662). The wall is a
consequence of the detector miss, not slower work: the runner stops
collecting once the counter credits FLOOR = 3 review questions (normally
by D3, about 5-7 minutes). The counter credited none, because the report
declared its target mid-line ("… by the user. Review target (fixed):
`PLAN.md` …"), so collection ran on through D10 and the completed report.
With the target-field fix the same capture is credited at D5 (521 s).
Replay: `bun test test/detector-corpus-plan-eng-multi-finding-batching.test.ts`.
No budget or kind change.

## review-army-simplification: 159 s of 180 s in the Oct 12 census (#3153)

The pass-rate gate pooled 159 s of the 180 s session budget (88.1%, over the
85% cap); census 38212265208's own panel ran 142, 91 and 146 s. Phases from the
three transcripts (paid slices 25-27):

| Phase (38212265208) | t1 | t2 | t3 |
|---|---|---|---|
| Read the extracted review-SKILL.md, checklist, specialist; search for a "## Step 4.5" heading the carved fixture no longer has | 17 s | 15 s | 36 s |
| Scope and stats commands, analysis, and reconciling the prompt's "over 100 lines" with the 68-line diff | 64 s | 29 s | 13 s, then a subagent (29 s) and re-verification (21 s) |
| Compose the unbounded report | 45 s | 33 s | 31 s |
| Final message (each restates the findings and the premise mismatch) | 11 s | 8 s | 11 s |

The fixture, not the skill, carried the extra work. The case now uses the
staging its siblings use (`stageReviewArmySession`: recorded scope, stats,
learnings and diff; only `review-army.md` and `simplification.md` staged),
selects the specialist with the real `/review --simplification` force flag,
applies the checklist in-session and bounds the report to 30 lines. Budget and
assertions are unchanged. Free check: the simplification scenarios in
`test/review-army-budget.test.ts`.

## ship-exploratory-late-input: a probe batched with its Reads (#3153)

Not a headroom case; recorded here because the cause is also fixture work.
Census 38212265208 failed it with "probe preceded resource read". Capture 001
went out in the same provider response as the Reads of the caller's Step 8 and
Step 9 sections, before any QA section was read (the Oct 7 capture `mtb1007a`
batched it with the exploratory Read). /ship's prose never names the QA capture
helper; the fixture prompt supplies it, and the fixture's scheduling contract
(added 2026-10-06) invited batching "Reads and read-only discovery" without
listing Read results among the dependencies a probe must wait for. The case
passed on Oct 3 and Oct 5, before that contract. The contract now classifies
captures, guard starts and runs as probes, never discovery; the ordering rule
itself stays in /ship's Step 9 STOP, which the case still has to follow unaided.
Free check: the census 38212265208 replay in `test/qa-exploratory-callers.test.ts`.
