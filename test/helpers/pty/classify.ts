/**
 * Frame classifiers: prose AUQ, scope gate, numbered options, classifyVisible, counting frames. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import { isCurrentPlanApprovalScreen } from '../plan-count-pending-exit';
import { isCroppedEditPermissionVisible } from '../plan-count-file-permission';
import { currentFilePermissionTarget } from '../plan-skill-questions';
import { parseQuestionPrompt } from './auq';
import { TAIL_SCAN_BYTES, isAutoDecidedVisible, isNativeEditPermissionVisible, isNumberedOptionListVisible, isPermissionDialogVisible, isPlanReadyVisible, stripPtyResidue } from './screen';

/**
 * Detect a prose-rendered AskUserQuestion in plan mode.
 *
 * Plan-mode AUQs sometimes render as visible model output rather than via
 * the native numbered-prompt UI — e.g., when --disallowedTools AskUserQuestion
 * is set and no MCP variant is callable, the model surfaces the question as
 * lettered or numbered options in plain text. isNumberedOptionListVisible
 * doesn't catch these because the `❯` cursor sits on the empty input prompt,
 * not on option 1.
 *
 * Detection patterns:
 *   - 2+ distinct lettered options (A) B) C) D)) at line starts — typical
 *     for plan-eng / plan-design / plan-devex prose AUQ
 *   - 3+ distinct numbered options (1. 2. 3.) at line starts WITHOUT a
 *     `❯<spaces>1.` cursor — typical for autoplan / office-hours prose AUQ
 *   - 3+ markdown bold-bullet options (`- **label**`) following an
 *     interrogative line — office-hours renders its mode question this way
 *     (`> - **Building a startup**`), which has no letter/number marker
 *   - Pattern 4/5 (collapsed-form): a reply-instruction OR recommendation
 *     marker PLUS 2+ distinct A-D letter markers each punctuated by ) : or (
 *     anywhere in the tail. stripAnsi destroys the newlines + inter-word
 *     spaces that the line-anchored patterns above need, so a real prose AUQ
 *     arrives collapsed ("ReplywithA,B,orC", "A(recommended)", "-B:") and is
 *     invisible to Patterns 1-3. This is the dominant Shape-B render mode in
 *     the plan-design smoke + floor timeouts (verified against real run bytes).
 *
 * Used by classifyVisible and runPlanSkillFloorCheck to return outcome='asked'
 * (or auq_observed) instead of letting the harness time out when the model
 * is correctly surfacing the question and waiting for user input via prose.
 *
 * The 4KB tail window avoids matching stale options from earlier prompts in
 * scrollback. Permission dialogs are filtered out by the caller (see
 * isPermissionDialogVisible callers in classifyVisible).
 */
export function isProseAUQVisible(visible: string): boolean {
  const tail = visible.length > 4096 ? visible.slice(-4096) : visible;

  // Pattern 1: 2+ distinct lettered options at line starts. Allow leading
  // whitespace or `❯` cursor before the marker. PTY may collapse multiple
  // option lines onto one logical line via stripped cursor-positioning
  // escapes, but the NEWLINE before each option survives.
  const letteredRe = /(?:^|\n)[ \t❯]*([A-D])\)/g;
  const letteredHits = new Set<string>();
  let lm: RegExpExecArray | null;
  while ((lm = letteredRe.exec(tail)) !== null) {
    if (lm[1]) letteredHits.add(lm[1]);
  }
  if (letteredHits.size >= 2) return true;

  // Pattern 2: 2+ distinct numbered options at line starts, AND no
  // `❯<spaces>1.` cursor IN THE RECENT TAIL (not the full buffer — a
  // trust-dialog `❯ 1. Yes` at boot is in scrollback forever and
  // would otherwise suppress this path for the rest of the run).
  // The native-UI deferral only applies when the cursor list is
  // currently rendered, not historically.
  //
  // Threshold 2 (matching the lettered branch): the tail is a 4KB window,
  // and by the time the polling loop sees it, the model may have emitted
  // option 1 several KB earlier and only 2/3/4 remain in tail. False
  // positives on prose ("First, x. Second, y.") are extremely rare given
  // the line-start anchor + the no-cursor gate.
  if (/❯\s*1\./.test(tail)) return false;
  const numberedRe = /(?:^|\n)[ \t❯]*([1-9])\./g;
  const numberedHits = new Set<string>();
  let nm: RegExpExecArray | null;
  while ((nm = numberedRe.exec(tail)) !== null) {
    if (nm[1]) numberedHits.add(nm[1]);
  }
  if (numberedHits.size >= 2) return true;

  // Pattern 3: markdown bold-bullet option list. office-hours renders its
  // mode question as `> - **Building a startup**` lines under
  // --disallowedTools — no letter/number marker, so Patterns 1-2 miss it,
  // and the model keeps a spinner up so the Haiku judge scores it 'working'
  // and the run times out despite the question being on screen.
  // Require both: an interrogative line (the question stem ends in '?') AND
  // 3+ bold-bullet markers. The bold (`- **`) requirement is what separates
  // an option list from incidental prose bullets; the line anchor is dropped
  // because stripAnsi can collapse option lines (see Pattern 1 note), so we
  // count markers anywhere in the tail. The `❯ 1.` cursor gate above already
  // excludes a live native list.
  if (/\?/.test(tail)) {
    const boldBulletHits = (tail.match(/[-*•]\s+\*\*/g) || []).length;
    if (boldBulletHits >= 3) return true;
  }

  // Pattern 4/5: collapsed-form prose AUQ. stripAnsi removes the
  // cursor-positioning escapes that render option newlines + inter-word
  // spaces, so "Reply with A, B, or C" arrives as "ReplywithA,B,orC" and
  // "A) ..." as "A(recommended)" / "-B:" — defeating every line-anchored or
  // ')'-anchored pattern above (Patterns 1-3 all return false on the real
  // plan-design smoke + floor timeout bytes). Detect via two INDEPENDENT
  // signals that must BOTH hold — the corroboration is what separates a real
  // AUQ from incidental report prose that happens to mention a recommendation:
  //   (1) a reply-instruction matched space-insensitively OR a recommendation
  //       marker, AND
  //   (2) 2+ distinct A-D letter markers each punctuated by ) : or ( anywhere
  //       in the tail.
  // A single 'B)' + the word "recommendation", or a comma-only collapsed
  // "ReplywithA,B,orC" with no )/:/( punctuation on the letters, both stay
  // false — the two-signal contract is pinned by unit tests.
  const replyOrRec =
    /reply\s*(?:with)?\s*[A-D]/i.test(tail) ||
    /reply(?:with)?[A-D]/i.test(tail.replace(/\s+/g, '')) ||
    /\bRecommendation\s*:/i.test(tail) ||
    /\(recommended\)/i.test(tail);
  if (replyOrRec) {
    const collapsedLetterRe = /\b([A-D])[):(]/g;
    const collapsedHits = new Set<string>();
    let cm: RegExpExecArray | null;
    while ((cm = collapsedLetterRe.exec(tail)) !== null) {
      if (cm[1]) collapsedHits.add(cm[1]);
    }
    if (collapsedHits.size >= 2) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Scope-gate render detectors (plan-eng-review / plan-design-review)
// ---------------------------------------------------------------------------
//
// Both anchor on the RENDER SHAPE, not bare keywords, so model narration
// about the gate ("normally I'd ask what should I review…") stays false.
// Matching is whitespace-squished + lowercased because stripAnsi collapses
// TTY cursor-positioning escapes unpredictably (the same failure mode the
// Pattern-4/5 collapsed-form handling above exists for).

/**
 * True when the scope-gate QUESTION is actually rendered: the question text
 * plus option A's body text. Option-body anchoring (not `A)`/`B)` markers)
 * because native AskUserQuestion renders NUMBERED options in the TTY while
 * the --disallowedTools prose fallback renders lettered ones — the option
 * body appears in both renders; narration rarely quotes both the question
 * and an option body.
 */
export function isScopeGateQuestionVisible(visible: string): boolean {
  const squished = visible.replace(/\s+/g, '').toLowerCase();
  return /whatshouldi(?:design-?)?review/.test(squished) && squished.includes('currentbranchdiff');
}

/**
 * True when the plan-mode auto-select announcement is rendered:
 * "Scope gate: plan mode — auto-selected B (reviewing <target>)."
 * Requires BOTH the announcement prefix and an auto-select-B token so
 * narration ("in plan mode I'd auto-select B") stays false. The token is
 * tense-tolerant (selected/selecting/selects) because the smokes assert
 * must-be-TRUE on it — a semantically-perfect paraphrase must not fail a
 * paid run — while the prefix stays exact so paraphrase narration without
 * the announcement frame stays false. A prefix immediately preceded by a
 * quote character is a QUOTATION (e.g. the model explaining why it is NOT
 * announcing), not a render — the announcement line itself never renders
 * quoted.
 */
export function isScopeGateAutoSelectVisible(visible: string): boolean {
  const squished = visible.replace(/\s+/g, '').toLowerCase();
  const QUOTES = ['"', "'", '`', '“', '‘'];
  const re = /scopegate:planmode/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(squished)) !== null) {
    const before = m.index > 0 ? squished[m.index - 1]! : '';
    if (QUOTES.includes(before)) continue; // quoted occurrence — narration, keep scanning
    if (/auto-?select(?:ed|ing|s)?b/.test(squished.slice(m.index))) return true;
  }
  return false;
}

/**
 * Parse a rendered numbered-option list out of the visible TTY text.
 *
 * Looks for lines like `❯ 1. label` (cursor) or `  2. label` (no cursor)
 * and returns them in order. Used by tests that need to ROUTE on a specific
 * option label (e.g. answer "HOLD SCOPE" by sending its index + Enter)
 * without hard-coding positional indexes that drift when option order
 * changes between skill versions.
 *
 * Reads only the LAST 4KB of visible to avoid matching stale option lists
 * from earlier prompts in the session.
 *
 * Returns [] when no list is rendered. Otherwise returns indices in the
 * order they appear (1-based, matching what the user types). Labels are
 * trimmed but otherwise verbatim from the TTY (may include trailing
 * `(recommended)` markers, etc).
 */
export function parseNumberedOptions(
  visible: string,
): Array<{ index: number; label: string }> {
  visible = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const tail = visible.length > 4096 ? visible.slice(-4096) : visible;
  // Split on lines, look for `❯ N.` or `  N.` patterns. Up to N=9.
  // The `\s*` after `.` (not `\s+`) is required because stripAnsi removes
  // TTY cursor-positioning escapes that render as spaces, so a label that
  // visually reads "1. Option" can come through as "1.Option".
  const optionRe = /^[\s❯]*([1-9])\.\s*(\S.*?)\s*$/;
  // We anchor on the LATEST `❯ 1.` line in the buffer — the cursor marker
  // for the active AskUserQuestion. Older numbered lists (e.g., a granted permission
  // dialog still in scrollback) sit above it and must be ignored. Without
  // this, parseNumberedOptions returns stale options after the dialog is
  // dismissed.
  const lines = tail.split('\n');
  // Anchor on the LAST line containing `❯<spaces>1.` ANYWHERE on the line.
  // The /plan-*-review skill's box-layout AUQ uses TTY cursor-positioning
  // escapes that stripAnsi removes — leaving the cursor `❯1.` mid-line,
  // after dividers + header + prompt text on the same logical line. The
  // earlier `^\s*❯` anchor missed those entirely.
  let cursorLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/❯\s*1\./.test(lines[i] ?? '')) {
      cursorLineIdx = i;
      break;
    }
  }
  // Fallback: if cursor isn't on option 1 (user pressed Down), find the
  // last `1.` line. Allow leading `  ` or `❯ ` prefixes; do NOT include `❯`
  // in the leading character class because greedy matching would eat the
  // sigil and prevent the literal-cursor anchor above from finding it.
  // Cursor-positioning residue can omit the space in the cursor's slot
  // (`❯1.`) while peer rows still retain their ordinary two-space prefix.
  const numberColumn = (row: RegExpExecArray) => row[0].replace(/❯(?=[1-9]\.)/, '❯ ').length - 2;
  if (cursorLineIdx < 0) {
    const selectedRow = lines.map(line => /^[ \t]*❯[ \t]*[1-9]\./.exec(line)).findLast(Boolean);
    const selectedColumn = selectedRow ? numberColumn(selectedRow) : null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const firstRow = /^(?:\s*|\s*❯\s+)1\./.exec(lines[i] ?? '');
      if (firstRow && (selectedColumn === null || firstRow[0].length - 2 <= selectedColumn)) {
        cursorLineIdx = i;
        break;
      }
    }
  }
  if (cursorLineIdx < 0) return [];
  const found: Array<{ index: number; label: string }> = [];
  const seenIndices = new Set<number>();

  // Cursor line: option 1 may be inline after box dividers + prompt header
  // (`...divider...header...❯1. label`) — and, when the PTY reflows the whole
  // AUQ onto ONE logical line, options 2..N sit on the SAME line after it
  // (observed with /plan-design-review's Step-0 scope gate: `❯1.Branch diff
  // ... 2.Plan or design doc ... 5.Chat about this ... Enter to select`).
  // Parse the cursor line as a STREAM: find every `N.` token (not preceded
  // by a digit, not followed by one — excludes "12." and "1.5"), require
  // ascending indices starting from the cursor's option, and take each
  // label as the text between successive number tokens.
  const cursorLine = lines[cursorLineIdx] ?? '';
  // A standalone row supplies its number's column. Wrapped descriptions
  // start farther right and may themselves begin with "4." or another
  // number. Inline/reflowed cursor lines have no such column constraint.
  const standaloneRow = /^[ \t]*(?:❯[ \t]*)?1\./.exec(cursorLine);
  const optionColumn = standaloneRow ? numberColumn(standaloneRow) : null;
  const cursorStart = cursorLine.indexOf('❯');
  const cursorSegment = cursorStart >= 0 ? cursorLine.slice(cursorStart) : cursorLine;
  const tokenRe = /(?:^|[^0-9])([1-9])\.(?!\d)\s*/g;
  const tokens: Array<{ idx: number; labelStart: number; matchStart: number }> = [];
  // The known cursor anchor is unambiguously an option, even when its label
  // starts with a digit (captured: "❯1.1retryattempt..."). Keep the decimal
  // guard for number-like text inside the remaining labels.
  const firstToken = /^[\s❯]*1\.\s*/.exec(cursorSegment);
  if (firstToken) {
    tokens.push({ idx: 1, labelStart: firstToken[0].length, matchStart: 0 });
    tokenRe.lastIndex = firstToken[0].length;
  }
  for (let m = tokenRe.exec(cursorSegment); m !== null; m = tokenRe.exec(cursorSegment)) {
    tokens.push({
      idx: Number(m[1]),
      labelStart: m.index + m[0].length,
      matchStart: m.index === 0 ? 0 : m.index + 1, // skip the [^0-9] guard char
    });
  }
  // Keep only the ascending run that starts the sequence (1, 2, 3, ...);
  // stray numbers inside labels break ascension and end the run.
  let expected = 1;
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    if (token.idx !== expected) continue;
    const next = tokens
      .slice(t + 1)
      .find((candidate) => candidate.idx === expected + 1 && candidate.matchStart > token.labelStart);
    const labelEnd = next ? next.matchStart : cursorSegment.length;
    const label = cursorSegment.slice(token.labelStart, labelEnd).trim();
    if (label.length > 0 && !seenIndices.has(token.idx)) {
      seenIndices.add(token.idx);
      found.push({ index: token.idx, label });
      expected += 1;
    }
  }

  // Subsequent lines: standard start-of-line option parsing.
  for (let i = cursorLineIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = optionRe.exec(line);
    if (!m) continue;
    if (optionColumn !== null && line.indexOf(m[1]!) > optionColumn) continue;
    const idx = Number(m[1]);
    const label = (m[2] ?? '').trim();
    // Two peer rows with the same number are ambiguous, even if their
    // labels agree. A nested description was excluded by geometry above.
    if (seenIndices.has(idx)) return [];
    if (label.length === 0) continue;
    seenIndices.add(idx);
    found.push({ index: idx, label });
  }
  // Only return if we found a sequential 1.., 2.., ... block (at least 2
  // consecutive options starting at 1). Otherwise it's noise (e.g. a
  // numbered list inside prose, like "1. Read the file").
  found.sort((a, b) => a.index - b.index);
  if (found.length < 2) return [];
  if (found[0]!.index !== 1) return [];
  for (let i = 1; i < found.length; i++) {
    if (found[i]!.index !== found[i - 1]!.index + 1) {
      // Truncate at the first gap.
      return found.slice(0, i);
    }
  }
  return found;
}

/**
 * The four /plan-ceo-review modes, used by the finding-count tests as a
 * Step-0 boundary signal: an AUQ whose options
 * match this regex IS the mode pick (the last Step-0 question for plan-ceo).
 *
 * Lifted out of the mode-routing test so multiple PTY tests can share one
 * source of truth — when /plan-ceo-review adds a fifth mode, one regex updates
 * everywhere instead of drifting per-test.
 */
// Cursor-positioning escapes render inter-word spaces that stripAnsi removes.
// Recognize both the spaced labels and their captured HOLDSCOPE-style forms.
// Match the leading option title; a description or prose mention of a mode
// cannot establish the Step-0 boundary or supply a missing mode choice.
export const MODE_RE = /^\s*(?:\*\*)?(?:[A-D]\s*[—)]\s*)?(HOLD\s*SCOPE|SCOPE\s*EXPANSION|SELECTIVE\s*EXPANSION|SCOPE\s*REDUCTION)\b/i;

export function optionsSignature(
  opts: Array<{ index: number; label: string }>,
): string {
  return [...opts]
    .sort((a, b) => a.index - b.index)
    .map((o) => `${o.index}:${o.label}`)
    .join('|');
}

/**
 * Pure classifier for the visible TTY buffer. Decides which outcome the
 * polling loop should return on this tick, or `null` to keep polling.
 *
 * Extracted from `runPlanSkillObservation` so the unit suite can exercise
 * the actual branch order with synthetic input strings — a future contributor
 * who reorders the branches (e.g., moves the permission short-circuit) gets
 * caught by the unit tests, not by a stochastic E2E run.
 *
 * Live-state branches (process exited, "Unknown command") stay in the runner
 * since they need the session handle.
 */
export type ClassifyResult =
  | { outcome: 'silent_write'; summary: string }
  | { outcome: 'wrote_findings_before_asking'; summary: string }
  | { outcome: 'auto_decided'; summary: string }
  | { outcome: 'plan_ready'; summary: string }
  | { outcome: 'asked'; summary: string }
  | null;

export const SANCTIONED_WRITE_SUBSTRINGS = [
  '.claude/plans',
  '.gstack/',
  '/.context/',
  'CHANGELOG.md',
  'TODOS.md',
];

/**
 * Find the position of the first AskUserQuestion-style numbered-option list
 * that is NOT a permission dialog. Returns -1 if none has rendered yet.
 *
 * Used by the strict-plan-writes detector (D4) to distinguish legitimate
 * post-AUQ plan writes from the transcript bug ("write findings to plan
 * before asking").
 */
function findFirstAuqRenderIndex(visible: string): number {
  const re = /❯\s*1\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(visible)) !== null) {
    // 200 bytes back + TAIL_SCAN_BYTES forward gives enough context for
    // isPermissionDialogVisible to recognize the typical permission UI.
    const surroundStart = Math.max(0, m.index - 200);
    const surroundEnd = Math.min(visible.length, m.index + TAIL_SCAN_BYTES);
    const surround = visible.slice(surroundStart, surroundEnd);
    if (!isPermissionDialogVisible(surround)) {
      return m.index;
    }
  }
  return -1;
}

export function classifyVisible(
  visible: string,
  opts?: {
    /**
     * When true, treat Write/Edit to `.claude/plans/*` BEFORE any
     * AskUserQuestion render as `wrote_findings_before_asking` rather than
     * letting the sanctioned-write list silently approve it. Used by tests
     * that seed a draft plan with guaranteed-finding-triggering complexity
     * (D3-B), where a pre-AUQ plan write is the precise transcript bug.
     * Default false — preserves existing behavior for unseeded smoke tests
     * where zero-findings → write plan → plan_ready is legitimate.
     */
    strictPlanWrites?: boolean;
    /** Seeded observations require the complete native approval panel in this owned viewport. */
    currentScreen?: string;
  },
): ClassifyResult {
  // Silent-write detection: any Write/Edit tool render that targets a path
  // OUTSIDE the sanctioned dirs, AND no numbered prompt is currently on screen
  // (a numbered prompt means a permission/AskUserQuestion is gating the write,
  // not an actual silent write).
  const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  const auqRenderIdx = opts?.strictPlanWrites ? findFirstAuqRenderIndex(visible) : -1;
  while ((m = writeRe.exec(visible)) !== null) {
    const target = m[1] ?? '';
    const writePos = m.index;
    const isPlanWrite = target.includes('.claude/plans');
    const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) => target.includes(s));

    // D4-B: when strictPlanWrites is on, plan writes that precede the first
    // AUQ render are flagged. Legitimate end-of-workflow plan writes happen
    // AFTER an AUQ has rendered (i.e., the user has been asked). The
    // transcript bug is a plan write WITHOUT any AUQ render preceding it.
    if (opts?.strictPlanWrites && isPlanWrite) {
      if (auqRenderIdx < 0 || writePos < auqRenderIdx) {
        return {
          outcome: 'wrote_findings_before_asking',
          summary: `Write/Edit to ${target} fired before any AskUserQuestion render`,
        };
      }
      // post-AUQ plan write — legitimate, fall through to other writes
      continue;
    }

    if (!sanctioned && !isNumberedOptionListVisible(visible)) {
      return {
        outcome: 'silent_write',
        summary: `Write/Edit to ${target} fired before any AskUserQuestion`,
      };
    }
  }
  // 'auto_decided' must beat 'plan_ready': when AUTO_DECIDE fires upstream of
  // plan-ready, both signals are visible by the time the polling loop checks.
  // The annotation text is the more informative outcome — it explains WHY
  // we got to plan_ready without surfacing the question.
  if (isAutoDecidedVisible(visible)) {
    return {
      outcome: 'auto_decided',
      summary:
        'skill auto-decided an AskUserQuestion via the AUTO_DECIDE preamble (the user never saw the prompt)',
    };
  }
  if (isPlanReadyVisible(visible)) {
    if (opts?.currentScreen === undefined || isCurrentPlanApprovalScreen(opts.currentScreen)) {
      return {
        outcome: 'plan_ready',
        summary: 'skill ran end-to-end and emitted plan-mode "Ready to execute" confirmation',
      };
    }
    // Historical TODO prose and stale approval menus cannot finish a seeded
    // review. The viewport may corroborate an existing question, never add one.
    const current = opts.currentScreen;
    // A streaming or mismatched native approval panel is not an AUQ either.
    if (/Claude (?:has written up a plan|wants to exit plan mode)|Exit plan mode\?/i.test(current) ||
        !(isNumberedOptionListVisible(visible) && isNumberedOptionListVisible(current) ||
          isProseAUQVisible(visible) && isProseAUQVisible(current))) return null;
    visible = current;
  }
  if (isNumberedOptionListVisible(visible)) {
    // Permission dialogs render numbered lists too. Skip them — the
    // bug we want to catch is "skill question never fired."
    if (isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
      return null;
    }
    return {
      outcome: 'asked',
      summary: 'skill fired a numbered-option prompt (AskUserQuestion or routing-injection)',
    };
  }
  // Prose-rendered AUQ: model surfaced the question as lettered or numbered
  // options in plain text (typical under --disallowedTools AskUserQuestion
  // when no MCP variant is callable). The model is waiting for user input
  // via the plan-mode input prompt rather than via the AUQ tool UI; this
  // is still a legitimate "asked" surface — semantically equivalent to a
  // tool-call AUQ from the test's perspective.
  if (isProseAUQVisible(visible)) {
    if (isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
      return null;
    }
    return {
      outcome: 'asked',
      summary: 'skill rendered a prose-style AskUserQuestion (model waiting for user input)',
    };
  }
  return null;
}

/** Permission and question capture inspect the same cursor-anchored window. */
export function planCountPermissionMenu(visible: string, boundEdit = false): {
  normalized: string; cursorAt: number; prompt: string; menu: string;
} | null {
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const start = Math.max(0, normalized.length - 4096);
  const cursor = [...normalized.slice(start).matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return null;
  const cursorAt = start + cursor.index;
  const before = normalized.slice(start, cursorAt);
  const header = [...before.matchAll(/(?:^|\n)[\t │┃]*[☐□]([^\n│]*)/g)].at(-1);
  const menu = normalized.slice(cursorAt);
  // The native question panel has its own header and navigation footer.
  // Its actual finding may discuss file creation or permission policy.
  if (header && !/❯\s*[1-9]\./.test(before.slice(header.index)) &&
      /Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.test(menu)) return null;
  // Anchor redraw identity to its question line; prior tool output and
  // the preceding menu's footer must not change a permission signature.
  const prompt = [...before.matchAll(/^[^\n]*\?[^\n]*$/gm)].at(-1)?.[0].trim()
    ?? parseQuestionPrompt(normalized);
  const selected = prompt + '\n' + menu;
  // An Edit's preview/header belongs to its current identity. Reducing that
  // pane to a bare question would erase a crop, mismatch, or quoted prefix.
  // Other legacy permissions stay prompt-local so old labels cannot grant.
  const context = currentFilePermissionTarget(selected)?.operation === 'edit' ? before + menu : selected;
  // The cursor window can cut through a long diff while its complete native
  // heading is still on screen. Validate that original pane, including its
  // provenance and footer; the cropped window cannot replace those checks.
  if (!prompt || !(isPermissionDialogVisible(context) || isNativeEditPermissionVisible(normalized) ||
      (boundEdit && isCroppedEditPermissionVisible(normalized)))) return null;
  return { normalized, cursorAt, prompt, menu };
}

/**
 * Detects when a plan-* skill has reached its Completion Summary / Review
 * Report — a terminal signal complementary to plan-mode's "Ready to execute"
 * confirmation. Each plan-review skill writes one of these phrasings near
 * the end of its run; matching any one is enough to stop counting.
 *
 * Best-effort: this is a content marker, not a deterministic event. Hard
 * ceiling (`reviewCountCeiling` in `runPlanSkillCounting`) is the reliable
 * stop signal; this regex is the "we're done, go gracefully" hint.
 */
export const COMPLETION_SUMMARY_RE =
  /^[\t ]*(?:[⏺●][\t ]*)?(?:#{1,6}[\t ]*)?(?:GSTACK[\t ]*REVIEW[\t ]*REPORT|Completion[\t ]*[Ss]ummary|Status:[\t ]*(?:clean|issues_open)|(?:\*\*)?VERDICT:)/m;

/** Classify a counting frame before treating numbered native dialogs as AUQs. */
export function classifyPlanCountFrame(
  visible: string,
): 'permission' | 'completion_summary' | 'plan_ready' | null {
  const report = [...visible.matchAll(new RegExp(COMPLETION_SUMMARY_RE.source, 'gm'))].at(-1);
  const menuCursor = [...visible.matchAll(/❯\s*[1-9]\./g)].at(-1)?.index ?? -1;
  const activeQuestionStart = Math.max(
    visible.lastIndexOf('☐', menuCursor), visible.lastIndexOf('☒', menuCursor),
  );
  const permissionTail = visible.slice(Math.max(visible.length - TAIL_SCAN_BYTES, activeQuestionStart, 0));
  if (isNumberedOptionListVisible(visible) &&
      isPermissionDialogVisible(permissionTail) &&
      planCountPermissionMenu(visible) &&
      (!report || report.index <= menuCursor)) {
    return 'permission';
  }
  // Headings must be assistant output, not numbered Read/Write diff rows
  // such as "409 +## GSTACK REVIEW REPORT". The anchored matcher also
  // leaves a completed tool's diff in scrollback without ending the review.
  // A later assistant report supersedes a dismissed permission menu still
  // present in short scrollback; a pending menu below the report does not.
  if (report && report.index > menuCursor) return 'completion_summary';
  if (isPlanReadyVisible(visible)) return 'plan_ready';
  return null;
}

/** A complete native checkbox panel, including its separate Submit/Next button. */
export function nativeCheckboxPanel(visible: string): { selected: boolean; submitFocused: boolean } | null {
  const text = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const bar = [...text.matchAll(/^ {0,3}←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→[ \t]*$/gm)].at(-1);
  if (!bar) return null;
  const precedingLine = text.slice(0, bar.index).trimEnd().split('\n').at(-1) ?? '';
  if (/\b(?:example|quoted|source)\b[^:\n]*:\s*$/i.test(precedingLine)) return null;
  let fence: string | undefined;
  for (const line of text.slice(0, bar.index).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
  }
  if (fence) return null;
  const panel = text.slice(bar.index + bar[0].length);
  if (!/Enter\s+to\s+select\s*·\s*(?:↑\/↓|Tab\/Arrow\s+keys)\s+to\s+navigate\s*·\s*Esc\s+to\s+cancel\s*$/i.test(panel)) return null;
  const rows = [...panel.matchAll(/^ {0,3}(❯)?[ \t]*([1-9])\.[ \t]*\[([ ✓✔xX])\][ \t]+[^\n]+$/gm)];
  if (rows.length < 2 || rows.some((row, i) => Number(row[2]) !== i + 1)) return null;
  const button = [...panel.matchAll(/^ {0,3}(❯)?[ \t]*(Submit|Next)[ \t]*$/gm)].at(-1);
  if (!button || button.index! <= rows.at(-1)!.index!) return null;
  const cursors = [...panel.matchAll(/❯/g)];
  if (cursors.length !== 1 || (!button[1] && !rows.some(row => row[1]))) return null;
  return { selected: rows.some(row => row[3] !== ' '), submitFocused: Boolean(button[1]) };
}

/** Navigate native multi-question review without counting Submit as a finding. */
export function planCountSubmissionInput(visible: string): string | null {
  const checkbox = nativeCheckboxPanel(visible);
  if (checkbox?.selected) return checkbox.submitFocused ? '\r' : '\t';
  const bars = [...visible.matchAll(/←[^\r\n]*[☐☒][^\r\n]*✔\s*Submit\s*→/g)];
  const bar = bars.at(-1);
  if (!bar) return null;
  const panel = visible.slice(bar.index + bar[0].length).replace(/\s+/g, '');
  const cursor = [...panel.matchAll(/❯([1-9])\.?/g)].at(-1);
  if (!/^Reviewyouranswe?rs/i.test(panel) || !cursor || cursor[1] !== '1') return null;
  const beforeCursor = panel.slice(0, cursor.index);
  // The native tab bar, review heading and immediately preceding question
  // identify Submit even when its button caption loses letters in a redraw.
  const readyPrompt = /Readytosubmityouranswers\?$/i.test(beforeCursor);
  // Older captures lack an intact Ready prompt. Keep their exact Submit
  // caption path only while no later question/menu has entered scrollback.
  const legacyCaption = /^❯1\.?Submit/i.test(panel.slice(cursor.index)) &&
    !/❯[1-9]|[☐☒]/.test(beforeCursor);
  if (!readyPrompt && !legacyCaption) return null;
  const tabs = [...bar[0].matchAll(/[☐☒]/g)].map((match) => match[0]);
  const unanswered = tabs.indexOf('☐');
  // At the Submit tab, move back to the first unanswered question. Only
  // submit after every question tab carries the native answered marker.
  return unanswered >= 0 ? '\x1b[Z'.repeat(tabs.length - unanswered) : '\r';
}
