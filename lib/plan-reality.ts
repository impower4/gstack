/**
 * plan-reality — the reality rows every plan review must carry (multi-agent
 * wave D1, release promise P5). One table owns the rows: the resolver
 * scripts/resolvers/plan-reality.ts renders them into the plan-review
 * templates, bin/gstack-plan-reality prints them at run time and checks a
 * review for them, and the tests pin the row ids and the line grammar.
 *
 * A review emits one grep-able line per row:
 *
 *   REALITY: <row-id> <pass|finding|n/a> <summary carrying a receipt>
 *
 * A receipt is `path:line`, `path:line-line` or a commit sha; a row without one
 * is not a row. Tier 1 rows are required in every review. Tier 2 rows are
 * required only when the review's detected scope (the manifest `scope` field
 * from plan B4, passed to the checker as `--scope`) names theirs; otherwise
 * they may be omitted or marked `n/a`. A tier 1 row marked `n/a` is missing.
 *
 * `checkRealityRows` is deterministic and returns the missing rows; the
 * session kind decides what a miss means (unattended: the phase is
 * `incomplete`; interactive: repair twice, then warn at the gate). The row
 * table carries each row's incident, so the deep section can say why the row
 * exists without a second table drifting.
 */

export const REALITY_SCOPES = ['always', 'db', 'perf', 'search', 'incident', 'dependency'] as const;
export type RealityScope = typeof REALITY_SCOPES[number];
export const REALITY_STATUSES = ['pass', 'finding', 'n/a'] as const;
export type RealityStatus = typeof REALITY_STATUSES[number];

export interface RealityRow {
  id: string;
  title: string;
  tier: 1 | 2;
  /** `always` for tier 1; the scope signal a tier 2 row needs. */
  scope: RealityScope;
  /** The operative check, one line, imperative. */
  check: string;
  /** The incident in the gbrain feedback that earned the row, one line. */
  incident: string;
  /** Optional `key=value` the line must carry (scored in the Completion Summary). */
  metric?: string;
}

export const REALITY_ROWS: readonly RealityRow[] = [
  {
    id: 'premise-table', title: 'Premise table', tier: 1, scope: 'always',
    check: '`premise | claim | file:line receipt | verdict` for every factual claim; no receipt means `unverified`, and `unverified=<n>` is scored in the Completion Summary.',
    incident: 'A wave rested on "13 of 28 threads ran nothing" with no per-thread evidence; the first table found 1 FALSE and 3 UNVERIFIED claims in 27.',
    metric: 'unverified',
  },
  {
    id: 'already-done', title: 'Already done', tier: 1, scope: 'always',
    check: '`git fetch origin <base>`, then `git log origin/<base> --since=<ask date> -- <named files>` and `--grep <symbols>`; report a hit before any task is written.',
    incident: 'A fix was re-planned and rebuilt the day after main merged it; nobody read the base log.',
  },
  {
    id: 'surface-check', title: 'Surface check', tier: 1, scope: 'always',
    check: 'Every named CLI command, flag or HTTP route verified against the registry or `--help`; a miss is a finding.',
    incident: 'The installer relied on `bun upgrade --version`; `bun upgrade --help` on the target listed only `--canary`.',
  },
  {
    id: 'binding-decisions', title: 'Binding decisions', tier: 1, scope: 'always',
    check: 'Read `gstack-decision-search --scope branch --recent 50` and the plan\'s `## Binding decisions`; they outrank project defaults and CLAUDE.md, and a reintroduced overruled default is a finding.',
    incident: 'An owner decision taken mid-review was undone two phases later by the project default it had replaced.',
  },
  {
    id: 'numbers', title: 'Numbers', tier: 1, scope: 'always',
    check: 'Every number re-derived from raw data and tagged `[measured: <source>]` or `[estimated]`; a cited baseline is `[re-measure before gate]`.',
    incident: 'An effort table with no basis was credited until a reviewer re-counted it; quoted parity ratios were off by two decimals.',
  },
  {
    id: 'deferred-asks', title: 'Deferred asks', tier: 1, scope: 'always',
    check: 'The linked issue\'s requests the plan leaves out, each with its reason, listed in the gate template.',
    incident: 'An issue asked for six things; the plan shipped four and the owner found the other two after merge.',
  },
  {
    id: 'pr-count', title: 'PR count', tier: 1, scope: 'always',
    check: '`pr_count` from `.gstack/ship-policy.json` (default one PR per wave); a split shows the queue cost per extra PR and checks user-facing references across it.',
    incident: 'A five-PR wave became seven in the Eng phase; the cost of each extra gate had never been stated.',
  },
  {
    id: 'prior-art', title: 'Prior art', tier: 2, scope: 'dependency',
    check: 'For a vendored or patched dependency or a known library behavior: search the upstream tracker and open PRs; record `adopt <link>` or `diverge because <reason>`.',
    incident: 'A patched vendored hunk was dropped on upgrade because nobody had recorded why the fork diverged.',
  },
  {
    id: 'transaction-semantics', title: 'Transaction semantics', tier: 2, scope: 'db',
    check: 'For a driver, pool or protocol change: the surrounding transaction on idle, pooled and reserved connections; crash robot rerun after the change.',
    incident: 'A pool change ended transactions on idle connections; the crash robot was not rerun.',
  },
  {
    id: 'contract-assumptions', title: 'Contract assumptions', tier: 2, scope: 'dependency',
    check: 'One row per default or flag assumed from another repo, rechecked against merged code before the next stage.',
    incident: 'A sibling repo\'s default changed between planning and build; the plan still assumed the old flag.',
  },
  {
    id: 'falsification-box', title: 'Falsification box', tier: 2, scope: 'incident',
    check: 'Top hypothesis, the evidence that kills it, a time box, and the action in each branch.',
    incident: 'An outage plan chased its first hypothesis for a day with nothing stated that would have killed it.',
  },
  {
    id: 'stop-reasons', title: 'Stop reasons', tier: 2, scope: 'incident',
    check: 'Every new stop reason, hold code and progress line names the test that triggers it.',
    incident: 'A hold code shipped with no test that could produce it; it first fired in production.',
  },
  {
    id: 'reporter-environment', title: 'Reporter environment', tier: 2, scope: 'incident',
    check: 'A repro that does not match the reporter\'s environment is `class not confirmed`, never `ruled out`.',
    incident: 'A bug was "ruled out" on a different runtime than the reporter\'s; the reporter still had it.',
  },
  {
    id: 'units', title: 'Units', tier: 2, scope: 'perf',
    check: 'A change to an input\'s units or accuracy lists every threshold that consumes it and shows the re-tune.',
    incident: 'A timing input moved from ms to s; three downstream thresholds kept their numbers.',
  },
  {
    id: 'perf-table', title: 'Perf table', tier: 2, scope: 'perf',
    check: 'Machine, engine, data size, N, p50/p95, statistics state, base and branch interleaved, pathological and steady-state cases, `reproduced on main?`.',
    incident: 'A speedup came from one warm-cache run with no base comparison; main was as fast.',
  },
  {
    id: 'recall', title: 'Recall', tier: 2, scope: 'search',
    check: 'A search or query-plan change reports recall against exact search across scope buckets.',
    incident: 'A query-plan change sped up the hot path and dropped recall on the smallest bucket.',
  },
  {
    id: 'dependency-fallback', title: 'Dependency fallback', tier: 2, scope: 'dependency',
    check: 'What ships without each predecessor, and by when.',
    incident: 'A stacked PR waited on a predecessor that never merged; nothing said what it could ship alone.',
  },
  {
    id: 'obligation-tiers', title: 'Obligation tiers', tier: 2, scope: 'dependency',
    check: 'Must-ship, next PR, deferred, under a stated size budget; the ledger status column carries the tier.',
    incident: 'A PR outgrew review because every accepted finding was treated as must-ship.',
  },
];

export const TIER1_ROW_IDS: readonly string[] = REALITY_ROWS.filter(r => r.tier === 1).map(r => r.id);

export function rowById(id: string): RealityRow | undefined {
  return REALITY_ROWS.find(r => r.id === id);
}

/** Rows a review must carry for the given scopes: tier 1 always, tier 2 when its scope is detected. */
export function requiredRows(scopes: readonly string[]): RealityRow[] {
  return REALITY_ROWS.filter(r => r.tier === 1 || scopes.includes(r.scope));
}

export function parseScopes(csv: string | undefined): { scopes: RealityScope[]; unknown: string[] } {
  const scopes: RealityScope[] = [];
  const unknown: string[] = [];
  for (const raw of (csv ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    if ((REALITY_SCOPES as readonly string[]).includes(raw)) scopes.push(raw as RealityScope);
    else unknown.push(raw);
  }
  return { scopes, unknown };
}

/** `path:line` or `path:line-line` (the path has a letter, may start with a dot, no spaces), or a 7–40 hex sha with a hex letter, or digits-only after `commit ` or in backticks. */
export const RECEIPT_RE = /(?:(?<![\w./-])\.?[A-Za-z~$][\w./~$@-]*:\d+(?:-\d+)?)|(?<![0-9a-f])(?=[0-9]*[a-f])[0-9a-f]{7,40}(?![0-9a-f])|\bcommit [0-9]{7,40}\b|`[0-9]{7,40}`/;
export const REALITY_LINE_RE = /^\s*(?:[-*>|]\s*)?`?REALITY:\s+(?<id>[a-z][a-z0-9-]*)\s+(?<status>pass|finding|n\/a)\b(?<rest>.*)$/;

export interface RealityLine { id: string; status: RealityStatus; rest: string; receipt: string | null; line: number; metrics: Record<string, string> }

export function parseRealityLines(text: string): RealityLine[] {
  const out: RealityLine[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = REALITY_LINE_RE.exec(raw);
    if (!m?.groups) return;
    const rest = m.groups.rest!.replace(/`\s*$/, '').trim();
    const receipt = RECEIPT_RE.exec(rest)?.[0] ?? null;
    const metrics: Record<string, string> = {};
    for (const kv of rest.matchAll(/\b([a-z_]+)=([^\s,;|]+)/g)) metrics[kv[1]!] = kv[2]!;
    out.push({ id: m.groups.id!, status: m.groups.status as RealityStatus, rest, receipt, line: i + 1, metrics });
  });
  return out;
}

export type RealityVerdict = 'complete' | 'incomplete' | 'repair';
export interface RealityCheck {
  phase: string;
  required: string[];
  present: string[];
  /** Required rows with no line, or a tier 1 row marked n/a. */
  missing: string[];
  /** Required rows whose line carries no receipt. */
  unreceipted: string[];
  /** Clauses stating a measured number without a receipt of their own. */
  unreceipted_numbers: string[];
  /** Lines claiming a decision rule exists without quoting or linking its text. */
  unquoted: string[];
  /** One `NUMBER_UNRECEIPTED: <clause>` line per unreceipted number. */
  numberLines: string[];
  /** Lines naming a row id the table does not define. */
  unknownRows: string[];
  metrics: Record<string, string>;
  verdict: RealityVerdict;
  line: string;
}

/**
 * A measured quantity: a number with a unit (s, ms, %, $, USD, tokens, ×, MB, GB) or a number shortly after
 * measured/costs/takes/took. Receipts, versions and ids are removed before matching, so they never count.
 */
const MEASURED_RE = /\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s?[kKM]?\s?(?:ms|s|%|USD|tokens?|MB|GB)(?![\w])|\b\d[\d,]*(?:\.\d+)?\s?[×x](?![\w])|\b(?:measured|costs?|takes|take|took)\b\W+(?:[A-Za-z]+\W+){0,3}?\$?\d/i;
const ITEM_REF_RE = /\b(?:items?|sections?)\s+\d+(?:\s*[–-]\s*\d+)?(?:\s*(?:,|and)\s*\d+(?:\s*[–-]\s*\d+)?)*|§\s?\d+(?:\.\d+)*/;
const NOT_A_QUANTITY_RE = new RegExp(`${RECEIPT_RE.source}|${ITEM_REF_RE.source}|\\bv?\\d+(?:\\.\\d+){2,}\\b|#\\d+|\\b[A-Za-z]+\\d+[a-z]?\\b`, 'g');
const EXEMPT_TAG_RE = /\[(?:estimated|re-measure before gate)\]/i;
const SCRIPT_RE = /(?:^|[\s(`"'])(?:\.?[\w-]+\/)*[\w.-]+\.(?:ts|js|mjs|cjs|sh|py|rb|go)\b|(?:^|[\s(`"'])(?:bin|scripts)\/[\w.-]+/;
const COMMAND_RE = /`(?!\s*\$?\d)[^`]*\s[^`]*`/;
const RULE_CLAIM_RE = /\b(?:decision rule|rules? (?:was |were )?written first|pre-?registered rule)\b/i;
const QUOTED_RULE_RE = /"[^"]{8,}"|\u201c[^\u201d]{8,}\u201d/;
const LINK_RE = /(?<![\w./-])\.?[A-Za-z~$][\w./~$@-]*:\d+/;

/** Split on `;`, `, ` and sentence ends, never inside brackets, parentheses or backticks. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0, tick = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '`') tick = !tick;
    else if (!tick && '([{'.includes(c)) depth++;
    else if (!tick && ')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (!tick && depth === 0 && (c === ';' || ((c === ',' || c === '.') && /\s/.test(text[i + 1] ?? '')))) {
      out.push(text.slice(start, c === '.' ? i + 1 : i)); start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map(c => c.trim()).filter(Boolean);
}

const QUOTED_SPAN_RE = /"([^"]+)"|\u201c([^\u201d]+)\u201d/g;
const BACKTICK_SPAN_RE = /`[^`]*`/g;

/**
 * Clauses of one line that state a measured number and carry no receipt of their own. With `quotedFrom` (the
 * reviewed plan, reviewer scope only), a span quoted verbatim from it is the plan's number, not the reviewer's claim.
 */
export function unreceiptedNumbers(line: string, quotedFrom?: string): string[] {
  const text = quotedFrom ? line.replace(QUOTED_SPAN_RE, (span, a, b) => (quotedFrom.includes((a ?? b) as string) ? '""' : span)) : line;
  return splitClauses(text).filter(c => MEASURED_RE.test(c.replace(NOT_A_QUANTITY_RE, ' '))
    && !RECEIPT_RE.test(c) && !SCRIPT_RE.test(c) && !COMMAND_RE.test(c) && !EXEMPT_TAG_RE.test(c));
}

/** A rule claim needs the rule: a quoted span, a file:line link on the line, or a fenced or quoted block right after it. Plan scope ignores phrases inside backticks (a phrase named, not claimed). */
function ruleUnquoted(lines: string[], i: number, scope: 'plan' | 'review' = 'review'): boolean {
  const line = lines[i]!;
  if (!RULE_CLAIM_RE.test(scope === 'plan' ? line.replace(BACKTICK_SPAN_RE, ' ') : line) || QUOTED_RULE_RE.test(line) || LINK_RE.test(line)) return false;
  const after = lines.slice(i + 1).find(l => l.trim());
  return !after || !/^\s*(?:```|~~~|>)/.test(after);
}

const verdictFor = (ok: boolean, sessionKind?: string): RealityVerdict => (ok ? 'complete' : sessionKind === 'unattended' ? 'incomplete' : 'repair');

export interface CheckOptions { phase: string; scopes?: readonly string[]; sessionKind?: string;
  /** The reviewed plan snapshot: a number inside a span quoted verbatim from it needs no receipt of its own. */
  planText?: string }

/** Deterministic: which required rows the review carries. The verdict word depends on the session kind only. */
export function checkRealityRows(reviewText: string, o: CheckOptions): RealityCheck {
  const required = requiredRows(o.scopes ?? []).map(r => r.id);
  const lines = parseRealityLines(reviewText);
  const byId = new Map<string, RealityLine>();
  const unknownRows: string[] = [];
  for (const l of lines) {
    if (!rowById(l.id)) { if (!unknownRows.includes(l.id)) unknownRows.push(l.id); continue; }
    if (!byId.has(l.id) || (byId.get(l.id)!.status === 'n/a' && l.status !== 'n/a')) byId.set(l.id, l);
  }
  const present: string[] = [], missing: string[] = [], unreceipted: string[] = [];
  const metrics: Record<string, string> = {};
  for (const id of required) {
    const l = byId.get(id);
    if (!l || l.status === 'n/a') { missing.push(id); continue; }
    if (!l.receipt) { unreceipted.push(id); continue; }
    present.push(id);
    const metric = rowById(id)!.metric;
    if (metric && l.metrics[metric] !== undefined) metrics[metric] = l.metrics[metric]!;
  }
  const rows = lines.filter(l => rowById(l.id) && l.status !== 'n/a');
  const numbers = rows.flatMap(l => unreceiptedNumbers(l.rest, o.planText));
  const rawLines = reviewText.split('\n');
  const unquoted = rows.filter(l => ruleUnquoted(rawLines, l.line - 1)).map(l => rawLines[l.line - 1]!.trim());
  const verdict = verdictFor(missing.length === 0 && unreceipted.length === 0 && numbers.length === 0 && unquoted.length === 0, o.sessionKind);
  const parts = [`PLAN_REALITY: phase=${o.phase}`, `rows=${present.length}/${required.length}`,
    `missing=${missing.length ? missing.join(',') : 'none'}`];
  if (unreceipted.length) parts.push(`unreceipted=${unreceipted.join(',')}`);
  if (numbers.length) parts.push(`unreceipted_numbers=${numbers.length}`);
  if (unquoted.length) parts.push(`unquoted=${unquoted.length}`);
  for (const [k, v] of Object.entries(metrics)) parts.push(`${k}=${v}`);
  parts.push(`verdict=${verdict}`);
  return { phase: o.phase, required, present, missing, unreceipted, unreceipted_numbers: numbers, unquoted,
    numberLines: numbers.map(c => `NUMBER_UNRECEIPTED: ${c}`), unknownRows, metrics, verdict, line: parts.join(' ') };
}

/** Bumped whenever checkPlanReality's rules change, so a cached verdict keyed on the plan hash is recomputed. */
export const PLAN_REALITY_CHECKER = 'plan-reality/3';
export interface PlanRealityCheck { checker: string; unreceipted_numbers: string[]; unquoted: string[]; numberLines: string[]; verdict: RealityVerdict; line: string }

/**
 * The same number and rule checks over plan prose (the Implementation plan the caller passes), outside fenced blocks.
 * Pure: reads nothing, writes nothing. `gstack-autoplan submit` records it per plan hash; it never refuses a submit.
 */
export function checkPlanReality(planText: string, o: { sessionKind?: string } = {}): PlanRealityCheck {
  const lines = planText.split('\n');
  const numbers: string[] = [], unquoted: string[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter && (!fence || delimiter.startsWith(fence))) { fence = fence ? null : delimiter; return; }
    if (fence || /^\s*<!--/.test(line)) return;
    numbers.push(...unreceiptedNumbers(line));
    if (ruleUnquoted(lines, i, 'plan')) unquoted.push(line.trim());
  });
  const verdict = verdictFor(numbers.length === 0 && unquoted.length === 0, o.sessionKind);
  return { checker: PLAN_REALITY_CHECKER, unreceipted_numbers: numbers, unquoted, numberLines: numbers.map(c => `NUMBER_UNRECEIPTED: ${c}`), verdict,
    line: `PLAN_REALITY: scope=plan unreceipted_numbers=${numbers.length} unquoted=${unquoted.length} verdict=${verdict}` };
}

const VAGUE_RE = /\b(minimum (?:detectable )?effect|margins?|decision rule|dollar cost|cost in dollars|USD cost)\b/i;
const DETAIL_AFTER_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|\||```|~~~|>)/;

/**
 * PLAN_REALITY flags for the gate (advisory, never blocking): a plan line naming a minimum effect, a margin, a
 * decision rule or a dollar cost with no number on it (item references and phrases in backticks do not count)
 * and no arm list, table, quoted rule or block right after it. `line` is 1-based in `planText`.
 */
export function vaguePlanTerms(planText: string): Array<{ phrase: string; line: number; text: string }> {
  const lines = planText.split('\n');
  const out: Array<{ phrase: string; line: number; text: string }> = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (delimiter && (!fence || delimiter.startsWith(fence))) { fence = fence ? null : delimiter; return; }
    if (fence || /^\s*<!--/.test(raw)) return;
    const prose = raw.replace(BACKTICK_SPAN_RE, ' ');
    const m = VAGUE_RE.exec(prose);
    if (!m) return;
    if (/\d/.test(prose.replace(NOT_A_QUANTITY_RE, ' ')) || QUOTED_RULE_RE.test(prose)) return;
    const after = lines.slice(i + 1).find(l => l.trim());
    if (after && DETAIL_AFTER_RE.test(after)) return;
    out.push({ phrase: m[1]!.toLowerCase(), line: i + 1, text: raw.trim() });
  });
  return out;
}

/** The example line every template quotes; one grammar, stated once. */
export const REALITY_LINE_SHAPE = 'REALITY: <row> pass|finding|n/a <summary> <file:line>';

/** The operative rows as the bin prints them (`deep` adds each row's incident). */
export function renderRows(rows: readonly RealityRow[], o: { deep: boolean }): string {
  return rows.map(r => `- ${r.id} (tier ${r.tier}${r.scope === 'always' ? '' : `, scope ${r.scope}`}): ${r.check}${o.deep ? `\n  Incident: ${r.incident}` : ''}`).join('\n');
}

/** The deep-section table: why each row exists. The check itself is what `rows` prints. */
export function renderIncidentTable(rows: readonly RealityRow[]): string {
  const head = '| Row | Tier | Scope | Incident that earned it |\n|---|---|---|---|';
  return [head, ...rows.map(r => `| \`${r.id}\` | ${r.tier} | ${r.scope} | ${r.incident.replace(/\|/g, '\\|')} |`)].join('\n');
}
