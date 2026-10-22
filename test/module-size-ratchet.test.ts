/**
 * Ratchet (c): refactor-wave owner modules stay <= 800 lines and <= 150 lines
 * per top-level function; residual files may not grow past their recorded
 * post-refactor size. Entries live in test/fixtures/module-size-ratchet.json;
 * the counter is test/helpers/module-size.ts (brace matching, no parser).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_FUNCTION_LINES,
  RATCHET_CONFIG,
  formatRatchetFailure,
  loadRatchetConfig,
  maskSource,
  measureFunctions,
  ratchetViolations,
  type RatchetConfig,
} from './helpers/module-size';

const ROOT = path.resolve(import.meta.dir, '..');
const readRepo = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** A function of bodyLines + 3 lines. */
const fn = (name: string, bodyLines: number) =>
  [`export function ${name}(value: number): number {`, ...Array.from({ length: bodyLines }, (_, i) => `  value += ${i};`), '  return value;', '}'].join('\n');
const withFiles = (files: Record<string, string>) => (file: string) => {
  if (!(file in files)) throw new Error(`unexpected read: ${file}`);
  return files[file];
};

describe('ratchet (c): module and function size', () => {
  test('refactor-wave modules and residual files hold their limits', () => {
    const config = loadRatchetConfig(ROOT);
    expect(config.newModules.length).toBeGreaterThan(0);
    const violations = ratchetViolations(config, readRepo);
    if (violations.length > 0) throw new Error(formatRatchetFailure(violations));
  });

  test('counter self-test: resolver template literals with ${} and code-fence braces', () => {
    const source = readRepo('test/fixtures/module-size/resolver-snippets.ts.txt');
    expect(measureFunctions(source).map(({ name, line, lines }) => ({ name, line, lines }))).toEqual([
      { name: 'generateDashboardLike', line: 6, lines: 17 },
      { name: 'generateDesignSketchLike', line: 24, lines: 11 },
      { name: 'arrowWithRegex', line: 36, lines: 2 },
      { name: 'handler', line: 40, lines: 4 },
    ]);
    const masked = maskSource(source);
    expect(masked.length).toBe(source.length);
    expect(masked.split('\n').length).toBe(source.split('\n').length);
    // Prose braces vanish; `${}` expression code stays measurable.
    expect(masked).not.toContain('{row and suffix}');
    expect(masked).not.toContain('unbalanced');
    expect(masked).toContain('toShellPath(ctx.paths.binDir)');
  });

  test('a planted 151-line function fails with file:line, the Fix and the allowlist path', () => {
    const config: RatchetConfig = { newModules: [{ file: 'planted.ts', movedFrom: 'test' }], residualFiles: [], allowlist: [] };
    const planted = `// header\n${fn('small', 3)}\n\n${fn('tooLong', MAX_FUNCTION_LINES - 2)}\n`;
    const violations = ratchetViolations(config, withFiles({ 'planted.ts': planted }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toStartWith('planted.ts:9  export function tooLong(value: number): number {');
    expect(violations[0]).toContain('151 lines > 150');
    const message = formatRatchetFailure(violations);
    expect(message).toContain('planted.ts:9');
    expect(message).toContain('Fix: split the module or function');
    expect(message).toContain(`Allowlist: ${RATCHET_CONFIG}`);
    expect(ratchetViolations(config, withFiles({ 'planted.ts': fn('atLimit', MAX_FUNCTION_LINES - 3) }))).toEqual([]);
  });

  test('oversized modules and grown residual files fail', () => {
    const config: RatchetConfig = {
      newModules: [{ file: 'big.ts', movedFrom: 'test' }],
      residualFiles: [{ file: 'residual.ts', maxLines: 3, reason: 'test' }],
      allowlist: [],
    };
    const violations = ratchetViolations(config, withFiles({
      'big.ts': `${'// line\n'.repeat(801)}`,
      'residual.ts': 'a\nb\nc\nd\n',
    }));
    expect(violations).toEqual([
      'big.ts:801  module has 801 lines > 800',
      'residual.ts:4  residual file grew to 4 lines > recorded 3',
    ]);
  });

  test('allowlist entries need a reason and are keyed on file plus matched text, not line numbers', () => {
    const long = fn('generatedTable', MAX_FUNCTION_LINES + 10);
    const entry = { file: 'table.ts', match: 'function generatedTable(' };
    const unreasoned: RatchetConfig = { newModules: [{ file: 'table.ts', movedFrom: 'test' }], residualFiles: [], allowlist: [entry] };
    const unreasonedViolations = ratchetViolations(unreasoned, withFiles({ 'table.ts': long }));
    expect(unreasonedViolations.some(v => v.includes('allowlist entry without a reason'))).toBe(true);
    expect(unreasonedViolations.some(v => v.includes('generatedTable'))).toBe(true);

    const allowed: RatchetConfig = { ...unreasoned, allowlist: [{ ...entry, reason: 'data table, not logic' }] };
    expect(ratchetViolations(allowed, withFiles({ 'table.ts': long }))).toEqual([]);
    expect(ratchetViolations(allowed, withFiles({ 'table.ts': `// inserted above the match\n\n${long}` }))).toEqual([]);
  });

  test('every committed allowlist entry and residual record carries a reason', () => {
    const config = loadRatchetConfig(ROOT);
    for (const entry of [...config.allowlist, ...config.residualFiles]) expect(entry.reason?.trim()).toBeTruthy();
  });
});
