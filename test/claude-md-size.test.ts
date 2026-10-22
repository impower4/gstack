/**
 * CLAUDE.md size tripwire (#2096). Claude Code loads the installed
 * ~/.claude/skills/gstack/CLAUDE.md into every session and warns when a
 * memory file exceeds 40,000 characters. Contributor-only detail belongs in
 * docs/ with a one-line pointer left in CLAUDE.md.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const CLAUDE_MD_LIMIT = 40_000;

const failure = (unit: string, count: number) =>
  `CLAUDE.md is ${count} ${unit}, over Claude Code's ${CLAUDE_MD_LIMIT}-character memory-file limit (#2096). ` +
  'Move contributor-only detail into a docs/ file (e.g. docs/CONTRIBUTOR_REFERENCE.md or docs/TESTING_INTERNALS.md) ' +
  'and leave a one-line pointer in CLAUDE.md.';

describe('CLAUDE.md size', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

  test('stays under 40,000 UTF-16 code units', () => {
    expect(text.length <= CLAUDE_MD_LIMIT, failure('UTF-16 code units', text.length)).toBe(true);
  });

  test('stays under 40,000 Unicode code points', () => {
    const codePoints = [...text].length;
    expect(codePoints <= CLAUDE_MD_LIMIT, failure('code points', codePoints)).toBe(true);
  });
});
