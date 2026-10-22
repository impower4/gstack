/**
 * AskUserQuestion fingerprinting, native question matching and answer input. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as path from 'node:path';
import { type NativePlanQuestionCall } from '../plan-count-transcript';
import { type FilePermissionEpoch } from '../plan-count-file-permission';
import { stripVTControlCharacters } from 'node:util';
import { nativeCheckboxPanel, optionsSignature, parseNumberedOptions, planCountPermissionMenu } from './classify';
import { stripPtyResidue } from './screen';

// ────────────────────────────────────────────────────────────────────────────
// Per-finding AskUserQuestion count primitives (used by runPlanSkillCounting).
//
// These are pure helpers extracted up-front so the unit suite can exercise
// them deterministically before the live-PTY counter runs them. Each one is
// independently unit-testable against synthetic visible-buffer strings.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Captured identity of an AskUserQuestion — the rendered question text plus
 * its numbered options. Used by `runPlanSkillCounting` to dedupe redrawn
 * prompts and to feed `Step0BoundaryPredicate` callers.
 *
 * `signature` is the stable hash. Two AUQs with identical prompt + options
 * produce the same signature; differences in either field produce different
 * signatures. Critically: two AUQs with shared option labels (e.g. the
 * generic "A) Add to plan / B) Defer / C) Build now" menu) but different
 * question text get DIFFERENT signatures because the prompt is in the hash.
 */
export interface AskUserQuestionFingerprint {
  /** Stable hash combining normalized prompt text + options signature. */
  signature: string;
  /** First 240 chars of the rendered question prompt (post-normalization). */
  promptSnippet: string;
  /** Captured option labels, in index order. */
  options: Array<{ index: number; label: string }>;
  /** Wall-clock when first observed (ms since the helper started polling). */
  observedAtMs: number;
  /** True for setup classification; administrative calls are false plus their marker. */
  preReview: boolean;
  /** An administrative call is preserved but adds neither setup nor finding coverage. */
  administrative?: 'completion-handoff' | 'artifact-generation';
  /** Lossless source metadata for observed calls; UI-only fingerprints omit it. */
  nativeCall?: NativePlanQuestionCall;
  /** Active tab for UI answering; completed coverage still counts the whole call once. */
  nativeQuestionIndex?: number;
}

/** Full question text feeds routing/phase predicates before diagnostics truncate it. */
export function nativePlanCallFingerprint(call: NativePlanQuestionCall, observedAtMs: number, preReview: boolean): AskUserQuestionFingerprint {
  // An unanswered mode tab cannot establish the selected review mode. Keep
  // every question in nativeCall, but classify and summarize only the
  // actually answered questions once a native call has completed.
  const questions = call.answered ? call.questions.filter(q => call.answers?.[q.question]) : call.questions;
  return {
    signature: `${call.sessionId}:${call.toolUseId}`,
    promptSnippet: questions.map(q => `${q.header} ${q.question}`).join('\n\n'),
    options: questions.flatMap(q => q.options.map((o, i) => ({ index: i + 1, label: o.label }))),
    observedAtMs, preReview, nativeCall: call,
  };
}

/**
 * Predicate fired against the AUQ we just answered (not the visible buffer).
 * Returns true if this AUQ's fingerprint marks the LAST Step-0 question for
 * its skill — all subsequent AUQs are review-phase findings.
 *
 * Event-based by design: matching against an answered AUQ's fingerprint
 * (prompt + options) is deterministic, whereas matching against later
 * rendered content (section headers, summary text) races with the agent's
 * output cadence. See plan §D14 for the rationale.
 */
export type Step0BoundaryPredicate = (
  answeredFingerprint: AskUserQuestionFingerprint,
) => boolean;

/** First findings start review immediately; recognized setup stays setup even when its order varies. */
export function planCountQuestionPhase(
  fp: AskUserQuestionFingerprint,
  reviewStarted: boolean,
  isLastStep0AUQ: Step0BoundaryPredicate,
  isFirstReviewAUQ?: Step0BoundaryPredicate,
  isSetupAUQ?: Step0BoundaryPredicate,
  isCompletionHandoffAUQ?: Step0BoundaryPredicate,
  isArtifactGenerationAUQ?: Step0BoundaryPredicate,
): { preReview: boolean; reviewStarted: boolean; administrative?: 'completion-handoff' | 'artifact-generation' } {
  // A completion menu cannot start review or satisfy a finding floor, even
  // if its summary mentions defects that a first-finding predicate recognizes.
  if (isCompletionHandoffAUQ?.(fp)) return { preReview: false, reviewStarted, administrative: 'completion-handoff' };
  if (isArtifactGenerationAUQ?.(fp)) return { preReview: false, reviewStarted, administrative: 'artifact-generation' };
  const inReview = reviewStarted || Boolean(isFirstReviewAUQ?.(fp));
  return { preReview: Boolean(isSetupAUQ?.(fp)) || !inReview, reviewStarted: inReview || isLastStep0AUQ(fp) };
}

/**
 * Parse the rendered question prompt out of a visible TTY buffer. The prompt
 * starts at the active boxed question header when available, otherwise at
 * the lines immediately ABOVE the latest `❯ 1.` cursor line.
 *
 * Returns the prompt normalized to a single-spaced 240-char snippet (strip
 * ANSI residue, collapse internal whitespace, trim) — short enough to use as
 * a hash key, long enough to disambiguate distinct questions.
 *
 * Returns "" when no prompt could be parsed (cursor not yet rendered, or
 * cursor is at the top of the buffer with no preceding text). Callers that
 * use the empty string as a fingerprint input should treat empty-prompt
 * AUQs as "wait one more poll" rather than fingerprinting them — otherwise
 * the same options + empty prompt across two distinct questions collide.
 */
export function parseQuestionPrompt(visible: string): string {
  visible = visible.replace(/\r+\n?/g, '\n');
  // Anchor context to the latest menu, not the moving end of output. After
  // an answer, spinner/prose output can push just the prompt's beginning
  // out of a trailing 4KB window while leaving its options visible. That
  // shortened same prompt must not acquire a new finding fingerprint.
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return '';
  const tail = visible.slice(Math.max(0, cursor.index - 4096), cursor.index + cursor[0].length);
  const lines = tail.split('\n');
  const cursorLineIdx = lines.length - 1;

  // Box-layout case: prompt text may be ON the cursor line, BEFORE `❯1.`.
  // Extract that prefix (after stripping leading box-drawing characters and
  // dividers) as the last piece of the prompt — appended after any prior
  // multi-line prompt text we walk up to find.
  const cursorLine = lines[cursorLineIdx] ?? '';
  let inlinePrompt = '';
  const cursorPos = cursorLine.search(/❯\s*1\./);
  if (cursorPos > 0) {
    const prefix = cursorLine.slice(0, cursorPos);
    const boxStart = Math.max(prefix.lastIndexOf('☐'), prefix.lastIndexOf('□'));
    inlinePrompt = prefix
      .slice(boxStart >= 0 ? boxStart : 0)
      // Strip box-drawing chars + dividers + leading checkbox sigil.
      .replace(/^[─━┄┅┈┉─┌┐└┘├┤┬┴┼│┃☐□■\s]+/, '')
      .trim();
    // A complete inline AUQ starts at its checkbox/header. Earlier lines
    // belong to the CLI's Planning chrome or prior output, not this prompt.
    // Including them can consume all 240 chars before the question starts.
    if (boxStart >= 0 && inlinePrompt.length > 0) {
      return inlinePrompt.replace(/\s+/g, ' ').slice(0, 240);
    }
  }

  // Native boxed AUQs can contain many paragraphs separated by a lone │.
  // Walking upward from the options stops at that border (or the six-line
  // limit) and loses the question's identity. Start at the latest header
  // inside the same fixed, cursor-anchored context window instead. Reject
  // earlier menus / Planning chrome so an old header cannot label a new
  // unboxed dialog after its question has been dismissed.
  const questionStart = [...tail.matchAll(/(?:^|\n)[\t │┃]*[☐□][\t ]*(?=\S)/g)].at(-1);
  if (questionStart) {
    const question = tail.slice(questionStart.index, tail.length - cursor[0].length);
    if (!/❯\s*[1-9]\./.test(question) && !/(?:^|\n)\s*Plan+ing\s*:/i.test(question)) {
      const prompt = question
        .replace(/^[\t ─━┄┅┈┉┌┐└┘├┤┬┴┼│┃☐□■]+/gm, '')
        .replace(/\s+/g, ' ').trim();
      if (prompt) return prompt.slice(0, 240);
    }
  }

  // Walk up at most 6 lines collecting prompt text. Stop at:
  //   - a blank line preceded by another blank line (paragraph break)
  //   - top of buffer
  //   - a line that itself starts with `N.` (we're inside an option list)
  const promptLines: string[] = [];
  let blankRun = 0;
  for (let i = cursorLineIdx - 1; i >= 0 && promptLines.length < 6; i--) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '') {
      blankRun += 1;
      if (blankRun >= 2 && promptLines.length > 0) break;
      continue;
    }
    blankRun = 0;
    if (/^[─━┄┅┈┉╌┌┐└┘├┤┬┴┼│┃]+$/.test(trimmed) ||
        /^Plan+ing\s*:/i.test(trimmed)) break;
    // Stop if we hit what looks like a previous numbered list.
    if (/^[\s❯]*[1-9]\.\s+\S/.test(raw)) break;
    promptLines.unshift(trimmed);
    if (/[☐□]/.test(trimmed)) break;
  }

  const all = inlinePrompt.length > 0 ? [...promptLines, inlinePrompt] : promptLines;
  const joined = all.join(' ').replace(/\s+/g, ' ').trim();
  return joined.slice(0, 240);
}

/**
 * Stable hash for an AskUserQuestion's identity — combines normalized prompt
 * text with the options signature so two distinct questions with shared menu
 * labels (the generic A/B/C TODO-proposal menu, for instance) get different
 * fingerprints.
 *
 * Uses Bun's fast non-crypto hash since these strings are short and we only
 * need collision resistance against accidental TTY redraws, not adversaries.
 * Hex-encoded for diagnostic dumps.
 */
export function auqFingerprint(
  promptSnippet: string,
  opts: Array<{ index: number; label: string }>,
): string {
  const normalized = promptSnippet.replace(/\s+/g, ' ').trim();
  const sig = optionsSignature(opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Bun as any).hash(normalized + '||' + sig).toString(16);
}

/** A scrolled question must retain its entire visible suffix, choices and footer. */
function matchesClippedNativeQuestion(visible: string, call: NativePlanQuestionCall): boolean {
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return false;
  const before = visible.slice(0, cursor.index);
  // Blank viewport padding carries no identity. Every nonblank pre-menu
  // line must still match the native question suffix below; a header or
  // preceding menu cannot become a clipped question.
  if (/[☐□❯]/.test(before)) return false;
  const suffix = before.replace(/^[ \t]*[│┃] ?|[│┃][ \t]*$/gm, '').trim();
  const exact = (value: string) => value.replace(/\s+/g, '');
  const question = call.questions[0]!;
  const native = exact(question.question);
  const displayed = exact(suffix);
  // The ordinary native renderer first elides at 2,000 UTF-16 units; a
  // short viewport can then crop that displayed prefix's header and start.
  // Authenticate its whole visible suffix against that exact rendering too.
  const prefix = question.question.slice(0, 2000);
  const bounded = /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
  const elided = question.question.length > 2000 ? exact(bounded.replace(/\t/g, ' ') + '…') : null;
  // Require substantial positive question text, including all visible
  // pre-menu lines. Shared option labels or a generic short tail cannot
  // borrow an unrelated pending call's routing policy.
  if (suffix.split('\n').filter(line => line.trim()).length < 2 || displayed.length < 160 ||
      displayed.length > native.length || !(native.endsWith(displayed) || elided?.endsWith(displayed))) return false;
  const menu = visible.slice(cursor.index);
  const footer = /Enter\s*to\s*select\s*·\s*(?:↑\/↓\s*to\s*navigate(?:\s*·\s*n\s*to\s*add\s*notes)?|Tab\/Arrow\s*keys\s*to\s*navigate)\s*·\s*Esc\s*to\s*cancel/i.exec(menu);
  if (!footer || !/^[\s│┃─━└┘]*$/.test(menu.slice(footer.index + footer[0].length))) return false;
  const options = parseNumberedOptions(visible);
  const offered = options.slice(0, question.options.length);
  const controls = options.slice(question.options.length);
  return offered.length === question.options.length && offered.every((option, index) =>
    option.index === index + 1 && exact(option.label) === exact(question.options[index]!.label)) &&
    controls.length <= 2 && controls.every((option, index) => option.index === question.options.length + index + 1 &&
      (index === 0 ? /^Typesomething\.?$/ : /^Chataboutthis$/).test(exact(option.label)));
}

/** Match a pending packet's displayed tab by its full question and offered choices. */
function nativePacketQuestionIndex(visible: string, call: NativePlanQuestionCall): number | null {
  if (call.failed || call.questions.length < 2) return null;
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const cursor = [...normalized.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return null;
  const before = normalized.slice(0, cursor.index);
  const bar = [...before.matchAll(/←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→/g)].at(-1);
  if (!bar) {
    const clipped = call.questions.flatMap((question, index) =>
      matchesClippedNativeQuestion(normalized, {...call, questions: [question]}) ? [index] : []);
    return clipped.length === 1 ? clipped[0]! : null;
  }
  if (!/Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate\s*·\s*Esc\s*to\s*cancel/i.test(normalized.slice(cursor.index))) return null;
  const compact = (value: string) => value.replace(/^[\t │┃]+/gm, '').replace(/\s+/g, '');
  const body = compact(before.slice(bar.index + bar[0].length));
  const options = parseNumberedOptions(normalized);
  const matched = call.questions.flatMap((q, index) => body === compact(q.question) &&
    q.options.every((option, i) => options[i]?.index === i + 1 && compact(options[i]!.label) === compact(option.label)) ? [index] : []);
  return matched.length === 1 ? matched[0]! : null;
}

/** Notes can share the left option row while remaining aligned to the preview. */
function hasSidebarPreviewNotes(visible: string): boolean {
  // The footer and active pane establish the protocol. A notes phrase in an
  // option label alone is insufficient: require its aligned, complete box.
  if (!/(?:^|\n)[\t │┃]*(?:[☐□][^\n]+|←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→)[\s\S]*❯\s*[1-9]\.[\s\S]*\nEnter\s+to\s+select\s*·\s*↑\/↓\s+to\s+navigate\s*·\s*n\s+to\s+add\s+notes\s*·\s*(?:Tab\s+to\s+switch\s+questions\s*·\s*)?Esc\s+to\s+cancel\s*$/i.test(visible)) return false;
  const header = [...visible.matchAll(/(?:^|\n)[\t │┃]*(?:[☐□][^\n]+|←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→)/g)].at(-1);
  if (!header) return false;
  const lines = visible.slice(header.index).split('\n');
  return lines.some((line, notesIndex) => {
    if (!/[\t ]{2,}Notes: press n to add notes[\t ]*$/i.test(line)) return false;
    const column = line.indexOf('Notes:');
    // The hint may align with a wrapped continuation of the option label.
    let optionIndex = notesIndex;
    while (optionIndex > 0 && /^[\t ]{4,}\S[^│┌└]*$/.test(lines[optionIndex]!.slice(0, column).trimEnd())) optionIndex--;
    if (!/^[\t ]*(?:❯\s*)?[1-9]\.\s*\S[^│┌└]*$/.test(lines[optionIndex]!.slice(0, column).trimEnd())) return false;
    const before = lines.slice(0, notesIndex);
    const top = before.findLastIndex(row => /^┌─+┐[\t ]*$/.test(row.slice(column)));
    const bottom = before.findLastIndex(row => /^└─+┘[\t ]*$/.test(row.slice(column)));
    const width = top < 0 ? 0 : before[top]!.slice(column).trimEnd().length;
    return top >= 0 && bottom > top + 1 && before[bottom]!.slice(column).trimEnd().length === width &&
      before.slice(top + 1, bottom).every(row => /^│[^\n]*│[\t ]*$/.test(row.slice(column)) &&
        row.slice(column).trimEnd().length === width);
  });
}

/** Preview digits focus an option; ordinary native digits accept or toggle it. */
export function planCountQuestionInput(visible: string, fp: AskUserQuestionFingerprint, index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 9) throw new RangeError(`Invalid numbered option: ${index}`);
  const native = fp.nativeCall?.questions[fp.nativeQuestionIndex ?? 0];
  // A numeric shortcut toggles one native checkbox; Enter toggles it again.
  if (native?.multiSelect || nativeCheckboxPanel(visible)) return String(index);
  // Claude Code's preview pane uses numbers only to move focus. Its Return
  // handler submits that focused option, including when native JSONL has not
  // flushed yet. Require the complete active pane, not a quoted notes hint.
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const preview = /(?:^|\n)[\t │┃]*(?:[☐□][^\n]+|←[^\n]*[☐☒][^\n]*✔\s*Submit\s*→)[\s\S]*❯\s*[1-9]\.[\s\S]*\n[\t │┃]*Notes:[^\n]*\n[\s\S]*\nEnter\s+to\s+select\s*·\s*↑\/↓\s+to\s+navigate\s*·\s*n\s+to\s+add\s+notes\s*·\s*(?:Tab\s+to\s+switch\s+questions\s*·\s*)?Esc\s+to\s+cancel\s*$/i.test(normalized);
  if (preview || hasSidebarPreviewNotes(normalized)) return `${index}\r`;
  if (native) return String(index);
  if (/❯?\s*[1-9]\.\s*\[[ ✓✔xX]\]/m.test(visible)) return `${index}\r`;
  // Native JSONL may flush only after submission. Its complete tab bar and
  // navigation footer establish the input protocol without counting coverage.
  const packet = /←[^\r\n]*[☐☒][^\r\n]*✔\s*Submit\s*→[\s\S]*❯\s*1\./.test(visible) &&
    /Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate\s*·\s*Esc\s*to\s*cancel/i.test(visible);
  const single = /(?:^|[\r\n])[\t │┃]*[☐□][^\r\n]+[\s\S]*❯\s*1\./.test(visible) &&
    /Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.test(visible);
  const panel = packet || single;
  return panel ? String(index) : `${index}\r`;
}

/** A native single-question pane can elide its tail to leave room for choices. */
function matchesTruncatedNativeQuestion(visible: string, call: NativePlanQuestionCall, planningDirectory?: string): boolean {
  if (call.questions.length !== 1) return false;
  const rows = visible.split('\n');
  let start = 0;
  while (/^[\t ]*$/.test(rows[start] ?? '#')) start++;
  const leadingRule = /^[ \t]*[─━]{10,}[ \t]*$/.test(rows[start] ?? '') ? rows[start++]!.trim() : undefined;
  if (rows[start] === 'Planning:' || rows[start]?.startsWith('Planning: ')) {
    // Native plan-mode chrome precedes the question's rule/header. The CLI
    // soft-wraps this path; only its owned directory is independently known.
    // Do not infer a basename, trust an ambient plans path, or strip prose.
    if (!planningDirectory || !path.isAbsolute(planningDirectory) ||
        path.resolve(planningDirectory) !== planningDirectory) return false;
    const end = rows.findIndex((row, index) => index > start && /^[ \t]*[─━]{10,}[ \t]*$/.test(row));
    if (end < 0) return false;
    const displayed = rows.slice(start, end).join('\n');
    const ownedPrefix = 'Planning: ' + planningDirectory + '/';
    // Paint removes a soft row's first space; viewport reads trim right padding.
    // Recover directory spaces from owned context, then require its exact native
    // reflow. Never treat whitespace-insensitive prefix matching as authority.
    const joined = rows.slice(start, end).join('');
    let offset = 0;
    for (const character of ownedPrefix.replaceAll(' ', '')) {
      while (joined[offset] === ' ') offset++;
      if (!joined.startsWith(character, offset)) return false;
      offset += character.length;
    }
    const file = planningDirectory + '/' + joined.slice(offset);
    const rule = rows[end]!.trim();
    if ((leadingRule && leadingRule !== rule) || /[\x00-\x1f\x7f\\]/.test(file) ||
        path.resolve(file) !== file || path.dirname(file) !== planningDirectory ||
        !/^[^/]+\.md$/.test(path.basename(file)) ||
        Bun.wrapAnsi('Planning: ' + file, rule.length, {hard:true,trim:false}).split('\n').map((row, index) =>
          (index && row.startsWith(' ') && Bun.stringWidth(row.slice(1)) > 0 ? row.slice(1) : row).trimEnd()).join('\n') !== displayed) return false;
    visible = rows.slice(end).join('\n');
  }
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return false;
  const before = visible.slice(0, cursor.index);
  // Claude's single-question card can start with its native horizontal rule.
  // Accept only that optional border, leaving arbitrary prose outside the pane.
  const header = /^(?:[\t │┃]*\n)*(?:[ \t]*[─━]{10,}[ \t]*\n)?[\t │┃]*[☐□]([^\n│]*)\n/.exec(before);
  if (!header || /[☐□❯]/.test(before.slice(header[0].length))) return false;
  const exact = (value: string) => value.replace(/\s+/g, '');
  const question = call.questions[0]!;
  if (exact(header[1]!) !== exact(question.header)) return false;
  const body = before.slice(header[0].length).replace(/^[ \t]*[│┃] ?|[│┃][ \t]*$/gm, '').trim();
  // Require the complete displayed prefix, not a fragment or common heading.
  // The final ellipsis is the native UI's elision indicator; missing or changed
  // text anywhere before it cannot borrow an unrelated call's answer policy.
  if (!body.endsWith('…')) return false;
  const prefix = exact(body.slice(0, -1));
  const native = exact(question.question);
  if (prefix.length < 160 || body.split('\n').filter(line => line.trim()).length < 2 ||
      prefix.length >= native.length || !native.startsWith(prefix)) return false;
  const menu = visible.slice(cursor.index);
  const footer = /Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.exec(menu);
  if (!footer || !/^[\s│┃─━└┘]*$/.test(menu.slice(footer.index + footer[0].length))) return false;
  const options = parseNumberedOptions(visible);
  const offered = options.slice(0, question.options.length);
  const controls = options.slice(question.options.length);
  return offered.length === question.options.length && offered.every((option, index) =>
    option.index === index + 1 && exact(option.label) === exact(question.options[index]!.label)) &&
    controls.length <= 2 && controls.every((option, index) => option.index === question.options.length + index + 1 &&
      (index === 0 ? /^Typesomething\.?$/ : /^Chataboutthis$/).test(exact(option.label)));
}

/** Match native question identity before permission text can choose an answer. */
export function matchesNativePlanQuestion(visible: string, call: NativePlanQuestionCall, planningDirectory?: string): boolean {
  if (call.failed) return false;
  if (call.questions.length !== 1) return nativePacketQuestionIndex(visible, call) !== null;
  const normalized = stripPtyResidue(visible).replace(/\r+\n?/g, '\n');
  const tail = normalized.slice(-4096);
  const cursor = [...tail.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return false;
  const before = tail.slice(0, cursor.index);
  const header = [...before.matchAll(/(?:^|\n)[\t │┃]*[☐□]([^\n│]*)/g)].at(-1);
  const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  const question = call.questions[0]!;
  if (!header) return matchesClippedNativeQuestion(normalized, call);
  if (compact(header[1]!) !== compact(question.header) || /❯\s*[1-9]\./.test(before.slice(header.index))) return false;
  const identity = question.question.match(/<gstack-qid:[^>]+>/i)?.[0] ?? question.question;
  if (!compact(before.slice(header.index)).includes(compact(identity))) {
    // Complete native question bodies can prefix each wrapped line with a UI rail.
    // Remove exactly one rail, as the clipped/truncated body paths do; retain
    // any second or interior rail that belongs to the native question text.
    const body = before.slice(header.index + header[0].length).trim();
    const rows = body.split('\n').filter(line => line.trim());
    const unboxed = body.replace(/^[ \t]*[\u2502\u2503] ?/gm, '');
    if (!rows.length || !rows.every(line => /^[ \t]*[\u2502\u2503](?: |$)/.test(line)) ||
        compact(unboxed) !== compact(question.question)) return matchesTruncatedNativeQuestion(normalized, call, planningDirectory);
    // The boxed body belongs to a current pane at viewport top or below
    // native pane chrome. Plain prose immediately introducing a copy does not.
    const preceding = normalized.slice(0, normalized.length - tail.length + header.index).trimEnd();
    if (preceding && !/(?:^|\n)[ \t]*[─━]{10,}[ \t]*$/.test(preceding)) return false;
    let fence: string | undefined;
    for (const line of preceding.split('\n')) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!marker) continue;
      if (!fence) fence = marker[1];
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    }
    if (fence) return false;
    const menu = tail.slice(cursor.index);
    const footer = /Enter\s*to\s*select\s*\u00B7\s*\u2191\/\u2193\s*to\s*navigate\s*\u00B7\s*(?:n\s*to\s*add\s*notes\s*\u00B7\s*)?Esc\s*to\s*cancel/i.exec(menu);
    if (!footer || !/^[\s\u2502\u2503\u2500\u2501\u2514\u2518]*$/.test(menu.slice(footer.index + footer[0].length))) return false;
    const options = parseNumberedOptions(visible);
    const offered = options.slice(0, question.options.length);
    const controls = options.slice(question.options.length);
    return offered.length === question.options.length && offered.every((option, index) =>
      option.index === index + 1 && compact(option.label) === compact(question.options[index]!.label)) &&
      controls.length <= 2 && controls.every((option, index) => option.index === question.options.length + index + 1 &&
        (index === 0 ? /^Typesomething\.?$/i : /^Chataboutthis$/i).test(compact(option.label)));
  }
  // Preserve the captured damaged-option path when the native panel's
  // complete footer is intact, including the optional native preview notes key.
  // With a damaged footer, require the full
  // question and every offered label instead of guessing from keywords.
  if (/Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel/i.test(tail.slice(cursor.index))) return true;
  const displayed = before.slice(header.index).replace(/^[\t ─━┄┅┈┉┌┐└┘├┤┬┴┼│┃☐□■]+/gm, '');
  const options = parseNumberedOptions(visible);
  return compact(displayed) === compact(`${question.header} ${question.question}`) &&
    options.length === question.options.length && options.every((option, index) =>
      option.index === index + 1 && compact(option.label) === compact(question.options[index]!.label));
}

/** Capture each distinct question once, including questions sharing a menu. */
export function capturePlanCountQuestion(
  visible: string,
  seen: Set<string>,
  observedAtMs: number,
  preReview: boolean,
  pending?: NativePlanQuestionCall,
  planningDirectory?: string,
): AskUserQuestionFingerprint | null {
  const tail = stripPtyResidue(visible).replace(/\r+\n?/g, '\n').slice(-4096);
  const cursor = [...tail.matchAll(/❯\s*1\./g)].at(-1);
  // The options parser can fall back to ordinary numbered prose when an
  // old cursor leaves its window. Do not pair that prose with the prompt
  // parser's still-visible historical question and queue spurious input.
  if (!cursor) return null;

  if (pending && !pending.answered && !pending.failed && matchesNativePlanQuestion(visible, pending, planningDirectory)) {
    const activeIndex = pending.questions.length === 1 ? 0 : nativePacketQuestionIndex(visible, pending)!;
    const fp = nativePlanCallFingerprint(pending, observedAtMs, preReview);
    fp.nativeQuestionIndex = activeIndex;
    if (pending.questions.length > 1) {
      const question = pending.questions[activeIndex]!;
      fp.signature += `:question:${activeIndex}`;
      fp.promptSnippet = `${question.header} ${question.question}`;
      fp.options = question.options.map((option, i) => ({index: i + 1, label: option.label}));
    }
    const renderedOptions = parseNumberedOptions(visible);
    const renderedPrompt = parseQuestionPrompt(visible);
    const renderedSignature = renderedOptions.length >= 2 && renderedPrompt
      ? auqFingerprint(renderedPrompt, renderedOptions) : null;
    const alreadyHandled = seen.has(fp.signature) || Boolean(renderedSignature && seen.has(renderedSignature));
    // Once answered, the same menu may linger while the native call is
    // no longer pending, or the native record may arrive after the UI
    // answer. Bind both identities before testing either direction.
    if (renderedSignature) seen.add(renderedSignature);
    seen.add(fp.signature);
    if (alreadyHandled) return null;
    return fp;
  }
  // A permission cursor can outlive the short frame-classifier window.
  // Never turn it into an ordinary prompt answer, even when its question
  // was damaged by a redraw or its original grant was not observed.
  if (planCountPermissionMenu(visible)) return null;
  const options = parseNumberedOptions(visible);
  if (options.length < 2) return null;
  const promptSnippet = parseQuestionPrompt(visible);
  if (promptSnippet === '') return null;
  const signature = auqFingerprint(promptSnippet, options);
  if (seen.has(signature)) return null;
  seen.add(signature);
  return { signature, promptSnippet, options, observedAtMs, preReview };
}

/**
 * Consume file-permission menus separately from native review questions.
 * A granted menu can be repainted, then linger after the tool completes.
 * Its text is not a new answer request. The same file can ask again after
 * a successful native Write/Edit result, so content-only dedup is too broad.
 */
export function createPlanCountPermissionGuard(): (visible: string, completionHistory?: string, native?: FilePermissionEpoch | null) => 'grant' | 'handled' | null {
  let granted: { signature: string; completedAt: number; nativeId?: string } | undefined;
  return (visible, completionHistory = visible, native) => {
    // Only the current viewport can establish an actionable permission.
    // Historical file results release a later identical grant, never a menu.
    const candidate = planCountPermissionMenu(visible, Boolean(native));
    if (!candidate) {
      // A completed tool row can remain below its old controls. Suppress that
      // stale menu without making a trailing result an actionable permission.
      const completed = /\n[\t ]*⎿[\t \u00a0]*(?:Wrote\s*\d+\s*lines?|Added\s*\d+\s*lines?|Removed\s*\d+\s*lines?|Updated\b|Edited\b)[^\n]*\s*$/.exec(visible);
      return completed && planCountPermissionMenu(visible.slice(0, completed.index)) ? 'handled' : null;
    }
    const { normalized, cursorAt, prompt, menu } = candidate;
    // A whole quoted pane is source text, even if it contains a native cursor.
    // Returning handled also suppresses the dispatcher's default permission input.
    const rows = stripVTControlCharacters(normalized).split('\n').filter(row => row.trim());
    if (rows.length && rows.every(row => /^[\t ]*>/.test(row))) return 'handled';
    // File permission identity comes from the action or native approval
    // choices, not a brittle exact rendering of "Do you want to ...".
    // Other permission kinds retain the existing caller policy.
    if (!/(?:create|overwrite|edit)/i.test(prompt.replace(/\s+/g, '')) &&
        !/(?:acceptedits|allowalledits|auto-approvefileedits)/i.test(menu.replace(/\s+/g, ''))) return null;
    const signature = prompt.replace(/\s+/g, '');

    // Match actual native file-tool results, not proposed diff rows, tool
    // headers, or tips. A diff repaint after the menu is still pending.
    const completionPattern = /^[\t ]*⎿[\t \u00a0]*(?:Wrote\s*\d+\s*lines?|Added\s*\d+\s*lines?|Removed\s*\d+\s*lines?|Updated\b|Edited\b)/gm;
    const visibleCompletedAt = [...normalized.matchAll(completionPattern)].at(-1)?.index ?? -1;
    if (visibleCompletedAt > cursorAt) return 'handled';
    const history = stripPtyResidue(completionHistory).replace(/\r+\n?/g, '\n');
    const completedAt = [...history.matchAll(completionPattern)].at(-1)?.index ?? -1;
    if (native !== undefined) {
      // Native success alone is not a new prompt: the old pane may redraw.
      // Release only a distinct pending request after this exact grant completed.
      if (!native || (granted?.signature === signature &&
          (!granted.nativeId || native.pendingId === granted.nativeId ||
            (native.completedId !== granted.nativeId && !native.completedIds?.includes(granted.nativeId))))) return 'handled';
    } else if (granted?.signature === signature && completedAt <= granted.completedAt) return 'handled';
    granted = { signature, completedAt, ...(native ? {nativeId:native.pendingId} : {}) };
    return 'grant';
  };
}

/** Keep a seeded count plan intact by declining its optional prerequisite. */
export function planCountPrerequisitePick(fp: AskUserQuestionFingerprint, activeCapture: AskUserQuestionFingerprint = fp): number | null {
  // Require the recognized prerequisite body AND both opposed labels. A
  // generic Skip, an outside-review offer, or a review finding keeps its
  // existing answer policy. Collapsed whitespace occurs in captured PTYs.
  if (!fp.preReview || !/\/office-hours/i.test(fp.promptSnippet) ||
      !/(?:no\s*design\s*doc|produce\s*a\s*design\s*doc)/i.test(fp.promptSnippet)) return null;
  const run = fp.options.filter(({ label }) => /^Run\s*\/office-hours\s*(?:now|first)/i.test(label));
  const skip = fp.options.filter(({ label }) =>
    /^Skip\s*[—–-]\s*(?:proceed\s*with\s*)?standard\s*review(?:\s*\(recommended\))?$/i.test(label));
  if (run.length === 1 && skip.length === 1) return skip[0].index;
  // Short labels need the complete meaning of the active native tab. Other
  // questions in a packet cannot lend their prerequisite context or choices.
  const call = activeCapture.nativeCall;
  const activeIndex = activeCapture.nativeQuestionIndex ?? (call?.questions.length === 1 ? 0 : -1);
  if (call && call.answered === false && call.failed === false && activeCapture.preReview &&
      Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < call.questions.length) {
    const q = call.questions[activeIndex]!;
    const base = `${call.sessionId}:${call.toolUseId}`;
    const activeSignature = call.questions.length === 1 ? base : `${base}:question:${activeIndex}`;
    const routing = nativePlanCallFingerprint(call, fp.observedAtMs, fp.preReview);
    const optionsMatch = (capture: AskUserQuestionFingerprint) => capture.options.length === q.options.length &&
      capture.options.every((option, i) => option.index === i + 1 && option.label === q.options[i]!.label);
    const routingMatches = fp.nativeCall === call && (fp.signature === activeSignature
      ? fp.promptSnippet === `${q.header} ${q.question}` && optionsMatch(fp)
      : fp.signature === base && fp.promptSnippet === routing.promptSnippet &&
        JSON.stringify(fp.options) === JSON.stringify(routing.options));
    if (!q.multiSelect && q.options.length === 2 && activeCapture.signature === activeSignature &&
        activeCapture.promptSnippet === `${q.header} ${q.question}` && optionsMatch(activeCapture) && routingMatches &&
        /\/office-hours/i.test(q.question) && /(?:no\s*design\s*doc|produce\s*a\s*design\s*doc)/i.test(q.question)) {
      const nativeRun = q.options.findIndex(option => /^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(option.label));
      const nativeSkip = q.options.findIndex(option =>
        /^Skip(?:\s*[—–-]\s*proceed)?(?:\s*\(recommended\))?$/i.test(option.label) &&
        /^(?:(?:The\s+)?plan\s+(?:scope\s+)?is\s+(?:already\s+)?(?:precise|clear|well-defined|explicit)\.\s*)?Proceed\s+(?:with\s+standard(?:\s+DX(?:\s+(?:POLISH|EXPANSION|TRIAGE))?)?\s+review|straight\s+to\s+Step\s*0\s+premise\s+challenge\s+and\s+approach\s+alternatives)\.?$/i.test((option.description ?? '').trim()));
      // A complete native decision brief can express the option meaning as
      // pros/cons rather than a single imperative sentence. The owned active
      // offer and its two opposed actions still define the only allowed skip.
      const offer = q.question.split('?', 1)[0]!.replace(/^D[1-9]\d*\s*[—–:-]\s*/, '').trim();
      const fullSkip = q.options.findIndex(option =>
        /^Skip\s*[,—–-]\s*(?:proceed\s+with\s+)?standard\s+review(?:\s*\(recommended\))?$/i.test(option.label));
      const plainRun = nativeRun >= 0 && /^(?:Build|Create|Produce)\s+(?:a|the)\s+design\s+doc(?:ument)?\s+first[,;]\s*then\s+resume\s+(?:the|standard|CEO)\s+review\.?$/i.test((q.options[nativeRun]!.description ?? '').trim());
      const plainSkip = fullSkip >= 0 && /^Proceed\s+(?:(?:directly|straight)\s+)?(?:with\s+(?:the\s+)?standard\s+review|to\s+Step\s*0\s+of\s+(?:the\s+)?(?:CEO\s+)?review)\.?$/i.test((q.options[fullSkip]!.description ?? '').trim());
      const briefMeaning = (description: string, meaning: RegExp, skip: boolean): boolean => {
        const rows = description.trim().replace(/(^|\s)[-*]\s+(?=[✅❌])/g, '$1')
          .split(/\r?\n|\s+(?=[✅❌])/).map(row => row.trim()).filter(Boolean);
        // Source quotations, appended imperatives and changed/conditional
        // actions cannot borrow the unconditional meaning of an earlier pro.
        if (rows.length < 2 || rows.some(row => !/^(?:[-*]\s+)?[✅❌]\s+\S/.test(row)) ||
            !rows.some(row => /^(?:[-*]\s+)?❌/.test(row))) return false;
        const body = rows.map(row => row.replace(/^(?:[-*]\s+)?[✅❌]\s+/, '')).join('\n');
        if (/(?:^|[.!?;]\s*|\n|\b(?:and|then|while)\s+(?:(?:also|then)\s+)?)(?:Do\s+not|Don't|Never|No\s+review\b|(?:Accept|Approv|Remov|Delet|Deploy|Ignor|Rewrit|Disabl)[a-z]*\b|First\s+run\b)/im.test(body) ||
            /\b(?:will\s+not|won't|cannot|does\s+not|doesn't)\s+(?:run|proceed|continue|produce|create|build|review)\b/i.test(body) ||
            (skip && /\b(?:after|before|unless|only\s+if|if)\b|\brun\s*\/office-hours\b/i.test(body))) return false;
        return rows.some(row => /^(?:[-*]\s+)?✅/.test(row) && meaning.test(row.replace(/^(?:[-*]\s+)?✅\s+/, '')));
      };
      const runBrief = nativeRun >= 0 && briefMeaning(q.options[nativeRun]!.description ?? '',
        /^(?:Produce|Create|Build)s?\s+(?:a|the)\s+(?:structured\s+)?(?:design\s+doc(?:ument)?|problem\s+statement)\b/i, false);
      const skipBrief = fullSkip >= 0 && briefMeaning(q.options[fullSkip]!.description ?? '',
        /^(?:Proceed|Continue)s?\s+(?:(?:directly|straight)\s+)?with\s+(?:the\s+)?standard\s+review\b|^Goes\s+(?:directly|straight)\s+to\s+(?:the\s+)?(?:engineering\s+)?findings\b/i, true);
      if (nativeRun >= 0 && fullSkip >= 0 && nativeRun !== fullSkip && call.sessionId && call.toolUseId &&
          q.question.split('?').length === 2 &&
          /^(?:No\s+design\s+doc\s+(?:found|exists)(?:\s+for\s+(?:this|the)\s+(?:branch|project))?[.:]\s*)?Run\s*\/office-hours\s+(?:now|first),?\s+or\s+proceed\s+with\s+(?:the\s+)?standard\s+review$/i.test(offer) &&
          ((plainRun && plainSkip) || (runBrief && skipBrief)) &&
          !/\b(?:must|need\s+to|have\s+to)\s+(?:run|complete|finish)\s*\/office-hours\b|(?:\/office-hours|design\s+doc(?:ument)?)\s+(?:is\s+)?(?:required|mandatory)\b|\breview\s+is\s+(?:forbidden|blocked)\b/i.test(q.question)) return fullSkip + 1;
      if (nativeRun >= 0 && nativeSkip >= 0 && nativeRun !== nativeSkip) return nativeSkip + 1;
    }
  }
  // The same prerequisite also offers "Skip — review now" or a direct
  // "Proceed with standard review". Require exactly
  // the two opposed actions so this wording cannot skip a mixed finding.
  const choices = fp.options.filter(({ label }) => !/^(?:Typesomething\.|Chataboutthis)$/i.test(label.replace(/\s+/g, '')));
  const reviewNow = choices.filter(({ label }) => /^(?:Skip\s*[—–-]\s*review\s*now|Proceed\s*with\s*standard\s*review)(?:\s*\(recommended\))?$/i.test(label));
  if (choices.length !== 2 || run.length !== 1 || reviewNow.length !== 1 || run[0].index === reviewNow[0].index ||
      !/^Run\s*\/office-hours\s*(?:now|first)(?:\s*\(recommended\))?$/i.test(run[0].label) ||
      (fp.nativeCall && (fp.nativeCall.failed || fp.nativeCall.questions.length !== 1 || fp.nativeCall.questions[0]?.multiSelect))) return null;
  return reviewNow[0].index;
}
