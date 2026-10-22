/**
 * --plan-mode=off end to end through the generator, Claude host (#3168).
 *
 * Default output must stay byte-identical to the committed SKILL.md files.
 * With planMode false, every skill that carries the preamble's
 * "## Plan Mode Safe Operations" and "## Skill Invocation During Plan Mode"
 * sections loses exactly those two sections and nothing else; skills
 * without them are unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const SAFE = '## Plan Mode Safe Operations\n';
const INVOCATION = '## Skill Invocation During Plan Mode\n\n';

let tmp: string;
let skills: string[];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-mode-gen-'));
  const on = await runGeneration({ host: 'claude', outputRoot: path.join(tmp, 'on'), contentLinkRoot: null });
  const off = await runGeneration({ host: 'claude', outputRoot: path.join(tmp, 'off'), contentLinkRoot: null, planMode: false });
  expect(on.exitCode).toBe(0);
  expect(off.exitCode).toBe(0);
  skills = on.artifacts.filter(a => a.kind === 'skill').map(a => a.relativePath);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/** The committed text with the two plan-mode sections (each heading plus one paragraph) cut out. */
function withoutPlanMode(text: string): string {
  const start = text.indexOf(SAFE);
  const invocation = text.indexOf(INVOCATION, start);
  expect(invocation).toBeGreaterThan(start);
  const end = text.indexOf('\n\n', invocation + INVOCATION.length) + 2;
  return text.slice(0, start) + text.slice(end);
}

describe('gen-skill-docs --plan-mode=off (claude host)', () => {
  test('default output is byte-identical to every committed SKILL.md', () => {
    expect(skills.length).toBeGreaterThan(40);
    for (const rel of skills) expect(read(path.join(tmp, 'on'), rel), rel).toBe(read(ROOT, rel));
  });

  test('off drops exactly the two plan-mode sections and leaves other skills untouched', () => {
    let stripped = 0;
    for (const rel of skills) {
      const committed = read(ROOT, rel);
      const off = read(path.join(tmp, 'off'), rel);
      expect(off, rel).not.toContain(SAFE);
      expect(off, rel).not.toContain('## Skill Invocation During Plan Mode');
      if (!committed.includes(SAFE)) {
        expect(off, rel).toBe(committed);
        continue;
      }
      expect(off, rel).toBe(withoutPlanMode(committed));
      stripped++;
    }
    expect(stripped).toBeGreaterThan(40);
    expect(read(path.join(tmp, 'off'), 'SKILL.md')).toContain('PLAN MODE EXCEPTION');
  });

  test('the CLI flag parses: --plan-mode=off renders without the sections, an unknown value is refused', () => {
    const cli = (...args: string[]) => spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', 'claude', ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    const out = path.join(tmp, 'cli');
    const ok = cli('--out-dir', out, '--plan-mode=off');
    expect(ok.status, ok.stderr).toBe(0);
    expect(read(out, 'SKILL.md')).toBe(read(path.join(tmp, 'off'), 'SKILL.md'));
    expect(read(out, 'review/SKILL.md')).not.toContain(SAFE);
    const bad = cli('--out-dir', path.join(tmp, 'bad'), '--plan-mode=maybe');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("Unknown plan mode: maybe. Use 'on' or 'off'.");
  });
});
