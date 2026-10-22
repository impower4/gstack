import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { between } from './helpers/prompt-structure';

// #280 review changes to #3159: stdout stays a bare path (the $DESIGN-style
// API); a plan borrowed from another branch is disclosed on its own stderr
// line, and the skill tells the reviewer what to do with it.

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin/gstack-ceo-plan-find');
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(stateName = 'state') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-plan-xb-'));
  temps.push(dir);
  const home = path.join(dir, 'home');
  const state = path.join(dir, stateName);
  const plans = path.join(state, 'projects/proj/ceo-plans');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  const write = (name: string, header: string | null, ageSeconds: number) => {
    const file = path.join(plans, name);
    fs.writeFileSync(file, `# CEO Plan: Feature\n${header === null ? '' : `${header}\n`}Repo: acme/widgets\n`);
    const t = Date.now() / 1000 - ageSeconds;
    fs.utimesSync(file, t, t);
    return file;
  };
  const env = { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state };
  const find = (branch = 'feat-x') => {
    const r = spawnSync(BIN, ['proj', branch], { cwd: dir, env, encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { dir, home, state, write, env, find };
}

describe('gstack-ceo-plan-find cross-branch disclosure', () => {
  test('a plan for this branch prints only its path', () => {
    const f = fixture();
    const mine = f.write('2026-10-01-mine.md', 'Branch: feat/x | Mode: HOLD SCOPE', 500);
    f.write('2026-10-03-other.md', 'Branch: main | Mode: HOLD SCOPE', 10);
    expect(f.find()).toEqual({ status: 0, stdout: `${mine}\n`, stderr: '' });
  });

  test('a fallback plan keeps stdout a bare path and names its branch on stderr', () => {
    const f = fixture();
    const other = f.write('2026-10-03-other.md', 'Branch: main | Mode: HOLD SCOPE', 10);
    expect(f.find()).toEqual({ status: 0, stdout: `${other}\n`, stderr: `CEO plan found (from branch main, not feat-x): ${other}\n` });
  });

  test('a fallback plan without a Branch line says the branch is unknown', () => {
    const f = fixture();
    const headerless = f.write('2026-10-03-headerless.md', null, 10);
    expect(f.find().stderr).toBe(`CEO plan found (from branch unknown, not feat-x): ${headerless}\n`);
  });

  test('control characters in a plan header never reach the disclosure line', () => {
    const f = fixture();
    const other = f.write('2026-10-03-other.md', 'Branch: ma\x1b[31min\x07 | Mode: x', 10);
    const { stdout, stderr } = f.find();
    expect(stdout).toBe(`${other}\n`);
    expect(stderr).toBe(`CEO plan found (from branch ma[31min, not feat-x): ${other}\n`);
  });

  test("a state root containing a space and an apostrophe still resolves", () => {
    const f = fixture("it's state");
    const mine = f.write('2026-10-01-mine.md', 'Branch: feat-x | Mode: x', 10);
    expect(f.find()).toEqual({ status: 0, stdout: `${mine}\n`, stderr: '' });
  });
});

describe('plan-eng-review uses a cross-branch CEO plan only knowingly', () => {
  const rendered = fs.readFileSync(path.join(ROOT, 'plan-eng-review/SKILL.md'), 'utf8');
  const check = between(rendered, '### Design Doc Check', '### Step 0');

  test('the rendered block shows the disclosure next to the found line', () => {
    const at = check.indexOf('CEO_PLAN=$(~/.claude/skills/gstack/bin/gstack-ceo-plan-find');
    expect(at).toBeGreaterThanOrEqual(0);
    const block = check.slice(at).split('\n').slice(0, 2).join('\n');
    const f = fixture();
    const installed = path.join(f.home, '.claude/skills/gstack/bin');
    fs.mkdirSync(installed, { recursive: true });
    for (const bin of ['gstack-ceo-plan-find', 'gstack-paths', 'gstack-state-root.sh']) {
      fs.copyFileSync(path.join(ROOT, 'bin', bin), path.join(installed, bin));
      fs.chmodSync(path.join(installed, bin), 0o755);
    }
    const other = f.write('2026-10-03-other.md', 'Branch: main | Mode: HOLD SCOPE', 10);
    const r = spawnSync('bash', ['-c', `SLUG=proj; BRANCH=feat-x; {\n${block}\n} 2>&1`], { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 10_000 });
    expect(r.stdout.trim().split('\n')).toEqual([`CEO plan found (from branch main, not feat-x): ${other}`, `CEO plan found: ${other}`]);
  });

  test('interactive sessions ask before using it; spawned sessions use it and quote the disclosure', () => {
    const prose = check.replace(/\s+/g, ' ');
    expect(prose).toContain('If printed `from branch`, ask before using it; spawned sessions use it and quote that line.');
  });
});
