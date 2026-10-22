/**
 * #3169: README told users to paste a skill list into CLAUDE.md, and its two
 * copies were stale and disagreed. Claude Code lists installed skills itself,
 * so the docs keep only the /browse rule. If a comma-separated skill list
 * comes back in README.md or CLAUDE.md, it must name exactly the skills that
 * ship (the `name:` of every top-level SKILL.md).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const DOCS = ['README.md', 'CLAUDE.md'];

/** Every run of eight or more comma-separated `/skill` tokens, as a set of names. */
export function skillLists(text: string): string[][] {
  const flat = text.replace(/\s+/g, ' ');
  return [...flat.matchAll(/(?:\/[a-z0-9-]+, ?){7,}(?:and )?\/[a-z0-9-]+/g)].map(m => [...m[0].matchAll(/\/([a-z0-9-]+)/g)].map(n => n[1]!));
}

function shippedSkills(): string[] {
  const names = new Set<string>();
  for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const file = path.join(ROOT, dir.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const name = /^name:\s*(\S+)/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}

describe('skill lists in README.md and CLAUDE.md (#3169)', () => {
  test('the detector finds the kind of list README used to carry (negative control)', () => {
    const old = 'lists the available skills: /office-hours, /plan-ceo-review, /plan-eng-review,\n/plan-design-review, /design-consultation, /review, /ship, /qa, /browse, /learn. Then ask';
    expect(skillLists(old)).toEqual([['office-hours', 'plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'design-consultation', 'review', 'ship', 'qa', 'browse', 'learn']]);
    expect(skillLists('Use /browse for browsing; /qa or /qa-only for testing.')).toEqual([]);
  });

  test('any skill list present names exactly the shipped skills', () => {
    const shipped = shippedSkills();
    expect(shipped.length).toBeGreaterThan(40);
    for (const doc of DOCS) {
      for (const list of skillLists(fs.readFileSync(path.join(ROOT, doc), 'utf8'))) {
        const listed = [...new Set(list)].sort();
        expect({ doc, missing: shipped.filter(s => !listed.includes(s)), unknown: listed.filter(s => !shipped.includes(s)) })
          .toEqual({ doc, missing: [], unknown: [] });
      }
    }
  });

  test('README keeps the /browse rule for the CLAUDE.md gstack section', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('mcp__claude-in-chrome__*');
    expect(readme).toContain('Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.');
  });
});
