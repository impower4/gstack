/**
 * Rule-16 flaky reruns for the paid gate (CREW rule 16, Garry 2026-10-19:
 * "you can just run the failed test again and note that it is flaky... You
 * don't have to do the whole test pass again for one failed test.").
 *
 * Every executed case leaves an ordered history of observations: each run
 * attempt's first execution, then that attempt's one in-run rerun. A case is
 *   - FLAKY (green, annotated) when it failed exactly once, that failure was a
 *     case verdict (a red rule or judge case, or a behavior panel FAIL whose
 *     red class is VERDICT), and the very next observation of it passed;
 *   - RED when it failed twice, or its failure was harness, INFRA,
 *     INCOMPLETE or unattributed, or nothing has re-executed it yet.
 * A case that passed is never rerun and leaves no flake record.
 *
 * The rerun planner (evals.yml `rerun-plan`) reruns, once and in the same
 * run attempt, exactly the cases whose only failure is a case verdict that
 * nothing has re-executed yet, and only when their passing would turn the
 * gate green. On the gate lane a completed rule shard's red case no longer
 * fails its slice job (sliceExitCode caseVerdicts), so the run's conclusion
 * follows this report and a flaky green concludes success. The
 * report (runPaidReport) applies the same history to every attempt, so a
 * manual `gh run rerun --failed` attempt that passes every earlier red is
 * green with the same annotation, while a new red on any attempt stays red
 * unless its own next observation passes. Trials, kinds, thresholds and
 * panels never change: a behavior case reruns its whole planned panel, a
 * judge case its judge's samples, a rule case its one trial.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeRelativePath } from './shard-engine';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from '../../test/helpers/touchfiles';
import { isFinalizedEvalResultFile, sanitizeTrialError, type EvalCaseKind } from '../../test/helpers/eval-store';
import { shardTrial } from './paid-cases';
import { type PaidRunManifest, type SliceResult, codexSlicesOf, isCodexShard, loadPaidTestDurations, packBySliceBudget, parseRunManifest, trialPanelKey, verifySliceResults } from './paid-plan';
import { type ReportArtifact, junitCensus, loadSliceArtifacts, panelReports, sliceArtifactName } from './paid-report';
import { expectedPrCaseCount, shardSlug } from './paid-select';
import { ROOT } from './paid-types';

export const FLAKE_RECORDS_FILE = 'flake-records.jsonl';
/** Each attempt's rerun manifest lands in the report dir as `<RERUN_PLAN_ARTIFACT>-a<attempt>/manifest.json` (one level deeper when several attempts' plans download). */
export const RERUN_PLAN_ARTIFACT = 'rerun-plan';

export type Phase = 'first' | 'rerun';

export interface CaseObservation {
  case: string;
  kind: EvalCaseKind;
  attempt: number;
  phase: Phase;
  outcome: 'passed' | 'failed';
  /** A failed case verdict the one rerun may resolve; harness, INFRA, INCOMPLETE and unattributed failures never are. */
  eligible: boolean;
  /** Why a failure is not eligible. */
  reason?: string;
  /** The manifest keys that executed it: its non-trial shard, or its panel's trial shards. */
  keys: string[];
  /** Where it ran: attempt, phase and slice artifacts. */
  where: string;
  symptom?: string;
  costUsd: number;
  /** False when some execution captured no billing (PTY sessions): costUsd is then a lower bound. */
  costKnown: boolean;
}

export interface CaseResolution {
  case: string;
  kind: EvalCaseKind;
  status: 'flaky' | 'red';
  first: CaseObservation;
  /** flaky: the passing rerun; red: the second failure, when there is one. */
  next?: CaseObservation;
  reason: string;
}

export interface ObservationSet {
  attempt: number;
  phase: Phase;
  manifest: PaidRunManifest;
  artifacts: ReportArtifact[];
  /** A later attempt or a rerun that ran only some slices: panels count only when all their trials ran in it. */
  partial: boolean;
}

const phaseOrder = (phase: Phase) => (phase === 'first' ? 0 : 1);
const registered = (id: string) => Object.hasOwn(E2E_TOUCHFILES, id) || Object.hasOwn(LLM_JUDGE_TOUCHFILES, id);
function where(set: ObservationSet, slices: number[]): string {
  const names = [...new Set(slices)].sort((a, b) => a - b)
    .map(slice => sliceArtifactName(set.artifacts.find(a => a.result.sliceIndex === slice)?.root ?? '', slice, set.attempt));
  return `attempt ${set.attempt}${set.phase === 'rerun' ? ' rerun' : ''} (${names.join(', ')})`;
}

/** Collector records under each reported shard's own eval dir, keyed by shard. */
function shardRecords(artifacts: ReportArtifact[]): Map<string, any[]> {
  const records = new Map<string, any[]>();
  for (const { root, result } of artifacts) {
    for (const outcome of result.outcomes) {
      const key = normalizeRelativePath(outcome.files[0] ?? '');
      const dir = path.join(root, 'shards', shardSlug([key]));
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
        if (!isFinalizedEvalResultFile(name)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (Array.isArray(parsed.tests)) records.set(key, [...(records.get(key) ?? []), ...parsed.tests]);
        } catch { /* a malformed collector is the report's problem, not an observation */ }
      }
    }
  }
  return records;
}

type Outcome = SliceResult['outcomes'][number];

/** Why a non-trial shard's case results cannot count as a verdict observation, else null. */
export function shardProblem(manifest: PaidRunManifest, key: string, got: { outcome: Outcome; checkpoint: boolean } | undefined): string | null {
  const entry = manifest.entries.find(e => normalizeRelativePath(e.file) === key);
  if (!entry || entry.status !== 'planned') return 'not a planned shard';
  if (!got) return 'never reported';
  const o = got.outcome;
  if (got.checkpoint) return 'its slice ended before its final result';
  if (o.reused) return 'a reused result';
  if (o.runnerError !== undefined) return 'runner error';
  if (o.sliceDeadline) return `slice deadline (${o.sliceDeadline})`;
  if (o.status !== 'passed' && o.status !== 'failed') return `shard ${o.status}`;
  if (o.executedTests === null || o.skippedTests === null) return 'no test summary';
  if (manifest.prCoverage?.mode === 'pr' && o.executedTests - o.skippedTests !== expectedPrCaseCount(entry.file, manifest.selection!, entry.excludeCases)) {
    return 'executed a different case count than planned';
  }
  return null;
}

/** Every case verdict one set of slice results holds: JUnit rule and judge cases, and complete trial panels. */
export function observeCases(set: ObservationSet): CaseObservation[] {
  const { manifest, artifacts, attempt, phase } = set;
  const results = artifacts.map(a => a.result);
  const reported = new Map<string, { outcome: Outcome; checkpoint: boolean }>();
  for (const result of results) {
    for (const outcome of result.outcomes) reported.set(normalizeRelativePath(outcome.files[0] ?? ''), { outcome, checkpoint: !!result.checkpoint });
  }
  const census = junitCensus(manifest, artifacts, shardRecords(artifacts), {});
  const unattributed = new Set(census.unattributed.map(line => line.split(' :: ')[0]));
  const observations: CaseObservation[] = [];
  for (const c of census.ruleCases) {
    if (c.outcome === 'skipped') continue;
    const unsound = shardProblem(manifest, c.key, reported.get(c.key)) ?? (unattributed.has(c.key) ? 'an unattributed testcase in its shard' : null);
    if (c.outcome === 'passed' && unsound) continue;
    const reason = c.outcome !== 'failed' ? undefined : unsound ?? (c.failureClass === 'infra' ? 'INFRA failure class'
      : !registered(c.id) ? 'no registry case id (unattributed)' : undefined);
    observations.push({ case: c.id, kind: c.kind, attempt, phase, outcome: c.outcome, eligible: c.outcome === 'failed' && !reason, ...(reason ? { reason } : {}),
      keys: [c.key], where: where(set, [c.slice]),
      ...(c.outcome === 'failed' ? { symptom: sanitizeTrialError(`${c.failureClass ?? 'assertion'}${c.error ? `: ${c.error}` : ''}`) } : {}),
      costUsd: c.costUsd, costKnown: c.costKnown });
  }
  const slices = new Set(results.map(r => r.sliceIndex));
  for (const panel of panelReports(manifest, results, attempt)) {
    const entries = manifest.entries.filter(e => e.status === 'planned' && e.trial && trialPanelKey(e.file) === `${panel.file}#${panel.case}`);
    if (set.partial && !entries.every(e => slices.has(e.slice))) continue;
    if (panel.status === 'SKIPPED' || (panel.status === 'FAIL' && !panel.failsLane)) continue;
    const outcomes = entries.map(e => reported.get(normalizeRelativePath(e.file))?.outcome);
    if (phase === 'rerun' && outcomes.some(o => o?.reused)) continue;
    const passed = panel.status === 'PASS';
    const reason = passed ? undefined : panel.status === 'INCOMPLETE' ? `INCOMPLETE: ${panel.reason}`
      : panel.redClass === 'INFRA' ? 'INFRA: every failed trial is infra-class' : panel.redClass !== 'VERDICT' ? `red class ${panel.redClass}` : undefined;
    const failed = panel.trials.filter(t => t.outcome === 'failed').map(t => `t${t.trial} ${t.failure_class ?? 'assertion'}${t.error ? ` ${t.error}` : ''}`);
    observations.push({ case: panel.case, kind: panel.kind, attempt, phase, outcome: passed ? 'passed' : 'failed', eligible: !passed && !reason, ...(reason ? { reason } : {}),
      keys: entries.map(e => normalizeRelativePath(e.file)), where: where(set, Object.values(panel.slices)),
      ...(passed ? {} : { symptom: sanitizeTrialError(`${panel.status} ${panel.passed}/${panel.panel.n} (${panel.marks}): ${failed.join('; ')}`) }),
      costUsd: Math.round(outcomes.reduce((sum, o) => sum + (o?.trial?.cost_usd ?? 0), 0) * 100) / 100, costKnown: outcomes.every(o => o?.trial && o.trial.cost_known !== false) });
  }
  return observations;
}

/**
 * The observation sets of a report dir: each attempt's first execution
 * (attempt 1 complete, later attempts partial) and each attempt's rerun,
 * bound to its own rerun manifest. A rerun result that does not match its
 * manifest is set aside and named.
 */
export function observationSets(reportDir: string, manifest: PaidRunManifest, firstArtifacts: ReportArtifact[]): { sets: ObservationSet[]; ignored: string[] } {
  const reported = [...new Set(firstArtifacts.map(a => a.result.attempt ?? 1))].sort((a, b) => a - b);
  const attempts = reported.length ? reported : [1];
  const sets: ObservationSet[] = attempts.map((attempt, i) => ({ attempt, phase: 'first' as const, manifest, partial: i > 0,
    artifacts: firstArtifacts.filter(a => (a.result.attempt ?? 1) === attempt) }));
  const ignored: string[] = [];
  const reruns = loadSliceArtifacts(reportDir, { reruns: true });
  for (const attempt of [...new Set(reruns.map(a => a.result.attempt ?? 1))].sort((a, b) => a - b)) {
    let rerunManifest: PaidRunManifest;
    // download-artifact unpacks a lone pattern match into the report dir and each of several into its own directory.
    const dir = path.join(reportDir, `${RERUN_PLAN_ARTIFACT}-a${attempt}`);
    const file = [path.join(dir, 'manifest.json'), path.join(dir, path.basename(dir), 'manifest.json')].find(candidate => fs.existsSync(candidate)) ?? path.join(dir, 'manifest.json');
    try { rerunManifest = parseRunManifest(fs.readFileSync(file, 'utf8')); } catch (error) {
      ignored.push(`attempt ${attempt}: rerun results without a readable rerun manifest (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const mine = reruns.filter(a => (a.result.attempt ?? 1) === attempt);
    const bound = mine.filter(a => rerunManifest.rerun?.attempt === attempt && a.result.sliceCount === rerunManifest.sliceCount
      && a.result.tier === rerunManifest.tier && JSON.stringify(a.result.selection ?? null) === JSON.stringify(rerunManifest.selection ?? null));
    if (bound.length !== mine.length) ignored.push(`attempt ${attempt}: ${mine.length - bound.length} rerun result(s) do not match the rerun manifest`);
    sets.push({ attempt, phase: 'rerun', manifest: rerunManifest, partial: true, artifacts: bound });
  }
  return { sets, ignored };
}

/** Every observation in order: attempt, then first execution before its rerun. A rerun counts only for the cases it was planned for. */
export function caseHistory(sets: ObservationSet[]): CaseObservation[] {
  return sets.flatMap(set => observeCases(set).filter(o => set.phase === 'first' || (set.manifest.rerun?.cases ?? []).includes(o.case)))
    .map((o, index) => ({ o, index }))
    .sort((a, b) => a.o.attempt - b.o.attempt || phaseOrder(a.o.phase) - phaseOrder(b.o.phase) || a.index - b.index)
    .map(({ o }) => o);
}

/** The rule-16 status of every case that failed at least once. */
export function resolveCases(history: CaseObservation[]): Map<string, CaseResolution> {
  const resolved = new Map<string, CaseResolution>();
  const byCase = new Map<string, CaseObservation[]>();
  for (const o of history) byCase.set(o.case, [...(byCase.get(o.case) ?? []), o]);
  for (const [id, list] of byCase) {
    const fails = list.filter(o => o.outcome === 'failed');
    if (!fails.length) continue;
    const first = fails[0]!;
    const next = list[list.indexOf(first) + 1];
    if (fails.length === 1 && first.eligible && next?.outcome === 'passed') {
      resolved.set(id, { case: id, kind: first.kind, status: 'flaky', first, next, reason: `failed once in ${first.where}, passed on rerun in ${next.where}` });
      continue;
    }
    const reason = fails.length > 1 ? `failed twice (${first.where}; ${fails[1]!.where})`
      : !first.eligible ? `never rerun: ${first.reason}` : 'no rerun verdict';
    resolved.set(id, { case: id, kind: first.kind, status: 'red', first, ...(fails[1] ? { next: fails[1] } : {}), reason });
  }
  return resolved;
}

/**
 * The cases to rerun once now: their only failure is a case verdict and
 * nothing has executed them since. Usually this attempt's own reds; on a
 * `gh run rerun --failed` attempt also an earlier attempt's red that its
 * in-run rerun never reached (another problem blocked it then).
 */
export function rerunCandidates(history: CaseObservation[]): CaseObservation[] {
  return [...resolveCases(history).values()].filter(r => r.status === 'red' && !r.next && r.first.eligible
    && history.filter(o => o.case === r.case).at(-1) === r.first).map(r => r.first);
}

/** Non-trial shards whose every failed case in `observations` is flaky: their non-zero exit and failed status are explained. */
export function flakyShards(observations: CaseObservation[], flaky: ReadonlySet<string>): Set<string> {
  const failed = observations.filter(o => o.outcome === 'failed' && o.keys.length === 1 && shardTrial(o.keys[0]!) === null);
  const keys = new Set(failed.map(o => o.keys[0]!));
  return new Set([...keys].filter(key => failed.filter(o => o.keys[0] === key).every(o => flaky.has(o.case))));
}

/**
 * The rerun manifest: the candidates' own shards from the plan (a behavior
 * case's whole panel, a rule or judge case's own shard, narrowed to it in PR
 * mode; otherwise the file reruns and only the planned cases count), packed
 * with the plan's budget. It runs fresh: the rerun job
 * gets no receipts and the executor never reuses for a rerun manifest.
 */
export function buildRerunManifest(manifest: PaidRunManifest, candidates: CaseObservation[], attempt: number,
  durations: Record<string, number> = loadPaidTestDurations(ROOT, manifest.tier)): PaidRunManifest {
  const ids = [...new Set(candidates.map(c => c.case))].sort();
  const keys = [...new Set(candidates.flatMap(c => c.keys))].sort();
  const panels = new Set(candidates.filter(c => c.keys.some(key => shardTrial(key) !== null)).map(c => c.case));
  const selection = { e2e: ids.filter(id => Object.hasOwn(E2E_TOUCHFILES, id)),
    judges: ids.filter(id => !Object.hasOwn(E2E_TOUCHFILES, id) && Object.hasOwn(LLM_JUDGE_TOUCHFILES, id)) };
  const budget = manifest.plan ?? { sliceBudgetMs: 420_000, jobs: 2 };
  const packed = packBySliceBudget(keys, budget.sliceBudgetMs, budget.jobs, durations, undefined, file => isCodexShard(file, manifest.tier));
  const entries = packed.slices.flatMap((files, index) => files.map(file => {
    const source = manifest.entries.find(e => normalizeRelativePath(e.file) === file)!;
    const exclude = (source.excludeCases ?? []).filter(id => panels.has(id));
    return { file: source.file, slice: index + 1, status: 'planned' as const, estimatedMs: packed.estimates[file]!,
      ...(source.budget ? { budget: source.budget } : {}), ...(source.trial ? { trial: source.trial } : {}), ...(exclude.length ? { excludeCases: exclude } : {}) };
  })).sort((a, b) => (a.file < b.file ? -1 : 1));
  return parseRunManifest(JSON.stringify({
    version: 1, tier: manifest.tier, evalsAll: false, sliceCount: packed.slices.length,
    selectionReason: `rule-16 rerun of attempt ${attempt}: ${ids.join(', ')}`, ...(manifest.host ? { host: manifest.host } : {}),
    profile: manifest.profile ?? 'full', selection,
    ...(manifest.prCoverage ? { prCoverage: { ...manifest.prCoverage, e2e: selection.e2e, judges: selection.judges } } : {}),
    plan: { sliceBudgetMs: budget.sliceBudgetMs, jobs: budget.jobs, estimatedSliceMs: packed.estimatedSliceMs, ciTimeoutMinutes: packed.ciTimeoutMinutes,
      sliceCiTimeoutMinutes: packed.sliceCiTimeoutMinutes, codexSlices: codexSlicesOf(manifest.tier, entries) },
    rerun: { attempt, cases: ids }, entries,
  } satisfies PaidRunManifest));
}

export interface FlakeRecord {
  schema: 1;
  kind: 'gate-flake';
  case: string;
  case_kind: EvalCaseKind;
  repository: string | null;
  pr: number | null;
  head_sha: string | null;
  tested_sha: string | null;
  lane: string;
  run_id: string | null;
  first: { attempt: number; phase: Phase; where: string };
  rerun: { attempt: number; phase: Phase; where: string };
  symptom: string;
  /** Null when the rerun captured no billing (PTY sessions). */
  rerun_cost_usd: number | null;
  recorded_at: string;
}

/** One JSONL record per flaky case, read by the daily flaky-fix pass from the run's `flake-records-a<attempt>` artifact. */
export function flakeRecords(resolutions: Iterable<CaseResolution>, ctx: { lane: string; env: NodeJS.ProcessEnv; now?: Date }): FlakeRecord[] {
  const { env } = ctx;
  const pr = Number(env.GSTACK_GATE_PR);
  const sha = (value: string | undefined) => (/^[0-9a-f]{40}$/.test(value ?? '') ? value! : null);
  return [...resolutions].filter(r => r.status === 'flaky').sort((a, b) => (a.case < b.case ? -1 : 1)).map(r => ({
    schema: 1, kind: 'gate-flake', case: r.case, case_kind: r.kind, repository: env.GITHUB_REPOSITORY ?? null,
    pr: Number.isSafeInteger(pr) && pr > 0 ? pr : null, head_sha: sha(env.GSTACK_GATE_HEAD_SHA) ?? sha(env.GITHUB_SHA), tested_sha: sha(env.GITHUB_SHA),
    lane: ctx.lane, run_id: env.GITHUB_RUN_ID ?? null,
    first: { attempt: r.first.attempt, phase: r.first.phase, where: r.first.where },
    rerun: { attempt: r.next!.attempt, phase: r.next!.phase, where: r.next!.where },
    symptom: r.first.symptom ?? 'failed', rerun_cost_usd: r.next!.costKnown ? r.next!.costUsd : null, recorded_at: (ctx.now ?? new Date()).toISOString(),
  }));
}

/** The report and PR comment line of one flaky case (the run id stays in the record: the fence sanitizer redacts long digit runs). */
export function formatFlakyLine(record: FlakeRecord): string {
  return `⚑ ${record.case}  ${record.case_kind}  FLAKY: failed in ${record.first.where}, passed on its one rerun in ${record.rerun.where}; `
    + `rerun cost ${record.rerun_cost_usd === null ? 'unknown (no billing captured)' : `$${record.rerun_cost_usd.toFixed(2)}`}; first failure: ${record.symptom}`;
}

/** What re-executing once-red cases cost: every observation after a case's first failure, in-run reruns and later attempts alike. */
export function rerunSpend(history: CaseObservation[]): { executions: number; usd: number; unknown: number } {
  const firstFail = new Map<string, number>();
  history.forEach((o, index) => { if (o.outcome === 'failed' && !firstFail.has(o.case)) firstFail.set(o.case, index); });
  const after = history.filter((o, index) => firstFail.has(o.case) && index > firstFail.get(o.case)!);
  return { executions: after.length, usd: Math.round(after.reduce((sum, o) => sum + o.costUsd, 0) * 100) / 100, unknown: after.filter(o => !o.costKnown).length };
}

/** A panel whose every planned trial ran in this set (a later attempt or rerun may hold only some). */
function completePanel(set: ObservationSet, file: string, id: string): boolean {
  const slices = new Set(set.artifacts.map(a => a.result.sliceIndex));
  return set.manifest.entries.filter(e => e.status === 'planned' && e.trial && trialPanelKey(e.file) === `${file}#${id}`).every(e => slices.has(e.slice));
}

/**
 * The slice and panel problems of every first-execution set, with each flaky
 * case's own red taken out: its shard's non-zero exit and failed status and
 * its panel's FAIL. A later attempt's problems are prefixed with it, so a new
 * red there is never hidden. Collector and manual-review checks stay in the
 * report.
 */
export function gateProblems(sets: ObservationSet[], observations: CaseObservation[], flaky: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const set of sets.filter(s => s.phase === 'first')) {
    const results = set.artifacts.map(a => a.result);
    const prefix = set.partial ? `attempt ${set.attempt}: ` : '';
    const shards = flakyShards(observations.filter(o => o.attempt === set.attempt && o.phase === 'first'), flaky);
    problems.push(...verifySliceResults(set.manifest, results, { flaky: shards, partial: set.partial }).problems.map(problem => prefix + problem));
    for (const panel of panelReports(set.manifest, results, set.attempt)) {
      if (!panel.failsLane || flaky.has(panel.case) || (set.partial && !completePanel(set, panel.file, panel.case))) continue;
      problems.push(`${prefix}PANEL ${panel.case} ${panel.status}${panel.redClass === 'INFRA' ? ' (INFRA)' : ''} ${panel.passed}/${panel.panel.n} (${panel.marks}): ${panel.reason}`);
    }
  }
  return problems;
}

/** Everything a report dir proves about rule-16 reruns: the ordered history, each failed case's resolution and the flaky set. */
export function rerunState(reportDir: string, manifest: PaidRunManifest, firstArtifacts: ReportArtifact[]) {
  const { sets, ignored } = observationSets(reportDir, manifest, firstArtifacts);
  const observations = caseHistory(sets);
  const resolutions = resolveCases(observations);
  const flaky = new Set([...resolutions.values()].filter(r => r.status === 'flaky').map(r => r.case));
  return { sets, ignored, observations, resolutions, flaky };
}

/**
 * evals.yml `rerun-plan`: write this attempt's rerun manifest to
 * `<out>/manifest.json` when some case verdict failed once in this attempt
 * and those cases passing would leave the gate with no other problem. A
 * harness, INFRA, INCOMPLETE or unattributed red, a case already red twice,
 * or any other problem plans nothing: the gate keeps its red.
 */
export function planRerun(reportDir: string, attempt: number, out: string, durations?: Record<string, number>): { manifest: PaidRunManifest | null; lines: string[] } {
  const manifest = parseRunManifest(fs.readFileSync(path.join(reportDir, 'manifest.json'), 'utf8'));
  const state = rerunState(reportDir, manifest, loadSliceArtifacts(reportDir));
  const candidates = rerunCandidates(state.observations);
  const reds = [...state.resolutions.values()].filter(r => r.status === 'red' && !candidates.includes(r.first));
  const lines = [...state.ignored.map(line => `ignored: ${line}`), ...reds.map(r => `not rerun: ${r.case} (${r.reason})`)];
  if (!candidates.length) return { manifest: null, lines: [`no rule-16 rerun: no case verdict failed once with no rerun yet`, ...lines] };
  const remaining = gateProblems(state.sets, state.observations, new Set([...state.flaky, ...candidates.map(c => c.case)]));
  if (remaining.length) {
    return { manifest: null, lines: [`no rule-16 rerun: rerunning ${candidates.map(c => c.case).join(', ')} cannot turn this gate green; ${remaining.length} other problem(s), first: ${remaining[0]}`, ...lines] };
  }
  let rerun: PaidRunManifest;
  try { rerun = buildRerunManifest(manifest, candidates, attempt, durations); } catch (error) {
    return { manifest: null, lines: [`no rule-16 rerun: the rerun manifest is invalid (${error instanceof Error ? error.message : String(error)})`, ...lines] };
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(rerun, null, 2)}\n`);
  return { manifest: rerun, lines: [
    `rule-16 rerun of attempt ${attempt}: ${candidates.length} case(s) once, on ${rerun.sliceCount} slice(s), same head, fresh (no reuse)`,
    ...candidates.map(c => `  ${c.case}  ${c.kind}  failed in ${c.where}: ${c.symptom ?? 'failed'}; reruns ${c.keys.join(' ')}`), ...lines] };
}
