<!-- gstack-autoplan-scope: --no-ui --developer-tool -->
# gstack field list 2 (October 16, 2026): what the gbrain crew needs from gstack

## Implementation plan

### Context

This is plan revision 2. Revision 1 was reviewed by six voices (CEO, DX, Eng; Claude Opus 5.5 native, GPT-6.1 Sol outside): 50 findings, 0 Critical, 23 High, one user challenge (defer W13's automatic scope). This revision folds every finding in; the Review record lists each phase and how it was handled. Run budget: at most 3 review rounds (this is round 2); a round-3 phase with open findings closes accepted-with-findings, deferred to the build.

Owner request (Garry, via GBRA-108, 2026-10-16): "go ahead and turn that into a new thread and get it on the merge queue". Inputs: GBRA-40's field list 2 (items 1-10 plus Step 0) and GBRA-108's addendum (items 11-14), collected from the gbrain threads' transcripts Oct 14-16. Coordinator: GStack Minder (GSTA-36) owns the merge queue and does every merge; this wave opens PRs and sends READY reports.

Base: origin/main `3e8b34d` (v1.91.106.0). **Every wave PR builds on top of #3190** (`capy/next-wave`, v1.91.107.0, GSTA-31, READY and merging next), because almost every item touches files #3190 rewrites (bin/gstack-capy-install, bin/gstack-capy-session, capy/skill/gstack/**, lib/autoplan-*.ts, lib/pregate/{index,config,context,runtime,supervise,types}.ts, lib/pregate/checks/{guards,lanes}.ts, lib/plan-reality.ts, lib/ship-receipt.ts, lib/result-codes.ts, ship/**, autoplan/DRIVER.md.tmpl, docs/{troubleshooting,pregate,unattended,capy-install}.md). Code citations below are against #3190's head `03968f0`. Other in-flight owners this wave must not collide with: #3200 (GSTA-32: review-army tests), #3225 (GSTA-37: bin/gstack-upgrade Windows path, lib/pregate/checks/secrets.ts, lib/redact-patterns.ts, browse rule 3, several review-section templates), #3226 (GSTA-35: autoplan/SKILL.md.tmpl, autoplan/sections/dx-phase.md.tmpl, plan-devex-review/**, devex-review/**, lib/dx-error-*.ts, scripts/resolvers/{dx,index}.ts), #3215 (community: lib/pregate/docs-lane.ts, lane-selection.ts). A lane that needs one of those files waits for that PR to merge and builds on its version; it never forks a competing edit.

**Already handled outside this plan.** Step 0 (#3190 merge, #3209 already merged as v1.91.106.0, fresh-machine acceptance on a gbrain lane) belongs to GSTA-31/GStack Minder. Two fast-track PRs ship without this gate because they fix wrong results: **F1** (item 13, install honesty) and **F2** (item 12 part 1, cso partial-input disclosure). They are described here so reviewers see the whole wave, but the gate does not decide them.

**Triage correction that shapes the wave.** Item 13's evidence ("most gbrain machines report `gstack: ok 1.91.101.0` while main is 1.91.106.0") is mostly a timing artifact: main was v1.91.101.0 from 2026-10-14 17:36Z until #3212 landed 2026-10-16 20:29Z; v1.91.102-104 were stamps on unmerged PRs. The lanes' trailers were current. The real defect is narrower: `--check` prints `gstack-capy-session: behind origin/<b>: <old> -> <new> (<n> commits); fix: …` on its own line (bin/gstack-capy-session), but lanes report only the `gstack:` trailer, so "behind" is lost in every handoff. Likewise item 1's core tools already exist: `gstack-restamp --after <pr>` (gate-ahead in a throwaway worktree, records .gstack/tmp/gate-ahead.json), `gstack-tree-receipt` (`TREE: same-modulo-stamps`, stamp_files from .gstack/ship-policy.json, `gate-reuse: eligible`) and `gstack-ship-receipt` (identifiers-first handoff block). gbrain already commits a ship policy (`.gstack/ship-policy.json`, gbrain 90feaab2, 2026-10-13: stamp-at-merge, 13 stamp_files, 5 stamp_patterns), so tree-receipt can prove its stamps today. The gbrain queue hand-proved stamp diffs because nothing in /ship strings these tools into the coordinator protocol and the coordinator has no command to re-verify a lane's claim.

Repo constraints: SKILL.md is generated from .tmpl (`bun run gen:skill-docs`, `--host codex`); logic in lib/*.ts behind thin bin/ entrypoints; module-size ratchet (800 lines/module, 150/function); result codes in lib/result-codes.ts with docs/troubleshooting.md anchors; every test subprocess has a timeout (spawnsync tripwire); parity-suite and context-budget ratchets for template edits; E2E Evals run on every PR push (paid gates pre-approved; batch pushes).

Thesis: **the gbrain crew's coordinator stops proving things by hand: stamps, approvals, flakes and stale installs become lines a tool prints, and no gstack report claims more coverage than it had.**

### Release promises

- **P1. A coordinator can run a shared merge queue from printed lines,** with no hand-built stamp diff: ready report, stamp with proof, gate-ahead, restamp on reorder.
- **P2. Nothing that needs the owner's approval ships without a cited approval,** and data repairs never run at upgrade.
- **P3. No report overstates what it checked:** cso lists what it skipped (F2), the install trailer says when it is behind (F1), exported artifacts carry no machine paths, lanes and reviewers always give a real `gstack:` trailer.
- **P4. Timing-dependent tests are caught before merge,** and /investigate has a flake playbook that never raises a bound.
- **P5. /autoplan honors a budget:** a round cap and spend cap the runner enforces, a phase can close accepted-with-findings deferred to build, and confirm rounds review only the delta.

### Premise table

| premise | claim | receipt | verdict |
|---|---|---|---|
| P-a | main was v1.91.101.0 from Oct 14 17:36Z to Oct 16 20:29Z | `git log --format='%h %cI' origin/main`: 47d639a 2026-10-14T17:36:39Z, a889ef9 2026-10-16T13:29:38-07:00 | true |
| P-b | --check prints "behind" only off the trailer | bin/gstack-capy-session (#3190 head) check branch, `echo "gstack-capy-session: behind origin/…"` | true |
| P-c | #3190's `latest:` note needs bootstrapper wrapper 2; the Drive copy is wrapper 1 | capy/skill/gstack/scripts/install.sh `GSTACK_CAPY_WRAPPER=2` on #3190; this machine printed `gstack-capy-skill: wrapper 1` | true |
| P-d | restamp --after, tree-receipt and ship-receipt exist | bin/gstack-restamp:5, bin/gstack-tree-receipt:5, bin/gstack-ship-receipt:5 | true |
| P-e | gbrain commits a ship policy with stamp_files | `gh api repos/garrytan/gbrain/contents/.gstack/ship-policy.json` (829 bytes, commit 90feaab2) | true (rev 1 said false) |
| P-f | autoplan has --spend-cap but host-subagent attempts reserve $0 | lib/autoplan-run.ts:212; this run's spend.json `estimate_usd: 0` | true |
| P-g | cso refuses over 64 MiB and advises "a smaller checkout" | lib/cso/snapshot.ts:54,66 | true |
| P-h | cso counts withheld >1 MiB files at full size toward the cap | lib/cso/snapshot.ts:683 (size added before read) | true |
| P-i | GBRA-102's restamp refusal ("another PR's entry above master") | field list only | unverified |
| P-j | #6792 shipped a take-deleting accept path | field list; gbrain #6807 hotfix | unverified (gbrain repo) |
| P-k | GBRA-117's runner forced Eng after a stop request | addendum only | unverified |

unverified=3

### Already done

`git log origin/main --since=2026-10-14` for the named files: #3209 (v1.91.106.0) and #3212 (v1.91.105.0) touch none of W1-W12's new surfaces. #3190 (open) already ships pregate's `requires-remote` path, the autoplan checkpoint dir, `rec` gate replies and the `latest:` trailer note; this plan builds on them and does not redo them.

### Surface check

Verified with `--help` or source on #3190's head: `gstack-restamp --after/--expect-base/--expect-order`, `gstack-tree-receipt --gated/--from`, `gstack-ship-receipt write/read/census`, `gstack-autoplan next --spend-cap/--estimate-usd`, `gstack-autoplan revise`, `gstack-lane-check --planned`, `gstack-cso start --diff/--base/--scope`. New surfaces are named as new.

### Binding decisions

- Every merge is GStack Minder's; lanes send READY and never stamp before a slot call (CREW.md 6).
- Files owned by #3190, #3200, #3225, #3226, #3215 are built on after they merge, never forked.
- Autoplan budget for this run: 3 rounds, then accepted-with-findings (GStack Minder, 2026-10-16).

### Numbers

- Rev-1 review: 50 findings, 23 High, 0 Critical [measured: run findings.jsonl]. Queue cost per extra PR: one slot, one stamp, one free suite on Ubicloud, one paid E2E run per push (~$93 [measured: GSTA-37 run 38969924945, $93.06]).
- gbrain source bytes admitted vs withheld under cso's counting [re-measure before build: W13 spike].

### Deferred asks

- Item 12 "cso never needs the whole repo / worst sibling": the automatic sibling expansion (W13) is deferred behind a measurement spike; F2 ships the explicit, disclosed scope now.
- Item 13 "session start upgrades automatically": already true in install mode on main (SELF_UPGRADE); F1 makes the remaining stale cases visible, it does not add upgrades to --check.
- Item 1 "gstack carries no gbrain specifics": kept; gbrain policy changes go to the gbrain crew through GStack Minder as a handoff, not a gstack PR.
- Item 5 root cause (machine replacement) is Capy's; reported, not worked around.

### PR count

gstack's ship policy defaults to one PR per wave. This wave asks for four: F1 and F2 are fast-track defect fixes outside the wave (S1 install honesty, wrong security result); the wave itself is two stacked PRs, A then B, because B's ship/review/pregate work and A's autoplan/install work are separate files but share result-codes.ts, troubleshooting.md and the ratchet fixtures, so stacking gives those files one linear owner. Each extra PR costs one queue slot and one paid E2E run per push [estimated: ~$93 each].

### Fast track (not gated here)

- **F1. Install trailer carries "behind" (item 13; #2378's Capy half). Built at b1f7119 on #3190's head.** bin/gstack-capy-session exports GSTACK_CAPY_BEHIND/_BEHIND_TO/_BEHIND_FIX whenever the session ends behind origin (FETCH_HEAD from this run's fetch; works with the wrapper-1 Drive copy); bin/gstack-capy-install puts `behind=<n> (latest: <v>); fix: <command>` on an ok trailer, replacing `latest:` (one staleness note, never both). The fix never contains the `; ` separator: `bash <wrapper> [--for <skill>]` when a rerun fast-forwards, `<root>/bin/gstack-upgrade` when the checkout is dirty, detached or diverged (it prints its own refusal), `unset <VAR>, then …` when disabled. Docs and the capy skill say "a trailer with behind= means run the fix". Floor: at stamp time GSTACK_MIN_REVISION rises to F1's own version.
- **F2. cso discloses partial input (item 12 part 1). Building.** `gstack-cso start --paths <prefixes>`: out-of-scope files are per-file manifest entries with `originalHash: not-read` and `withheld: outside the --paths audit scope` (gaps, never `excluded:`), so snapshot-inputs coverage is `partial` and the report lists what was skipped; out-of-scope bytes skip the 64 MiB accumulation; a `--diff` changed path outside `--paths` refuses; the diff detector never treats an unread entry as changed or unchanged by payload; recheck and replay carry `--paths` and refuse a finding in a withheld path. Only the payload-cap message points to `--paths`; the manifest (16 MiB) and entry-count limits keep their unsupported-capacity guidance, since per-file entries still count there (a gbrain-sized repo, ~7.5k files, needs ~2 MiB).

### Wave items

**PR A: autoplan, install, eval-plan (W5, W6, W7, W8, W9, W11).**

**W5. Autoplan budget (item 11, High).**
- `--max-rounds <n>` on the first `next` (default 3 unattended), stored in run.json; rounds counted from state.history reopen events per phase.
- At the cap: `closeDeferred(state, phase, reason, by)` in lib/autoplan-gate.ts beside closePhase, used by the cap and by a new `gstack-autoplan close --phase <p> --deferred "<reason>" --by <who>`: marks open voices skipped, releases their reservations, writes a deferred consensus file so export/validate/resume work, and copies open findings into tasks.jsonl and a gate section with counts by severity. It auto-closes only when no open Critical, urgent finding or pending user challenge remains; otherwise those become gate items for the owner.
- A `revise` after a capped phase does not reopen it; it adds a gate approval item "plan changed after <phase> cap: unreviewed delta" with the diff summary, so the cap can't be bypassed and the delta can't ship silently.
- Spend: unattended runs on Capy reserve a printed per-voice default (`--estimate-usd`, default stated in DRIVER) for unestimated host attempts, so `--spend-cap` binds; host spend is still reported `unknown` beside the round count; `budget_exhausted` is a resumable status with structured cap/rounds/spend fields and printed recovery commands (close-deferred, or an owner-authorized cap raise).
- Confirm rounds: prompts carry the plan diff since the last reviewed revision and the settled decisions; findings get revision-qualified ids with correlation to earlier occurrences; a finding on settled scope reopens only when it cites a plan-diff hunk or file:line absent from the settled decision's record, else it is recorded `settled`.
Tests: cap close with open Critical routes to gate; revise after cap; resume after budget_exhausted; export and validate after a deferred close.

**W6. Machine-path-free public export (item 6, Medium).** `gstack-autoplan export --public <dir>` writes a sanitized copy without mutating the private run (resume and bindings unchanged): only the run's recorded machine roots (out dir, home, plan_input dir, checkpoint dir, worktree root) are rewritten to repo-relative paths or `<local notes (not committed)>`; derived files get their own digests with provenance naming the private digests. `gstack-artifact validate --public` fails (`ARTIFACT_MACHINE_PATH`) on a recorded root and WARNs with file:line on generic home-path patterns; inline code and fences in plan.md are not rewritten. Regression: gbrain-evals #164's shape.

**W7. Lane durability (item 5, Medium).** DRIVER.md coordinator contract and /ship's multi-lane guide: push a WIP commit to the lane branch after each step; run gates from a pushed SHA. On Capy with GSTACK_AUTOPLAN_CHECKPOINT_DIR unset, the runner prints the detected private project-user Drive folder and the exact export line (`CHECKPOINT: unset; to survive machine replacement: export GSTACK_AUTOPLAN_CHECKPOINT_DIR=<dir>`); it defaults there only when `gstack-config set autoplan_checkpoint drive` opted in. Checkpoints are taken after each bound voice and phase transition, and resume does not redispatch a bound voice.

**W8. Preregistration dry run (item 7, Medium).** In lib/eval-plan.ts behind gstack-eval-plan (not plan-reality): a preregistration declares a synthetic fixture file and the expected count per diagnostic; `gstack-eval-plan check-prereg --allow-repo-commands` runs the declared summarizer on it and fails `PREREG_DIAGNOSTIC_UNTESTED` on a mismatch or an undeclared diagnostic, before the freeze commit.

**W9. Eval model-rule lint (item 10, Low).** Optional `.gstack/eval-models.json` holds allow/deny/tier constraints ("fable: smoke only", "deny gpt-5.4-mini", "newest generation per family") resolved through the existing MODEL_CATALOG; gstack-eval-plan lints every arm's model against it. No CLAUDE.md prose parsing.

**W11. Every machine gives a real trailer (items 9 and 14, Low).** `--for review-voice`: clone or fast-forward plus helper-runtime Bun (gstack's own minimum, not the target repo's test pins), no ./setup, no host profiles; certifies only gstack-pregate sealed, gstack-plan-reality, gstack-artifact and gstack-autoplan submit-side reads, with a SKILL_REQUIREMENTS row so admission refuses heavier workflows with a `--for <skill>` fix. The not-installed fix line and the reviewer/lane brief carry a fallback for machines without the Drive skill (`git clone --depth 1 … && bin/gstack-capy-install --for review-voice`). Budget: under 20 s warm, measured in a test.

**PR B (stacked on A): ship, review, pregate, update-check (W1, W2, W3, W4, W10, W12).**

**W1. /ship queue mode (item 1, High).** One entry, `bin/gstack-ship-queue` (lib/ship-queue.ts), subcommands per protocol step, each ending with `GSTACK_RESULT: skill=ship-queue …`; gstack-restamp stays the primitive.
- `ready`: one block in the coordinator contract's identifiers-first order plus head SHA, `version: unstamped`, CI state at that exact head and the pregate line; refuses when the tree differs from the pushed head.
- `stamp --version <X> --expect-gated <sha> --expect-base <sha> [--expect-order <prs>]`: preflights every proof input, journals stages, runs restamp (base movement → `QUEUE_STALE`), commits, runs tree-receipt, prints `QUEUE_STAMP: <pr> <version> head=<sha> gated=<sha> tree=same-modulo-stamps receipt=<sha256>`; an identical retry resumes or returns the existing outcome; on refusal it reports the head and whether anything was committed. Never pushes.
- `verify --pr <n> --gated <sha>`: run by the coordinator; fetches the PR head and reruns tree-receipt there, so QUEUE_STAMP is never a pasted claim.
- `gate-ahead --after <pr>`: prepares the merged worktree and prints the gated sha and the repo's gate command; the caller runs it (background or CI); `gate-ahead --record --exit <rc> --log <file>` binds the result to the gated tree, keyed by PR, and removes the worktree.
- ship-policy: optional `gate_command` and `full_e2e` keys; from this wave on, unknown keys WARN (naming the introducing version) instead of failing POLICY_INVALID, so mixed-version crews keep working.
- docs/ship-policy.md "Run a shared merge queue": each actor's copy-paste sequence and expected lines.
- Acceptance: tree-receipt says `same-modulo-stamps` on a real gbrain stamp commit with gbrain's committed policy (fixture from a recorded gbrain pair); diagnose GBRA-102's refusal (P-i) with a fixture before changing lib/restamp.ts.

**W2. Approval classes (item 3, High).** Modeled on gstack-banned-terms: `gstack-approval-classes init|validate|check --base <ref>` prints `APPROVAL_CLASS: <class> <file>:<line>` per hit and `APPROVAL_CLASSES: ok|found=<n>|none`. Classes come from the committed base-branch `.gstack/approval-classes.json` (globs, literal patterns, allowed_paths per class); migrations come from ship-policy's `migrations` key. Built-in detectors only report. Enforcement point: `gstack-ship-receipt write` refuses `APPROVAL_CITATION_MISSING` for a declared class without `Approved by <owner> <YYYY-MM-DD> via <ref>`; the receipt records an approval object. Citations are resolved: a plan sha must match an autoplan APPROVED gate record containing the decision; a URL must be a comment or review by a ship-policy maintainer; anything else is recorded `citation: unverified` for the coordinator. Data-repair: explicit, preview-first, not reachable from upgrade or migration paths (/review rule).

**W3. Round-trip matrix for state machines (item 4, High).** Unchanged from revision 1: a /review specialist builds kind × owner action × resulting row from the diff, maps cells to tests, names missing cells as High. Proof: #6792's shape as a free regression from a captured review plus one paid `behavior` case.

**W4. Timing-assertion check + flake playbook (item 2, High).** lib/pregate/checks/timing.ts: on added or changed test lines, flags elapsed wall/CPU-time comparisons against a bound and sleep-then-assert; prints `TIMING_ASSERTION: <file>:<line> <pattern>` plus a summary; escape `gstack-timing-ok: <reason>` in any comment syntax on the line or the line above, reason required. Before deciding block vs warn, measure it on the five gbrain flake diffs and gstack's own test tree; P4 says "flagged before merge" unless the measurement supports blocking (then it blocks). Same rule in /review's checklist; /investigate gets the flake playbook (same-load distributions on master and PR head, forced probe, rerun only with outside-cause evidence, never raise the bound).

**W10. Pregate config friction (item 8, Medium, after #3190 and #3225).** Land #3215 with its author's commits kept, after an untrusted-input review and a reviewer-written test; confirm #3190's `requires-remote` path with a gbrain-shaped fixture (`ci:ubicloud`, `UBI_OWNER`) and fix only what that shows.

**W12. update-check sees an unreleased main move (#2378's Claude Code half, Medium).** When VERSION is equal and the ls-remote main SHA differs from local HEAD, ask the GitHub compare API through the existing receipted curl (`status`, `ahead_by`), cached like today; print `UPGRADE_AVAILABLE <ver> <ver>+<n> <short sha>`, snooze keyed by SHA; a diverged or unknown compare is `CHECK_FAILED`-style unknown, never up to date or upgrade. Never fetches. gstack-upgrade/SKILL.md.tmpl's question text and changelog step handle the equal-version case (substitution test).

**W13 (deferred). cso auto-scope (item 12 part 2).** A measurement spike only: gbrain's admitted vs withheld bytes under cso's counting (P-h). If withheld >1 MiB payloads cause the overage, the fix is cap accounting (a decision for Garry, reported with numbers), not a scope heuristic. Automatic sibling expansion is built only after disconnected-sibling, alternate-transport, dynamic-registration and cutoff negative controls show its limits, over git objects at a recorded HEAD reusing lib/pregate/import-graph.ts's builder.

### Delivery shape

| PR | Contents | Base | Waits for |
|---|---|---|---|
| F1 | item 13 trailer + floor | main after #3190 | #3190 |
| F2 | item 12 part 1 | main | — |
| A | W5, W6, W7, W8, W9, W11; registers the wave's result codes and anchors | main after #3190 (and F1 for W11) | #3190, #3226 for autoplan templates |
| B | W1, W2, W3, W4, W10, W12 | A's branch | A; #3225 for pregate; #3200 for review tests |

Each PR: `gstack-lane-check --planned` clear against the others, focused tests during repair, the free suite once on its frozen tree on Ubicloud, `bun run eval:bg:pr`, /review clean, READY to GStack Minder.

### Out of scope

Capy-side machine replacement (item 5's root cause) and skill mounting (GBRA-56/65): reported to Capy. gbrain-repo config changes: handed to the gbrain crew through GStack Minder.

## Review record

- CEO r1 (native Opus 5.5: 6 High, 6 Medium; outside GPT-6.1 Sol: 4 High, 1 Medium, 1 user challenge): lane-check shared files → PR A owns codes, B stacks; QUEUE_STAMP verifiable → `verify`; base-movement race → --expect-base; gbrain policy → P-e corrected, acceptance on a real stamp; citations resolved; spend cap binds; cap never buries Critical; W13 measured first and deferred (user challenge folded in); W4 measured; W7 opt-in; F1 one staleness note; W8 declared fixtures; W6 separate public package; checkpoint after each bound voice.
- DX r1 (native: 3 High, 6 Medium, 1 Low; outside: 1 High, 3 Medium): W6 recorded roots only; W2 banned-terms model, declared classes only; ship-policy unknown keys WARN; one ship-queue entry; one READY format; coordinator how-to; F1 no "; " inside notes; W12 output/snooze; W11 fallback + measured budget; W4 line format; budget_exhausted resumable; stamp retry semantics; review-voice runtime boundary; cso advice per failure kind.
- Eng r1 (native: 4 High, 5 Medium, 1 Low; outside: 2 High, 2 Medium): closeDeferred and revise-after-cap; W2 enforcement in ship-receipt, migrations from policy; F2 manifest/entry limits disclosed; W12 compare API; W13 over git objects reusing import-graph; W8/W9 in eval-plan with MODEL_CATALOG; gate-ahead async with --record; pr_count on the gate; F1 check-mode fix for dirty/detached checkouts; F2 diff detector and replay contracts; revision-qualified finding ids.
