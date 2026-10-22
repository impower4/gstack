/**
 * Result codes for the release path: gstack-ship-queue and the ship-policy
 * floor, pregate timing and its working-tree fingerprint, regen with missing
 * dependencies, approval classes and
 * the state-machine matrix. Kept beside lib/result-codes.ts (which spreads
 * this table into RESULT_CODES) so
 * the owner module stays within the module-size ratchet; the same rules apply:
 * one stable docs/troubleshooting.md anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const RELEASE_RESULT_CODES = {
  // Field list 2, W1: gstack-ship-queue and the ship-policy compatibility floor.
  POLICY_GSTACK_TOO_OLD: {
    anchor: 'policy-gstack-too-old',
    summary: 'the ship policy sets min_gstack_version above this gstack, so this gstack refuses to read it',
    fix: 'upgrade gstack (bin/gstack-upgrade, or the session install with --for <skill>) to the version named, then rerun',
  },
  QUEUE_NOT_READY: {
    anchor: 'queue-not-ready',
    summary: 'the lane is not ready to report: the working tree, HEAD or CI state does not match the pushed PR head',
    fix: 'commit and push the work (or wait for CI on that exact head), then rerun gstack-ship-queue ready',
  },
  QUEUE_PROOF_MISSING: {
    anchor: 'queue-proof-missing',
    summary: 'a proof input the queue step needs is missing or does not match (gated head, base, stamp journal, version or tree)',
    fix: 'supply the named input (fetch the gated head, pass the expected sha), or regate; nothing was written',
  },
  QUEUE_STAMP_NOT_STAMP_ONLY: {
    anchor: 'queue-stamp-not-stamp-only',
    summary: 'the stamp commit differs from the gated head by more than stamps, so the gate does not cover it',
    fix: 'inspect the printed residual paths; drop the stray edit, or run the gate again on the stamped head',
  },
  QUEUE_VERIFY_MISMATCH: {
    anchor: 'queue-verify-mismatch',
    summary: 'the coordinator could not reproduce the lane’s stamp claim: the PR head, the recomputed gate-ahead merge or the gated tree differs',
    fix: 'do not merge; ask the lane to rerun gstack-ship-queue stamp (or gate-ahead) on the current queue and report again',
  },
  QUEUE_GATE_MISSING: {
    anchor: 'queue-gate-missing',
    summary: 'the policy sets full_e2e and no passing full-gate record is bound to this tree',
    fix: 'run the gate the policy names (gstack-ship-queue gate-ahead, then --record) or pass the record of a passing run on this head',
  },
  GATE_AHEAD_ATTEMPT_INVALID: {
    anchor: 'gate-ahead-attempt-invalid',
    summary: 'the gate-ahead attempt is unknown, already recorded, or its worktree no longer holds the gated commit',
    fix: 'list attempts with gstack-ship-queue gate-ahead --list, then record the live one, or prepare a new attempt',
  },
  // GSTA-49 lane T1: merge trains in gstack-ship-queue (docs/ship-policy.md#run-a-merge-train).
  QUEUE_TRAIN_OFF: {
    anchor: 'queue-train-off',
    summary: 'the base revision’s .gstack/ship-policy.json declares no `train` block, so the merge-train surface is off and the per-PR queue applies',
    fix: 'use the per-PR queue (ready, stamp, verify), or land a `train` block with min_gstack_version on the base branch first',
  },
  QUEUE_TRAIN_UNTRUSTED: {
    anchor: 'queue-train-untrusted',
    summary: 'a PR’s head repository is not the base repository; fork work never runs in a train (the train branch and its dispatch carry repository secrets)',
    fix: 'leave the PR out of the train (gstack-ship-queue train build --prs <list without it>); fork work stays on the trusted-branch path',
  },
  QUEUE_TRAIN_MOVED: {
    anchor: 'queue-train-moved',
    summary: 'a PR’s head (or the train branch) is no longer the SHA the train pinned, so the train would not test what merges',
    fix: 'ask the lane for a fresh READY on the new head, then rebuild the train with the new pin (train build --prs <n>@<new sha>,...)',
  },
  QUEUE_TRAIN_CONFLICT: {
    anchor: 'queue-train-conflict',
    summary: 'merging a PR onto the previous prefix conflicts outside the version files and the CHANGELOG; nothing was dispatched and no branch pushed',
    fix: 'run the printed train build without that PR; the PR’s lane merges main (with the earlier PRs once they land) and reports READY again',
  },
  QUEUE_TRAIN_FREE_RED: {
    anchor: 'queue-train-free-red',
    summary: 'the free tests dispatched on train/<nonce> are red, missing, cancelled or ran on another SHA, so the paid gate was not dispatched',
    fix: 'read the free-tests run; a PR-caused red drops that PR (train build --prs <list without it>), a flaky one goes to its owner before the next build',
  },
  QUEUE_TRAIN_DISPATCH_UNKNOWN: {
    anchor: 'queue-train-dispatch-unknown',
    summary: 'a train dispatch was attempted but its run could not be found by nonce, so whether it started is unknown; it is never re-dispatched blindly',
    fix: 'run gstack-ship-queue train status --train <nonce>: it finds the run by nonce, or marks the dispatch absent so train build --train <nonce> may dispatch it',
  },
  QUEUE_TRAIN_WAITING: {
    anchor: 'queue-train-waiting',
    summary: 'the train is below its size and its oldest READY PR has waited less than the policy’s fill time, so it does not dispatch yet',
    fix: 'add READY PRs, rerun once the printed time has passed, or pass --urgent for a one-PR train',
  },
  QUEUE_TRAIN_PENDING: {
    anchor: 'queue-train-pending',
    summary: 'the train’s run (free tests, the full gate or the bisect) has not finished, so there is no verdict yet',
    fix: 'rerun the printed NEXT: command later; nothing is dispatched again while a run is pending',
  },
  QUEUE_TRAIN_INCOMPLETE: {
    anchor: 'queue-train-incomplete',
    summary: 'the train gate did not complete its census (INFRA or INCOMPLETE panels, an unbound, partial or cancelled shard, a slice killed before upload, or no published record), so it is never green',
    fix: 'when every gap is machine-classified INFRA or INCOMPLETE, take the one re-dispatch EVAL_POLICY.infraRedispatch allows (train rebuild --train <nonce> --infra) and report both runs; otherwise diagnose the run',
  },
  QUEUE_TRAIN_RED: {
    anchor: 'queue-train-red',
    summary: 'the train’s full gate is red on the train tree; its PRs do not merge, and nothing is retried to change the verdict',
    fix: 'bisect the red cases (train bisect --train <nonce> --spend-cap <usd>); after a rebuild’s second red, route the cases to a repair lane',
  },
  QUEUE_TRAIN_RED_ON_MAIN: {
    anchor: 'queue-train-red-on-main',
    summary: 'the bisect found the red cases red on every prefix, main (T0) included: main is broken, not the train’s PRs',
    fix: 'fix forward on main first (a one-PR train), then rebuild this train unchanged',
  },
  QUEUE_TRAIN_UNATTRIBUTED: {
    anchor: 'queue-train-unattributed',
    summary: 'the bisect pattern blames no PR and not main (all green, or not monotone); one trial cannot tell a flake from a break',
    fix: 'all green: the one preregistered rebuild (train rebuild --train <nonce>), reporting both runs; any other pattern: a repair lane, then a changed train',
  },
  QUEUE_TRAIN_BISECT_CAPPED: {
    anchor: 'queue-train-bisect-capped',
    summary: 'the bisect’s reserved price (every case×prefix trial, unknown costs at the policy reservation) passes the spend cap; completed prefixes are kept and the outcome stays unattributed',
    fix: 'resume with a higher cap (train bisect --train <nonce> --spend-cap <usd>); only prefixes without a result run',
  },
  QUEUE_TRAIN_PREFIX_INVALID: {
    anchor: 'queue-train-prefix-invalid',
    summary: 'a bisect prefix is not an ancestor of the train head on train/<nonce>, or a red case is not in the gate’s plan, so the bisect inputs are refused',
    fix: 'check that train/<nonce> still points at the recorded head (train status); a moved branch needs a new train',
  },
  QUEUE_TRAIN_REBUILD_REFUSED: {
    anchor: 'queue-train-rebuild-refused',
    summary: 'the rebuild is not allowed: the bisect was not all green, the train was already rebuilt (or re-dispatched), or there is no bisect or INFRA record',
    fix: 'route the red cases to a repair lane; the train is rebuilt only once the repair merges (a changed train)',
  },
  QUEUE_TRAIN_TREE_MISMATCH: {
    anchor: 'queue-train-tree-mismatch',
    summary: 'main’s tree is neither the train’s prefix before this PR nor after it (modulo stamps), so the merge does not publish what the gate tested',
    fix: 'stop merging; if earlier PRs of the train merged, the queue is frozen (QUEUE_TRAIN_FROZEN); otherwise rebuild the train on current main',
  },
  QUEUE_TRAIN_FROZEN: {
    anchor: 'queue-train-frozen',
    summary: 'a train stopped partway through publication, so main holds a prefix no gate covered on its own; ordinary trains are refused until a repair lands',
    fix: 'admit one repair PR at its exact head (train build --repair --prs <n>@<sha>); the freeze clears when verify finds main’s tree after that merge in a green record',
  },
  READY_SCREEN_CHOICE_REQUIRED: {
    anchor: 'ready-screen-choice-required',
    summary: 'the base policy turns trains on, so READY needs an explicit screen choice: --screen (pay for a diff-relevant screen now) or --no-screen',
    fix: 'rerun gstack-ship-queue ready with the printed recommendation (--screen or --no-screen); say in the READY block if focused local cases already ran',
  },
  // Field list 2 W4 (pregate `timing`).
  PREGATE_TIMING_ASSERTION: {
    anchor: 'pregate-timing-assertion',
    summary: 'an added or changed test line compares an elapsed wall-clock or CPU time against a bound, or sleeps and then asserts (a warning, not a block)',
    fix: 'assert on the outcome, an injected clock or a forced deadline instead; when the bound is the contract, add `gstack-timing-ok: <reason>` in a comment on the line or the line above',
  },
  // Field list 2, W2 (approval classes) and W3 (state-machine round-trip matrix).
  APPROVAL_CLASSES_INVALID: {
    anchor: 'approval-classes-invalid',
    summary: '`.gstack/approval-classes.json` is malformed, a class matches nothing, or a path escapes the repository',
    fix: 'keep `classes` a non-empty list of uniquely named classes, each with `paths`, `patterns` or `migrations: true`, and every glob repo-relative (`gstack-approval-classes validate` checks the working-tree copy)',
  },
  APPROVAL_CLASS_FOUND: {
    anchor: 'approval-class-found',
    summary: 'the branch changes something a declared approval class covers',
    fix: 'get the owner\'s approval and put `Approved by <owner> <YYYY-MM-DD> via <plan sha|comment or review URL> for <class>@<digest12>` in the PR body, using the APPROVAL_SCOPE token the check printed',
  },
  APPROVAL_CITATION_MISSING: {
    anchor: 'approval-citation-missing',
    summary: 'a declared approval class has no citation that resolves and binds to its current effects, so no receipt was written',
    fix: 'add an `Approved by` line whose plan (with --approval-run <dir>) or maintainer comment names the APPROVAL_SCOPE token or the class and every effect path; for evidence gstack cannot read, attest it with `for <class>@<digest12>` on the line. Only the owner approves: never write the line without their approval',
  },
  APPROVAL_SOURCE_UNAVAILABLE: {
    anchor: 'approval-source-unavailable',
    summary: 'origin/<base> is not a resolvable commit, so the committed .gstack/approval-classes.json cannot be read and nothing was checked',
    fix: 'git fetch origin <base> (classes are never read from the working tree)',
  },
  STATE_MATRIX_INCOMPLETE: {
    anchor: 'state-matrix-incomplete',
    summary: 'the state-machines specialist output lacks a kind × owner action cell, maps a cell to a test that does not exist, or leaves an untested cell without a CRITICAL finding',
    fix: 'rerun the state-machines specialist on the same diff; its review coverage stays incomplete until gstack-state-matrix check passes',
  },
  // Fix wave 2026-10-15, PR 5 (item 10b, #3197).
  WTREE_UNAVAILABLE: {
    anchor: 'wtree-unavailable',
    summary: 'cannot fingerprint the working tree: bin/gstack-wtree could not start (on Windows, no Git Bash was found) or it ran and failed',
    fix: 'on Windows point GSTACK_GIT_BASH at Git Bash\'s bash.exe (Git Bash: export GSTACK_GIT_BASH=\'C:/Program Files/Git/bin/bash.exe\'; PowerShell: $env:GSTACK_GIT_BASH = \'C:\\Program Files\\Git\\bin\\bash.exe\'), or install Git for Windows (winget install --id Git.Git -e); elsewhere rerun ./setup so bin/gstack-wtree is present; then rerun gstack-pregate',
  },
  // Fix wave W5 (GSTA-31): pregate regen without installed dependencies.
  REGEN_DEPS_MISSING: {
    anchor: 'regen-deps-missing',
    summary: 'a regen command exited 0 with different outputs while package.json declares dependencies and node_modules is missing, so the outputs were not verified',
    fix: 'install the dependencies (the printed command, such as bun install), then rerun the check',
  },
} as const satisfies Record<string, ResultCode>;
