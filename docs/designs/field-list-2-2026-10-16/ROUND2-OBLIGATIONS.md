# Field list 2: round-2 review findings (build obligations)

Approved by Garry 2026-10-16 ("all", gate_rev=2, relayed by GStack Minder GSTA-36). Autoplan run run-20261016222410. Every lane treats the findings for its items as requirements; verify each against code first (a finding that is wrong gets a written reason in the lane report).

## ceo / native

- **High: F2 and the still-open #3215 edit the registries PR A now owns, so A's lane-check cannot be clear** (docs/troubleshooting.md:1207). Fix: Have GStack Minder merge #3215 on its own first (or close it as superseded with credit once B carries its commits); rebase F2 after #3190 or move its troubleshooting.md edit into A; record both on the gate.
- **Medium: Stacking B on A delays W1/W2 (P1, P2) behind six autoplan items and a draft dependency (#3226)**. Fix: Let readiness order the stack: whichever of A or B has its external dependencies merged first is built first and owns the registries; today that is likely B (W1/W2) since #3226 is a draft.
- **Low: Release promise P4 still says 'caught before merge' while W4 now says 'flagged unless measured'**. Fix: Reword P4 to 'flagged before merge (blocking if the five-flake measurement supports it)'.
- **Low: F1 f315806: the session's behind line still prints the rerun fix when the trailer's fix is gstack-upgrade; non-default branches are treated as fast-forwardable** (bin/gstack-capy-session). Fix: Print $GSTACK_CAPY_BEHIND_FIX on the behind line and classify a non-default branch like detached (gstack-upgrade refuses it).

## ceo / outside

- **High: Resolved approval citations still lack binding to the effects being shipped**. Fix: Bind approval classes and approved effects to the current plan/scope digest, invalidate reuse after effect changes, and require explicit applicability attestation for unresolved evidence; test unrelated authentic approvals and post-approval effect additions.
- **High: Deferred close must not release reservations for already dispatched reviews** (lib/spend-ledger.ts:149). Fix: Settle dispatched or execution-unknown attempts as known or unknown while retaining their reservation amount; release only proven never-dispatched work, distinguish review deferral from host cancellation, and test close/resume without recovered spend headroom.
- **High: Warning on every unknown ship-policy key weakens safety without fixing old-client compatibility** (lib/ship-policy.ts:195). Fix: Keep unknown safety-policy keys fail-closed and require a compatible minimum revision before enabling new policy fields; explicitly bound any optional extension mechanism and test an old client plus a misspelled gate-reuse restriction.

## dx / native

- **Medium: WARN-on-unknown keys helps only future gstacks; lanes on 1.91.106 and earlier still fail POLICY_INVALID once gbrain commits gate_command/full_e2e** (lib/ship-policy.ts:201). Fix: The gbrain handoff and docs/ship-policy.md add gate_command/full_e2e only after the crew's GSTACK_MIN_REVISION reaches B's version; gstack-ship-policy validate prints each key's introducing version.
- **Medium: W8 adds check-prereg beside the existing gstack-eval-plan prereg --check** (bin/gstack-eval-plan:5). Fix: Extend prereg --check: with a declared synthetic fixture it requires --allow-repo-commands (else lists commands and exits 3, like gstack-restamp) and fails PREREG_DIAGNOSTIC_UNTESTED on mismatch; no second verb.
- **Medium: budget_exhausted recovery names an owner-authorized cap raise, but spend cap and max rounds are set only at run creation** (lib/autoplan-run.ts:113). Fix: Add gstack-autoplan budget --out <dir> [--spend-cap <usd>] [--max-rounds <n>] --by <owner> that journals the change; print it with close --deferred in the budget_exhausted recovery lines.
- **Low: W11 fallback clone command elides its target directory and bypasses the wrapper's floor check**. Fix: Spell out the full command with the root the wrapper resolves, and print the installer's cloned <root> line so the trailer and the clone agree.

## dx / outside

- **Medium: The new no-Drive bootstrap does not locate the cloned installer or preserve project context** (bin/gstack-capy-install:36). Fix: Publish a fallback with an explicit dedicated install root and absolute installer invocation, preserve caller project identity and working directory, handle an existing install, and execute the exact cold and repeat-session brief through a real helper invocation in a non-gstack fixture project.

## eng / native

- **High: verify cannot fetch the gate-ahead merge commit, which exists only in the lane's throwaway worktree** (lib/restamp.ts:588). Fix: verify --gated-tree recomputes the merge with git merge-tree --write-tree <predecessor_head> <branch_head> and compares it to the recorded gated_tree before tree-receipt (or gate-ahead --record pushes the gated commit to refs/gstack/gated/<pr>); test gate-ahead then verify from a separate clone.
- **Medium: budget_exhausted as a resumable run status is neither in the status enum nor terminal, so old validators and export both fail** (lib/headless-artifacts.ts:91). Fix: Use the existing terminal 'incomplete' with a stop object {reason:'budget_exhausted', cap_usd, rounds, spent, reserved, unknown}; resume from incomplete only with that reason after a budget raise.
- **Medium: validate --public cannot fail on recorded machine roots because the public package carries none**. Fix: validate --public <dir> --private <run.json> on the exporting machine fails on recorded roots and runs inside export before writing; standalone validation checks provenance digests and WARNs on generic patterns.
- **Medium: MODEL_CATALOG holds one current model per provider x tier, so W9's newest-generation-per-family rule cannot resolve through it (corrects round-1 F7)** (lib/model-catalog.ts:24). Fix: eval-models.json states allow/deny ids or globs, per-tier allow lists and an optional ordered families map (newest first); MODEL_CATALOG only checks frontier/smart currency; unknown ids fail closed.
- **Low: F2 cites ~7.5k gbrain files; the tracked tree has 11,570 blobs**. Fix: Correct the number (about 3.9 MiB of manifest at the cap's density, still within limits) and size F2's capacity fixture from the real count.

## eng / outside

- **High: Asynchronous gate-ahead needs attempt-owned worktrees, records and cleanup** (lib/restamp.ts:553). Fix: Isolate each preparation by an immutable attempt handle and worktree; bind completion to its gated/predecessor/command identities, protect live attempts, retain evidence before owned cleanup, and test concurrent preparations with out-of-order completion.
- **Medium: Equal-version update comparisons cannot reuse the version-only cache** (bin/gstack-update-check:195). Fix: Bind cached comparison validity to local HEAD and upstream identity, store the compared remote SHA, invalidate legacy entries without identities, and test same-version fast-forward and divergent branch changes after a cached upgrade.
- **Medium: The four-entry reviewer model catalog cannot resolve general eval-model rules** (lib/model-catalog.ts:24). Fix: Apply literal allow/deny independently of catalog membership, separate eval scope from review tier, and require explicit supported latest-series mappings or report unresolved newest-generation rules; test uncatalogued allowed/denied models and smoke-only rules.

