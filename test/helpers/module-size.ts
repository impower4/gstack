/**
 * Ratchet (c) counter: file and top-level function lengths by brace
 * matching, with no parser dependency. Strings, comments, regex literals and
 * template-literal text are masked first (template `${}` expressions stay
 * code), so braces inside generated prose or code fences never count.
 * Functions = function declarations and arrow/function expressions assigned
 * to top-level consts, plus route-table `handler` properties at any depth.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_MODULE_LINES = 800;
export const MAX_FUNCTION_LINES = 150;
export const RATCHET_CONFIG = 'test/fixtures/module-size-ratchet.json';

export interface FunctionSpan { name: string; line: number; lines: number; match: string }

const REGEX_AFTER_PUNCTUATION = '(,=:[!&|?{};+-*%<>~^';
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

/** Same length as `source`, newlines kept; non-code characters become spaces. */
export function maskSource(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // A masked literal leaves an operand placeholder, so a following `/` reads as division.
  const literal = (from: number, to: number) => {
    blank(from, to);
    if (to > from && out[to - 1] !== '\n') out[to - 1] = '0';
  };
  const regexAllowed = (at: number) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    if (j < 0) return true;
    if (/[\w$]/.test(out[j])) {
      let k = j;
      while (k >= 0 && /[\w$]/.test(out[k])) k -= 1;
      return REGEX_AFTER_WORD.has(out.slice(k + 1, j + 1).join(''));
    }
    return REGEX_AFTER_PUNCTUATION.includes(out[j]);
  };
  const templateDepth: number[] = [];
  let i = 0;
  const inTemplateText = () => templateDepth.length > 0 && templateDepth[templateDepth.length - 1] < 0;
  while (i < source.length) {
    if (inTemplateText()) {
      const start = i;
      while (i < source.length && source[i] !== '`' && !(source[i] === '$' && source[i + 1] === '{')) i += source[i] === '\\' ? 2 : 1;
      blank(start, i);
      if (source[i] === '`') { out[i] = '0'; templateDepth.pop(); i += 1; continue; }
      blank(i, i + 2);
      templateDepth[templateDepth.length - 1] = 0;
      i += 2;
      continue;
    }
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end < 0 ? source.length : end + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      literal(start, Math.min(i, source.length));
      continue;
    }
    if (ch === '`') {
      out[i] = ' ';
      templateDepth.push(-1);
      i += 1;
      continue;
    }
    if (ch === '/' && regexAllowed(i)) {
      const start = i;
      let inClass = false;
      i += 1;
      while (i < source.length && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      while (/[a-z]/i.test(source[i] ?? '')) i += 1;
      literal(start, i);
      continue;
    }
    if (templateDepth.length > 0) {
      if (ch === '{') templateDepth[templateDepth.length - 1] += 1;
      if (ch === '}') {
        if (templateDepth[templateDepth.length - 1] === 0) {
          out[i] = ' ';
          templateDepth[templateDepth.length - 1] = -1;
          i += 1;
          continue;
        }
        templateDepth[templateDepth.length - 1] -= 1;
      }
    }
    i += 1;
  }
  return out.join('');
}

const OPEN = '([{';
const CLOSE = ')]}';
const CONTINUES = /^(?:[{([.?:=|&,<>+\-*/%]|=>)/;

/** Index just past the end of the expression or statement that starts at `from` (depth-relative). */
function spanEnd(masked: string, from: number, stopAtComma: boolean): number {
  let depth = 0;
  for (let k = from; k < masked.length; k += 1) {
    const ch = masked[k];
    if (OPEN.includes(ch)) depth += 1;
    else if (CLOSE.includes(ch)) {
      depth -= 1;
      if (depth < 0) return k;
      if (depth === 0) {
        const rest = masked.slice(k + 1).trimStart();
        if (stopAtComma ? /^[,}\]]/.test(rest) || !CONTINUES.test(rest) : !CONTINUES.test(rest)) return k + 1;
      }
    } else if (depth === 0 && (ch === ';' || (stopAtComma && ch === ','))) return k;
  }
  return masked.length;
}

const lineAt = (source: string, index: number) => source.slice(0, index).split('\n').length;

function looksLikeFunction(masked: string, valueStart: number): boolean {
  const rest = masked.slice(valueStart).replace(/^\s*async\b/, '').trimStart();
  if (/^function\b/.test(rest) || /^[A-Za-z_$][\w$]*\s*=>/.test(rest)) return true;
  const open = rest.startsWith('<') ? rest.indexOf('(') : rest.startsWith('(') ? 0 : -1;
  if (open < 0) return false;
  let depth = 0;
  let close = open;
  for (; close < rest.length; close += 1) {
    if (OPEN.includes(rest[close])) depth += 1;
    else if (CLOSE.includes(rest[close]) && --depth === 0) break;
  }
  return /^\s*(?::[^;]*?)?=>/.test(rest.slice(close + 1));
}

export function measureFunctions(source: string): FunctionSpan[] {
  const masked = maskSource(source);
  const depthAt: number[] = new Array(masked.length);
  let depth = 0;
  for (let k = 0; k < masked.length; k += 1) {
    depthAt[k] = depth;
    if (OPEN.includes(masked[k])) depth += 1;
    else if (CLOSE.includes(masked[k])) depth = Math.max(0, depth - 1);
  }
  const spans: FunctionSpan[] = [];
  const record = (name: string, start: number, end: number) => {
    const line = lineAt(source, start);
    spans.push({ name, line, lines: lineAt(source, Math.max(start, end - 1)) - line + 1,
      match: source.slice(start, source.indexOf('\n', start) < 0 ? undefined : source.indexOf('\n', start)).trim() });
  };
  const declaration = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/gm;
  for (const m of masked.matchAll(declaration)) {
    const start = m.index! + m[0].length - m[0].trimStart().length;
    if (depthAt[start] === 0) record(m[1] ?? 'default', start, spanEnd(masked, start, false));
  }
  const assigned = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^=\n]*?=(?!=)/gm;
  for (const m of masked.matchAll(assigned)) {
    const start = m.index! + m[0].length - m[0].trimStart().length;
    if (depthAt[start] === 0 && looksLikeFunction(masked, m.index! + m[0].length)) record(m[1], start, spanEnd(masked, start, false));
  }
  for (const m of masked.matchAll(/\bhandler\s*(?::|(?=\())/g)) {
    record('handler', m.index!, spanEnd(masked, m.index!, true));
  }
  return spans.sort((a, b) => a.line - b.line);
}

export interface RatchetConfig {
  newModules: Array<{ file: string; movedFrom: string }>;
  residualFiles: Array<{ file: string; maxLines: number; reason: string }>;
  allowlist: Array<{ file: string; match: string; reason?: string }>;
}

export function countLines(source: string): number {
  return source.length === 0 ? 0 : source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

/** Every violation as `file:line  <matched text>`; empty when the ratchet holds. */
export function ratchetViolations(config: RatchetConfig, read: (file: string) => string): string[] {
  const violations: string[] = [];
  for (const entry of config.allowlist) {
    if (!entry.reason?.trim()) violations.push(`${RATCHET_CONFIG}:0  allowlist entry without a reason: ${entry.file} "${entry.match}"`);
  }
  for (const { file } of config.newModules) {
    const source = read(file);
    const lines = countLines(source);
    if (lines > MAX_MODULE_LINES) violations.push(`${file}:${lines}  module has ${lines} lines > ${MAX_MODULE_LINES}`);
    for (const span of measureFunctions(source)) {
      if (span.lines <= MAX_FUNCTION_LINES) continue;
      if (config.allowlist.some(entry => entry.file === file && entry.reason?.trim() && span.match.includes(entry.match))) continue;
      violations.push(`${file}:${span.line}  ${span.match}  (${span.name}: ${span.lines} lines > ${MAX_FUNCTION_LINES})`);
    }
  }
  for (const { file, maxLines } of config.residualFiles) {
    const lines = countLines(read(file));
    if (lines > maxLines) violations.push(`${file}:${lines}  residual file grew to ${lines} lines > recorded ${maxLines}`);
  }
  return violations;
}

export function formatRatchetFailure(violations: string[]): string {
  return [
    `Ratchet (c) — module and function size — ${violations.length} violation(s):`,
    ...violations.map(violation => `  ${violation}`),
    `Rule: refactor-wave owner modules stay at or under ${MAX_MODULE_LINES} lines and ${MAX_FUNCTION_LINES} lines per top-level function, and residual files may not grow past their post-refactor size, because oversized files and functions are where this code kept drifting.`,
    'Fix: split the module or function — move a cohesive step into its own named function or a sibling module; for a residual file, put new code in its owner module instead.',
    `Allowlist: ${RATCHET_CONFIG} ("allowlist": { file, match, reason }, keyed on file plus matched text) — legitimate only for a data table or generated literal whose length is not logic; every entry needs a reason.`,
  ].join('\n');
}

export function loadRatchetConfig(root: string): RatchetConfig {
  return JSON.parse(fs.readFileSync(path.join(root, RATCHET_CONFIG), 'utf8')) as RatchetConfig;
}
