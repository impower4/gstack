# Plan: cache profile summaries in one process

## Measured problem and accepted scope
The existing profile-summary service has one active process. A one-week trace
shows repeated reads of about 900 hot keys: DB CPU is 70%, with read p95 120 ms.
Add a process-local LRU wrapper to the existing repository. Acceptance targets
are at least 60% cache hits, DB CPU below 50%, and read p95 below 60 ms, with the
existing error-rate and correctness SLOs unchanged. This is an internal backend
change with no UI, API, schema, pricing, or developer onboarding change.

## Existing contracts retained
- All reads and writes use this repository in the same process; there are no
  external DB writers. Multi-process operation remains unsupported and startup
  rejects that configuration while caching is enabled.
- These surrounding contracts are accepted fixture facts, supplied by the
  existing repository, cache adapter and rollout controller. Preserve them;
  review the new wrapper ordering below against them.
- Authentication and authorization run before repository access. Keys encode
  the authenticated tenant ID and validated profile ID without ambiguity.
  Values are immutable profile-summary DTOs; secrets and cache keys are never
  logged. Cached results cannot bypass authorization.
- The existing LRU adapter supports 1000 entries, a 16 MiB byte cap, and a
  30-second TTL. Recorded hot data fits those limits. repository.read returns
  an immutable absent-result DTO for a missing record, never undefined. The
  adapter recognizes that DTO in cache.set, stores an internal sentinel with a
  10-second TTL, and cache.get decodes it back to the same absent-result DTO.
  The internal sentinel cannot escape the adapter; undefined means a cache miss.
- Cache operations are synchronous and atomic in the single JS event loop.
  On any cache failure the existing adapter bypasses the cache until an empty
  cache is reinitialized; repository errors keep the current typed API error
  mapping. The existing per-key single-flight wrapper sits inside
  repository.read, coalesces simultaneous store reads and releases on failure.
  A committed repository.write retires that key's old read cohort before its
  promise resolves. A later repository.read starts a fresh cohort; a rejected
  write leaves the cohort unchanged. Already-started readers may finish with
  their earlier snapshot. This admission rule does not inspect cache fills.
- The repository uses an in-process transactional store, with no network
  transport between this wrapper and the store. repository.write is atomic:
  a resolved promise means committed, and every
  rejected promise guarantees no commit; its transaction rolled back before
  rejection. Existing contract tests exercise that guarantee.
- Consistency is measured at the public wrapper boundary. A write completes
  when writeProfile's promise fulfills after cache.delete, not when
  repository.write commits or resolves. A read begins when readProfile is
  invoked. Reads that overlap an unfinished writeProfile may return an earlier
  snapshot, including reads begun after the store commit but before the wrapper
  promise fulfills. Every read begun after that write completes must
  observe the committed version. TTL expiry is not a substitute for this rule.

## Proposed wrapper integration
Keep the current read-through repository interface and shared adapters. These
are the new read/write ordering rules. Original draft statement: "no additional
version checks or coordination between a cache fill and a write are proposed" —
**amended by WR-1 (D1, option A)**: that statement contradicted the retained
boundary rule above (reads begun after a completed write must observe the
committed version), so the wrapper MUST add one guard:

- **Fill-staleness guard (required guarantee):** readProfile's `cache.set` is
  suppressed when any writeProfile for that key completed its `cache.delete`
  after the read's `repository.read` began. The wrapper tracks per-key write
  completion in-process (synchronous, single event loop; captured before the
  store read, compared before the fill). writeProfile behavior is unchanged
  otherwise. The exact data structure and pruning are engineering decisions;
  bound its memory to live keys (drop the record when the key is deleted or the
  cache instance is retired). A suppressed fill returns the read's value to its
  caller unchanged (the overlapped read may still return the earlier snapshot).
- Tradeoffs: one small per-key state surface in the wrapper; keys written during
  an in-flight fill lose that fill (the next read refills), a negligible hit-rate
  cost at the recorded write rate. No adapter, controller, limit or TTL change.

The drafted bodies below show the base ordering only; the guard above is a
required addition, not yet reflected in this sketch:

```javascript
async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  cache.set(key, value);
  return value;
}

async function writeProfile(key, update) {
  const saved = await repository.write(key, update);
  cache.delete(key);
  return saved;
}
```

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, authorization, and startup rejection of multi-process
operation while caching is enabled. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, and concurrent-miss coalescing.
**Added by WR-1 (D1, option A)** — deterministic harness scenarios, both
completion orders for each: (a) read misses, store read snapshots v1, write
commits v2 and completes, read resumes: fill suppressed, next read observes v2;
(b) write completes before the read's store read begins: fill allowed, value is
v2; (c) same as (a) with a missing record created by the write: no stale absent
sentinel, next read observes the new record; (d) two overlapping writes v2, v3
with a read fill interleaved: final cache state never holds v2 after v3 completes;
(e) rejected write during an in-flight fill: fill allowed, cohort unchanged;
(f) controller instance change during a fill: old instance fill cannot land in
the new instance. Record the suppressed-fill count on the current dashboard with
no key labels (existing telemetry; no new alert or metric project).
The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. Monitor hit/miss,
eviction, cache bytes, fallback errors, DB CPU, and read p95 without raw IDs.
The existing controller uses one shared key-selection predicate for reads and
writes. On any enable, disable or percentage change, it stops admitting work,
awaits every admitted old-instance write, then publishes a new wrapper/cache
instance with a fresh single-flight cohort before admitting new work. Old reads
retain their old instance and cannot fill the new one. Disabled instances
bypass the cache on both paths. Tests cover the old-writer/new-reader ordering,
all those transitions and predicate parity. This lifecycle isolation does not coordinate
an ordinary DB write with a cache fill in the same active instance.
Existing dashboards and runbooks cover these metrics. Before each stage, verify
that alerts page the service owner on any correctness/error-SLO breach, read
p95 above 120 ms for five minutes, or cache bypass persisting for one minute.
Hit rate is hits / (hits + misses) among requests admitted to the cache path;
flag-excluded or adapter-bypassed requests are tracked separately, not as misses.
DB CPU and read p95 are service-wide metrics, including bypassed requests.
At the 10% and 50% stages, a healthy hour requires at least 60% admitted-request
hits, unchanged correctness/error SLOs, no alerts, and aggregate DB CPU/read p95
no worse than their 70%/120 ms pre-rollout baselines. At 100%, the original
absolute acceptance targets (DB CPU below 50%, read p95 below 60 ms, hits at
least 60%) must all hold with unchanged correctness/error SLOs and no alerts.
Any breach disables the flag immediately; the runbook records the incident,
rollback and criteria for resuming. These are existing
rollout-controller and telemetry contracts, not proposed wrapper additions.
Cold starts remain within the existing DB capacity. The service owner monitors
the rollout and records the results against the acceptance targets.

## Out of scope
Distributed caching, cross-process coherence, prewarming, changing consistency
semantics, or adding new product surfaces. The repository interface preserves a
future replacement path without introducing a general cache framework now.

## Author's review and acceptance requirements
This is a full CEO scope and feasibility review. The author has approved the
retained contracts, limits, rollout and acceptance targets above. Evaluate the
proposed wrapper against them; the wrapper itself remains unapproved. An actual
contradiction or missing proof must be reported and resolved, not assumed away.
For a demonstrated gap, amend the plan with the required guarantee, a feasible
remedy, its tradeoffs and deterministic regression scenarios. Those repairs
and their required verification are within the requested scope. The exact data
structures, full function bodies and executable test code belong to subsequent
engineering planning; do not select or implement them during this review when
the required behavior and feasibility can already be established.

Use the existing deterministic repository-contract test harness. Required wrapper
acceptance includes both completion orders of overlapping reads and writes,
missing-record creation, rejected reads/writes, overlapping writes, and isolation
across controller instance changes. Use existing telemetry to record any added
branch on the current dashboard with no key labels; no new alert threshold or metric
project is requested. These are future acceptance requirements, not tests already
implemented or passing. Preserve all 11 review outcomes, required registries,
diagrams, tasks, completion summary and the full GSTACK REVIEW REPORT.

---

# CEO Review (plan-ceo-review, 2026-09-29, HOLD SCOPE)

Review depth: implementation-ready (author requests full scope and feasibility
review; data structures, function bodies and test code stay with engineering).
Storage: this file is the working plan and final output. Outside review:
`codex_reviews: disabled` (.gstack-section-state-chgk2g/config.yaml) — skipped
including native fallback; outside coverage reported as disabled. Preamble,
system audit, telemetry and codebase exploration skipped per run instructions.
Base branch: main (fixture; git commands not run).

## Step 0

### 0A. Premise
Real problem: ~900 hot keys re-read from the DB by one process; DB CPU 70%,
read p95 120 ms (one-week trace, PLAN.md:4-6). Target: >=60% hits, DB CPU <50%,
p95 <60 ms, SLOs unchanged. Do-nothing cost: DB headroom keeps shrinking and
every traffic bump lands on read latency. The plan removes the repeated reads at
their source, so it attacks the pain directly, not a proxy.

### 0B. Existing code leverage
| Sub-problem | Reuse | New |
|---|---|---|
| storage, limits, TTL, absent sentinel, failure bypass | existing LRU adapter (PLAN.md:23-30) | none |
| concurrent-miss coalescing | single-flight inside repository.read (PLAN.md:33-36) | none |
| staged rollout, instance swap | existing controller + flag + predicate (PLAN.md:77-87) | none |
| dashboards, alerts, runbooks | existing telemetry (PLAN.md:88-101) | none |
| read/write ordering | — | readProfile/writeProfile wrapper + tests |
No rebuild; refactoring nothing. Wrapper is the only new code.

### 0C. Dream state
```
  CURRENT STATE                  THIS PLAN                  12-MONTH IDEAL
  every read hits DB;    --->    process-local LRU   --->   repository interface
  DB CPU 70%, p95 120ms          read-through, write        keeps a swap point for
  one process                    invalidation, staged       a shared cache if the
                                 flag rollout               service ever scales out
```
Plan moves toward the ideal without buying the distributed cache early.

### Decision ledger
| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| WR-1 (owner: plan author / service owner) | Retained boundary rule PLAN.md:42-48: every read begun after writeProfile completes must observe the committed version; TTL is not a substitute. Evidence of gap: PLAN.md:33-36 (already-started readers finish with earlier snapshot; admission rule ignores cache fills) + PLAN.md:52-53 (no fill/write coordination) + PLAN.md:55-62 (readProfile fills after await). Stale-fill order: R1 miss -> R1 store read (v1) -> W commit v2 -> W cache.delete -> W fulfills -> R1 cache.set(v1) -> R2 (begun after W) hits v1. Same order with the absent-result DTO leaves a stale 10 s sentinel after record creation. | Wrapper as drafted (PLAN.md:55-69), unapproved | A) add fill-staleness guard requirement; B) keep wrapper as drafted; C) write-through population | approved (A) | D1 answered by authorized auto-decision: run author policy ("Authorize complete remedies and required verification that restore its retained contracts... use the recommended option") — AskUserQuestion unavailable, no human present. Scope: amend "Proposed wrapper integration" ordering rules with the fill-staleness guard requirement and "Verification and rollout" with its regression scenarios and dashboard count. Not approved: adapter, controller, limit, TTL or consistency-semantics changes; data structure and code selection stay with engineering. |

## currentDecision (WR-1)
Commitment comparison:
```text
Commitment | Source/approval or pending | Current | A | B | C
Read begun after write completion observes committed version | PLAN.md:46-48 approved (retained) | required | met: fill suppressed when a write completed on the key during the read | violated for up to 30 s (10 s absent) | met for read/write pairs; violated when two overlapping writes set out of order
Read-through interface + shared adapters | PLAN.md:51 approved | kept | kept | kept | changed: writes populate, reads never fill
Adapter limits 1000 / 16 MiB / 30 s / 10 s absent | PLAN.md:23-27 approved | unchanged | unchanged | unchanged | unchanged
Single-flight + controller lifecycle | PLAN.md:33-36, 80-87 approved | unchanged | unchanged | unchanged | unchanged
Fill/write coordination in wrapper | PLAN.md:52-53 pending (unapproved) | none | per-key write-completion check before cache.set; data structure left to engineering | none | none (reads do not fill)
Hit target >= 60% | PLAN.md:7 approved | required | achievable; fills lost only for keys written mid-fill | achievable | not credible for read-heavy, rarely written keys
Wrapper acceptance tests | PLAN.md:73-76, 122-125 approved | listed | + both completion orders with stale-fill suppression, absent-sentinel fill suppression, overlapping writes | as listed | rewritten for write-through
Telemetry | PLAN.md:125-127 approved | existing dashboard, no key labels | + suppressed-fill count on current dashboard, no key labels | none | none
```

Question: D1 — WR-1: How does the wrapper honor the retained rule that reads begun after a completed write see the committed version?
Project/branch/task: main — profile-summary process-local LRU wrapper plan.
ELI10: A read can miss the cache, go to the database, and get the old value. Before it comes back, a write finishes and clears the cache. The slow read then stuffs the old value into the cache, and everyone who reads next gets the stale copy for up to 30 seconds. The plan promises that cannot happen, but the drafted wrapper has no check for it.
Stakes if we pick wrong: users see a profile they just saved revert for up to 30 s; correctness SLO breach triggers rollback and the cache never ships.
Recommendation: A because it restores the retained contract with a synchronous in-process check, no adapter/controller/limit changes, and a small diff; B contradicts an approved requirement and C cannot reach the hit target.
Completeness: A=10/10, B=3/10, C=5/10
Net: A trades a tiny per-key write-completion record for keeping the promised consistency; B saves nothing worth the stale reads; C moves the race instead of removing it.
Header: WR-1 stale fill
A) Add fill-staleness guard requirement (recommended)
Amend the wrapper ordering rules: a read's cache.set is suppressed when any writeProfile for that key completed its cache.delete after the read's store read began; the wrapper tracks per-key write completion in-process, exact structure left to engineering. Effort S, risk low, reuse high (adapter, single-flight, controller unchanged). Verification: deterministic harness scenarios for both completion orders, missing-record creation, overlapping writes, rejected write, instance isolation. ✅ Restores the retained boundary rule at PLAN.md:46-48 without changing limits, TTL or consistency semantics. ✅ Synchronous single-event-loop check with no new dependency and no adapter or controller change. ❌ Adds a per-key write-completion record the wrapper must bound and test as one more small state surface.
B) Keep the wrapper exactly as drafted
Zero implementation work; accept that a read begun before a write completes can fill the stale snapshot after cache.delete, so later reads see stale data for up to 30 s (10 s for absent). Effort S (zero implementation work), risk high, reuse full, verification as currently listed. ✅ Zero additional code; the two functions remain the only wrapper surface. ✅ No new state; hit rate is never reduced by writes landing during fills. ❌ Contradicts the retained consistency contract (PLAN.md:46-48, "TTL expiry is not a substitute") and would need an unauthorized weakening of a retained requirement.
C) Write-through population, reads never fill
writeProfile sets cache with the committed value after commit; readProfile only reads the cache and falls through to the store without filling. Effort M, risk medium, reuse partial (read-through interface changed), verification rewritten. ✅ No stale fill from reads because reads never mutate the cache. ✅ Single mutator ordering is simple to reason about for one read and one write. ❌ Read-heavy, rarely written hot keys never enter the cache so the 60% hit target is not credible, and two overlapping writes can still set out of order.

**D1 answer:** A (authorized auto-decision, see ledger row WR-1). Applied at PLAN.md "Proposed wrapper integration" and "Verification and rollout".

### 0E. Mode
HOLD SCOPE by explicit user instruction (no question asked, no question log).
Handoff: fix/refactor of one internal read path, 2-3 changed files (wrapper
module, wrapper tests, possibly a dashboard panel definition; estimate). Approved
decisions: WR-1 (D1 -> A). No new approach decision beyond WR-1 was needed.

### 0G. HOLD SCOPE checks
1. Complexity: <=3 files, 0 new classes/services. OK, no challenge.
2. Minimum change: two wrapper functions + WR-1 guard + tests. Nothing is
   deferrable without breaking an acceptance target; no defer/keep questions.
3. Invariants and acceptance criteria kept unchanged; WR-1 repair is in scope.

### 0I. Temporal interrogation
```
  HOUR 1 (foundations):    adapter API (get/set/delete, undefined = miss, absent
                           sentinel), single-flight cohort rules, controller swap
  HOUR 2-3 (core logic):   WR-1 guard: what "write completed during my read"
                           means; where per-key write state lives and is pruned
  HOUR 4-5 (integration):  flag predicate parity; controller retires old instance
                           while a fill is in flight; adapter bypass on failure
  HOUR 6+ (polish/tests):  deterministic pause/release harness for both orders;
                           dashboard panel for suppressed fills without key labels
```
Feasibility blockers: none after WR-1. Pending (engineering): data structure for
per-key write completion; pruning rule. Effort: human ~1.5 days / CC ~30 min.

## Review Sections (HOLD SCOPE, implementation-ready)

Current scope: retained contracts PLAN.md:11-48 (accepted), wrapper + WR-1 guard
(accepted via D1 -> A), verification list + WR-1 scenarios (accepted), rollout
and telemetry (existing, accepted). Deferred: none. Rejected: WR-1 options B, C.
Pending (engineering-owned): guard data structure, pruning.

### Section 1: Architecture Review
```
  caller --> controller(flag predicate) --> wrapper[readProfile/writeProfile]
                                                |            |
                                          cache adapter   repository(single-flight)
                                          (LRU 1000/16MiB       |
                                           30s, absent 10s)  in-process tx store
  new: wrapper + per-key write-completion state (WR-1). everything else existing.
```
Data flow paths: happy = miss -> store -> fill -> value; nil = absent DTO ->
sentinel (10 s) -> decoded DTO; empty = n/a (DTOs are whole records; key
validation upstream rejects empty keys); error = repository rejects -> typed
API error, no fill, single-flight releases. State machine (per key): EMPTY ->
FILLING -> CACHED -> (write) EMPTY; FILLING -> (write completes) EMPTY with fill
suppressed (WR-1). Invalid: CACHED with a version older than a completed write;
prevented by cache.delete + WR-1 guard. Coupling: wrapper depends on adapter and
repository only; justified. Scaling: 10x load = same 900 keys, cache absorbs;
100x = DB CPU on misses and cold start (existing capacity per PLAN.md:102).
SPOF: the single process (pre-existing). Security: no new surface. Rollback:
flag off, seconds. **WARNING** (accepted, resolved): WR-1. Outcome: 1 finding
(WR-1, resolved). Gate: prior answer D1 covers it; plan matches.

### Section 2: Error & Rescue Map
```
  METHOD/CODEPATH   | WHAT CAN GO WRONG                  | EXCEPTION CLASS
  readProfile       | cache.get adapter failure          | adapter-internal -> bypass
                    | repository.read rejects (DB error) | existing typed API error
                    | stale fill after completed write   | none (logic) -> WR-1 guard
  writeProfile      | repository.write rejects           | existing typed API error
                    | cache.delete adapter failure       | adapter-internal -> bypass
  controller swap   | fill lands in retired instance     | none; isolated by design

  EXCEPTION CLASS       | RESCUED? | RESCUE ACTION                | USER SEES
  adapter failure       | Y        | adapter bypasses until reinit| slower reads; alert at 1 min bypass
  typed API error       | Y        | existing mapping, no fill    | existing error response
  stale fill (logic)    | Y (WR-1) | suppress fill, count it      | fresh data
```
No catch-alls proposed. Verify (existing adapter-failure fallback test) that a
cache.delete failure inside the adapter does not reject writeProfile after a
committed write; the retained contract says the adapter bypasses on any failure.
Outcome: 3 error paths mapped, 0 GAPS after WR-1.

### Section 3: Security & Threat Model
No new endpoint, input, dependency or secret. Keys carry authenticated tenant +
validated profile ID (PLAN.md:19-22); cache cannot bypass authorization. Threats:
cross-tenant hit via key collision (Low/High, mitigated by unambiguous key
encoding, existing tenant-isolation tests); key/PII in logs (Low/Med, mitigated:
no raw IDs in metrics, suppressed-fill count carries no key labels); memory
exhaustion (Low/Low, 16 MiB cap). Outcome: 0 issues, 0 High.

### Section 4: Data Flow & Interaction Edge Cases
```
  readProfile: INPUT key -> (validated upstream) -> cache.get -> miss -> repository.read
     -> WR-1 check -> cache.set or suppress -> OUTPUT DTO
  shadow: absent -> sentinel path; reject -> typed error, no fill; adapter fail -> bypass
```
Async schedule (invariant PLAN.md:46-48, boundary = wrapper promises):
```
  t | R1 readProfile          | W writeProfile            | cache[k]   | R2
  1 | get -> miss             |                           | -          |
  2 | await repository.read   |                           | -          |
  3 |   (snapshot v1)         | await repository.write v2 | -          |
  4 |                         | commit; cohort retired    | -          |
  5 |                         | cache.delete; fulfill     | -          | (W complete)
  6 | resume; WR-1: write     |                           | -          | begin
    | completed after t2 ->   |                           |            |
    | suppress set; return v1 |                           |            |
  7 |                         |                           | -          | miss -> store -> v2  OK
  without WR-1: t6 cache.set(v1) -> t7 R2 hits v1  VIOLATION
```
Reverse order (W completes before R1's store read begins): R1 reads v2, fills v2,
correct. Overlapping writes W2/W3 with a fill: any fill that began before the
last completed write is suppressed; cache never holds v2 after W3 completes.
Rejected write: no delete, cohort unchanged, fill allowed (value is the still
committed version). Interaction edge cases: no UI. Regression proof: scenarios
(a)-(f) in "Verification and rollout". Outcome: 6 edge cases mapped, 0 unhandled.

### Section 5: Code Quality Review
Wrapper fits the existing repository/adapter pattern; no duplication (reuses
adapter sentinel, single-flight, controller). Naming: readProfile/writeProfile
are clear; name the guard state for what it means (write completion per key),
not its mechanism. Complexity: readProfile gains one branch (<=3 total). Missing
defensive check: none beyond WR-1. Outcome: 0 issues.

### Section 6: Test Review
```
  new thing                        | type        | happy            | failure                | edge
  readProfile hit/miss/fill        | unit        | miss->fill->hit  | repository reject      | absent sentinel 10 s
  WR-1 fill suppression            | unit/harness| order (b) fills  | order (a) suppresses   | (c) absent, (d) overlapping writes
  writeProfile invalidate          | unit        | commit->delete   | reject->preserve       | (e) reject during fill
  adapter failure fallback         | unit        | bypass reads     | delete failure on write| reinit empty
  controller instance isolation    | integration | swap between stages | (f) fill during swap| predicate parity
  concurrent-miss coalescing       | unit        | one store read   | failure releases       | fresh cohort after write
```
Assertions: scenario (a) asserts R2 observes v2 exactly (not "eventually");
(c) asserts no absent sentinel survives record creation; suppressed-fill count
increments exactly once per suppressed fill. 2am test: (a). Hostile QA: (d).
Chaos: adapter failure mid-rollout stage -> bypass alert within 1 min. Pyramid:
mostly unit on the deterministic harness, one integration for controller swap,
no E2E. Flakiness: none if pause/release points are explicit; no wall-clock TTL
sleeps (use the harness clock). Load: cold start at 100% within existing DB
capacity (PLAN.md:102). Outcome: diagram produced, 0 gaps (all within approved coverage).

### Section 7: Performance Review
No N+1 or new queries. Memory: <=1000 entries / 16 MiB + WR-1 per-key state
bounded to live keys (~900). Slow paths: miss (store read, existing), hit
(sync map lookup, microseconds), write (store + delete). Hit-rate risk: 60%
depends on per-key read interval vs 30 s TTL; not provable from the plan, gated
by the 10% stage. Outcome: 1 risk noted (hit-rate assumption), 0 issues.

### Section 8: Observability & Debuggability
Existing dashboards cover hit/miss/eviction/bytes/fallback/DB CPU/p95. WR-1 adds a
suppressed-fill count on the current dashboard, no key labels (approved in D1).
Alerts exist for SLO breach, p95 >120 ms 5 min, bypass >1 min. Runbook: record
incident, rollback, resume criteria (existing). Debuggability: counts without keys
suffice to detect stale-fill pressure; correctness incidents trace via existing
API error mapping. Outcome: 0 gaps.

### Section 9: Deployment & Rollout
No migration. Flag stages 10% -> 50% -> 100%, one healthy hour each with the
stated criteria (PLAN.md). Rollback: flag off; controller drains admitted writes
and publishes a bypassing instance; seconds. Risk window: instance swap during
in-flight fills is isolated by the controller (tested, scenario f). Post-deploy:
first 5 min watch bypass and error rate; first hour the stage criteria. Smoke:
existing contract tests + wrapper tests in CI. Outcome: 0 risks beyond those
already gated.

### Section 10: Long-Term Trajectory
Debt: one small guard state to document (ASCII comment on the schedule above in
the wrapper). Path dependency: none; interface preserves a shared-cache swap.
Reversibility 5/5 (flag off, delete wrapper). Fits repo conventions (reuse
adapters). 1-year: obvious if the wrapper comment carries the t1-t7 schedule.
Outcome: debt items 1, reversibility 5/5.

### Section 11: Design & UX
SKIPPED (no UI scope) - internal backend change (PLAN.md:8-9).

## Closing sequence
Outside Voice: `codex_reviews: disabled` -> skipped, no native fallback;
outside coverage disabled. Review-log write for the disabled record not run
(mutating commands prohibited this run; fields not persisted:
status=skipped, source=none, outside_provider=codex, outside_status=disabled).
TODO choices: none remain (HOLD SCOPE; no evidenced deferrable gap).

**Approval readiness: PASS** - checked rows: WR-1 (D1 -> A, authorized
auto-decision under the run's author policy; scope applied exactly: wrapper
guard requirement, scenarios (a)-(f), dashboard count; nothing else amended).

## Required Outputs

### Review facts
Mode HOLD SCOPE; findings 1 (WR-1, resolved); unresolved 0; critical gaps 0;
scope proposals 0; outside coverage: codex disabled. Status: clean.

### NOT in scope
Deferred: none. Rejected: WR-1 option B (keep wrapper as drafted; contradicts
PLAN.md:46-48), WR-1 option C (write-through; misses hit target). Plus the
plan's own exclusions (distributed cache, cross-process coherence, prewarming,
consistency changes, new surfaces).

### What already exists
LRU adapter (limits, TTL, absent sentinel, failure bypass); single-flight in
repository.read; rollout controller + flag predicate; dashboards/alerts/runbooks;
repository contract test harness. All reused; nothing rebuilt.

### Dream state delta
After this plan: hot reads served in-process, DB CPU <50%, p95 <60 ms, with a
repository interface that still allows a shared cache later. See 0C.

### Error & Rescue Registry
See Section 2 tables: 3 rows (readProfile, writeProfile, controller swap), 0 CRITICAL GAPS.

### Failure Modes Registry
```
  CODEPATH         | FAILURE MODE              | RESCUED? | TEST? | USER SEES?         | LOGGED?
  readProfile      | adapter get failure       | Y bypass | Y     | slower read        | Y fallback metric
  readProfile      | repository reject         | Y typed  | Y     | existing error     | Y existing
  readProfile      | stale fill after write    | Y WR-1   | Y (a)(c)(d) | fresh data   | Y suppressed count
  writeProfile     | repository reject         | Y typed  | Y     | existing error     | Y existing
  writeProfile     | adapter delete failure    | Y bypass | Y     | write succeeds     | Y fallback metric
  controller swap  | fill during swap          | Y isolate| Y (f) | none               | Y stage metrics
```
6 total, 0 CRITICAL GAPS.

### Diagrams
1. System architecture: Section 1. 2. Data flow + shadow paths: Section 4.
3. State machine: Section 1 (per-key). 4. Error flow: Section 2.
5. Deployment sequence: `flag 10% -> healthy 1h -> 50% -> healthy 1h -> 100% -> acceptance targets`.
6. Rollback: `breach -> flag off -> controller drains writes -> bypass instance -> runbook incident -> resume criteria`.
Stale diagram audit: no existing ASCII diagrams in touched files are known; the
plan's t1-t7 schedule must be added as a wrapper comment (T2).

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~20min)** — wrapper — Implement readProfile/writeProfile with the WR-1 fill-staleness guard
  - Surfaced by: Step 0 / Section 4 — WR-1 stale fill after completed write (PLAN.md:46-48 vs 52-53)
  - Files: to be determined (wrapper module)
  - Verify: harness scenarios (a)-(f) pass; existing repository contract tests pass
- [ ] **T2 (P2, human: ~1h / CC: ~5min)** — wrapper — Add ASCII schedule comment (t1-t7) and suppressed-fill dashboard count, no key labels
  - Surfaced by: Section 8 / Section 10 — debuggability and 1-year clarity
  - Files: to be determined (wrapper module, dashboard definition)
  - Verify: count increments once per suppressed fill in scenario (a); dashboard panel shows it
- [ ] **T3 (P1, human: ~4h / CC: ~15min)** — tests — Deterministic pause/release tests for both completion orders, absent creation, overlapping writes, rejected write, instance swap
  - Surfaced by: Section 6 — test diagram rows for WR-1 and controller isolation
  - Files: to be determined (wrapper test suite on existing harness)
  - Verify: tests fail on the unguarded wrapper (order a) and pass with the guard
_No new tasks from Sections 3, 5, 7, 9, 11._
Task JSONL: not persisted (mutating commands prohibited this run).

### Completion Summary
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE                                  |
  | System Audit         | skipped per run instructions (fixture)      |
  | Step 0               | HOLD SCOPE; WR-1 -> A (fill-staleness guard)|
  | Section 1  (Arch)    | 1 issue found (WR-1, resolved)              |
  | Section 2  (Errors)  | 3 error paths mapped, 0 GAPS                |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 6 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 0 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 0 issues found (1 hit-rate risk gated)      |
  | Section 8  (Observ)  | 0 gaps found                                |
  | Section 9  (Deploy)  | 0 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 5/5, debt items: 1           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (2 rejected, 0 deferred)            |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 3 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 6 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex: disabled (config), no native fallback|
  | Lake Score           | 1/1 recommendations chose complete option   |
  | Diagrams produced    | 6 (arch, data flow, state, error, deploy, rollback) |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```
Unresolved Decisions: none. Review log / decision log / dashboard read: not
persisted, not run (mutating and gstack commands prohibited this run; fields:
status=clean, unresolved=0, critical_gaps=0, mode=HOLD_SCOPE). Learnings: no
durable learnings this session. Next step: /plan-eng-review (required gate);
no design review (no UI).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (not persisted) | CLEAR | mode: HOLD SCOPE, 0 critical gaps |
| Outside Review | codex (`codex_reviews: disabled`) | Independent 2nd opinion | 0 | DISABLED | disabled by config; no completed external review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** codex, plan-review phase, disabled by `codex_reviews: disabled`; no outside process, no native fallback, no findings claimed.

**VERDICT:** CEO CLEARED — WR-1 fill-staleness guard accepted into the plan; eng review required.

NO UNRESOLVED DECISIONS
