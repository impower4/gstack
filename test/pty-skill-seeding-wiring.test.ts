/**
 * Tripwire for PTY slash-command skill seeding. Free tier — no API.
 *
 * The default hermetic config dir registers NO skills, so a PTY test that
 * TYPES a /skill slash command against it gets "Unknown command" before any
 * model turn — the test still runs, still spends money, and measures nothing.
 * Every test file that sends a slash command over the PTY must therefore
 * either route through a runPlanSkill* helper (which opts in for you) or pass
 * `seedSkills: true` in its own launchClaudePty options.
 *
 * The first check scans test sources for slash-command sends; the helper and
 * launcher checks run the real runners (fake PTY driver) and the real
 * launcher (fake CLI) instead of reading harness source text.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runPlanSkillObservation, runPlanSkillCounting, runPlanSkillFloorCheck, type PtyDriver } from './helpers/claude-pty-runner';
import { createFakePtyDriver } from './helpers/pty/fake-session';

const ROOT = path.resolve(import.meta.path, '..', '..');

/** A PTY send whose payload starts with a slash command (`/name`, optionally
 * followed by `\r`, whitespace, or the closing quote). A second slash right
 * after the name (a file path like '/tmp/x') does NOT match. */
const SLASH_SEND = /\.send\(\s*(['"`])\/[a-z][a-z0-9-]*(\\r|\s|\1)/;

const RUN_PLAN_HELPER = /\brunPlanSkill(Observation|Counting|FloorCheck)\s*\(/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('PTY skill-seeding tripwire', () => {
  test('every slash-command PTY test seeds skills (helper or seedSkills: true)', () => {
    const offenders: string[] = [];
    for (const full of testFiles(path.join(ROOT, 'test'))) {
      if (path.basename(full) === 'pty-skill-seeding-wiring.test.ts') continue;
      const src = fs.readFileSync(full, 'utf-8');
      const lines = src.split('\n');
      const sendLine = lines.findIndex((l) => SLASH_SEND.test(l));
      if (sendLine === -1) continue;
      if (RUN_PLAN_HELPER.test(src)) continue;
      if (src.includes('seedSkills: true')) continue;
      offenders.push(`${path.relative(ROOT, full)}:${sendLine + 1}`);
    }
    expect(
      offenders,
      'These tests type a /skill slash command into a hermetic PTY child that has ' +
        'no skills registered — claude rejects it as Unknown command and the test ' +
        'measures nothing. Pass seedSkills: true to launchClaudePty (or route ' +
        'through a runPlanSkill* helper): ' + offenders.join(', '),
    ).toEqual([]);
  });

  test('the runPlanSkill* helpers all opt in via seedSkills: true', async () => {
    // The helper family types slash commands on behalf of ~20 test files;
    // dropping the opt-in there silently un-measures all of them at once.
    // Each helper runs through the fake PTY driver (the child exits at once).
    const common = { skillName: 'plan-eng-review', slashCommand: '/plan-eng-review', followUpPrompt: '# Plan',
      isLastStep0AUQ: () => false, reviewCountCeiling: 1, timeoutMs: 20_000 };
    for (const run of [runPlanSkillObservation, runPlanSkillCounting, runPlanSkillFloorCheck] as Array<(opts: typeof common & { driver: PtyDriver }) => Promise<{ outcome: string }>>) {
      const fake = createFakePtyDriver({ frames: [{ screen: 'exiting', exit: 1 }] });
      await run({ ...common, driver: fake.driver });
      expect(fake.launches.map(opts => opts.seedSkills), run.name).toEqual([true]);
    }
  });

  test.skipIf(process.platform === 'win32')('launchClaudePty wires seedSkills to hermeticSkillsConfigDir()', () => {
    // Gated on hermetic (EVALS_HERMETIC=0 must keep the operator config) and
    // on the per-test env override (explicit CLAUDE_CONFIG_DIR wins). A fake
    // CLI reports the CLAUDE_CONFIG_DIR its real PTY launch received.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-seed-wiring-'));
    try {
      const fake = path.join(dir, 'fake-claude');
      fs.writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write('CFG=' + process.env.CLAUDE_CONFIG_DIR + ';');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
      const custom = path.join(dir, 'custom-config');
      const worker = path.join(dir, 'worker.ts');
      fs.writeFileSync(worker, `import { launchClaudePty } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href)};
import { hermeticSkillsConfigDir } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'test/helpers/hermetic-env.ts')).href)};
const seen = async (opts) => {
  const session = await launchClaudePty({ cwd: ${JSON.stringify(dir)}, timeoutMs: 5000, ...opts });
  try { await session.waitFor(/CFG=[^;]*;/, { timeoutMs: 4000, pollMs: 20 }); return /CFG=([^;]*);/.exec(session.visibleText())[1]; }
  finally { await session.close(); }
};
const result = { skills: hermeticSkillsConfigDir(), seeded: await seen({ seedSkills: true }),
  override: await seen({ seedSkills: true, env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(custom)} } }),
  unseeded: await seen({}) };
process.stdout.write(JSON.stringify(result));
`);
      const run = (hermetic: string) => {
        const result = spawnSync(process.execPath, [worker], { cwd: ROOT, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: hermetic } });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      };
      const hermetic = run('1');
      expect(hermetic.seeded).toBe(hermetic.skills);
      expect(hermetic.override).toBe(custom);
      expect(hermetic.unseeded).not.toBe(hermetic.skills);
      const operator = run('0');
      expect(operator.seeded).not.toBe(operator.skills);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
