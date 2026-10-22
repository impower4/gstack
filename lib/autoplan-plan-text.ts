/**
 * autoplan-plan-text — what the runner knows about a plan file's text (plan
 * B1c): the reviewed hash (the sha256 `create` puts in a phase's snapshot:
 * the Implementation plan after the snapshot tool's own review projection),
 * the section diagnosis behind PLAN_SECTIONS_INVALID, the scaffold that
 * `next --scaffold` reviews instead of refusing, and the normalization
 * `revise` applies to a revised plan the way `init` does. The section scanner
 * and projection are the snapshot tool's own exports, so drift is measured on
 * exactly the bytes reviewers saw.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractImplementationPlan, implementationForReview, sectionHeadings } from '../bin/gstack-autoplan-snapshot';
import { extractHeading } from './autoplan-prompts';
import type { RunState } from './autoplan-state';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A plan with no section headings is reviewed whole, exactly as `init` wraps it. */
export function wrapBare(text: string): string {
  return sectionHeadings(text).length ? text : `## Implementation plan\n${text}${text.endsWith('\n') ? '' : '\n'}## Review record\n`;
}

/** The reviewed hash of a plan's text; throws when its sections are invalid. */
export function reviewHash(text: string): string {
  return sha256(implementationForReview(extractImplementationPlan(wrapBare(text))));
}

/** The reviewed hash of a plan file (cut to `heading` first), or undefined when it is unreadable or invalid. */
export function reviewHashOfFile(file: string | undefined, heading?: string): string | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const section = heading ? extractHeading(text, heading) : text;
    return section === undefined ? undefined : reviewHash(scaffold(section).text ?? section);
  } catch { return undefined; }
}

export interface SectionDiagnosis { problem?: string; text?: string; added?: string }

/**
 * Which section problem a plan has, and the scaffold when one heading alone
 * is missing. Duplicate, reversed or empty sections are ambiguous: the
 * boundary between reviewed text and the private Review record is never guessed.
 */
export function scaffold(text: string): SectionDiagnosis {
  const heads = sectionHeadings(text);
  const names = heads.map(h => h.name).join(',');
  if (!heads.length) return {};
  if (names === 'Implementation plan,Review record') {
    try { extractImplementationPlan(text); return {}; } catch (e: any) { return { problem: String(e.message) }; }
  }
  if (names === 'Implementation plan') {
    return { problem: 'has "## Implementation plan" but no "## Review record"', text: `${text}${text.endsWith('\n') ? '' : '\n'}\n## Review record\n`, added: '## Review record' };
  }
  if (names === 'Review record') {
    const before = text.slice(0, heads[0]!.start);
    const title = /^(?:\s*\n|#[ \t][^\n]*\n)*/.exec(before)![0];
    if (!before.slice(title.length).trim()) return { problem: 'has "## Review record" but no plan text before it' };
    return { problem: 'has "## Review record" but no "## Implementation plan"', text: `${title}## Implementation plan\n${text.slice(title.length)}`, added: '## Implementation plan' };
  }
  return { problem: `ambiguous sections (${heads.map(h => `## ${h.name}`).join(', ')}): duplicate or reversed headings` };
}

/** The active-plan bytes for a revised plan: the restore-point comment `init` writes, then the (wrapped) plan. */
export function normalizeRevision(text: string, restorePath: string): string {
  const reference = JSON.stringify(restorePath).replace(/--/g, '\\u002d\\u002d');
  const body = wrapBare(text);
  extractImplementationPlan(body);
  return `<!-- /autoplan restore point: ${reference} -->\n${body}`;
}

/** `<code>: <file> differs from the reviewed plan; run gstack-autoplan revise …` when the owner's plan file moved past the active plan. */
export function driftLine(state: RunState, code: 'PLAN_CHANGED' | 'PLAN_SOURCE_CHANGED'): string | undefined {
  const source = state.plan_input ?? state.plan_source;
  const current = reviewHashOfFile(source, state.plan_input ? state.plan_heading : undefined);
  let reviewed: string;
  try { reviewed = reviewHash(fs.readFileSync(state.active_plan, 'utf8')); } catch { return undefined; }
  if (!current || current === reviewed) return undefined;
  return `${code}: ${source} differs from the reviewed plan; run gstack-autoplan revise --out ${state.out} --plan ${source}`;
}

/** The nearest directory at or above `dir` holding `.git` (no git spawn), or undefined. */
export function repoRoot(dir: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

/** Line offset of `inner` inside `outer` (0 when it starts on line 1), or undefined when it is not a verbatim block of it. */
function blockOffset(inner: string, outer: string): number | undefined {
  const at = outer.indexOf(inner);
  if (at >= 0) return outer.slice(0, at).split('\n').length - 1;
  const restoreLine = /^<!-- \/autoplan restore point:[^\n]*\n/.exec(inner);
  if (!restoreLine) return undefined;
  const rest = blockOffset(inner.slice(restoreLine[0].length), outer);
  return rest === undefined ? undefined : rest - 1;
}

/**
 * A canonical row's `file`/`line` as the owner reads them: an absolute path under the repository root becomes
 * repo-relative; a phase snapshot or the active plan becomes the plan's own file name, its line mapped to the plan
 * source through the snapshot's verbatim position (dropped when it cannot be mapped). The reviewer's bytes are untouched.
 */
export function normalizeFindingFile(f: { file?: string; line?: number }, ctx: { cwd: string; planFiles: string[]; planSource: string; planName: string }): { file?: string; line?: number } {
  if (!f.file) return f;
  const planFile = ctx.planFiles.find(p => f.file === p || (!path.isAbsolute(f.file!) && path.basename(p) === f.file));
  if (planFile) {
    let offset: number | undefined;
    try { offset = blockOffset(fs.readFileSync(planFile, 'utf8'), fs.readFileSync(ctx.planSource, 'utf8')); } catch { offset = undefined; }
    return { file: ctx.planName, ...(f.line !== undefined && offset !== undefined ? { line: f.line + offset } : {}) };
  }
  const root = path.isAbsolute(f.file) ? repoRoot(ctx.cwd) : undefined;
  if (root && f.file.startsWith(root + path.sep)) return { ...f, file: path.relative(root, f.file).split(path.sep).join('/') };
  return f;
}
