/**
 * Both transcript consent gates (setup-gbrain's transcript-gate section and
 * /sync-gbrain Step 1.6) run their rendered check block against every stored
 * value form: each valid form is recognized so a stored choice is never asked
 * again, and anything else is asked as "not recognized by this version".
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const CONFIG_BIN = join(ROOT, 'bin', 'gstack-config');
const GATES = {
  'setup-gbrain transcript gate': join(ROOT, 'setup-gbrain', 'sections', 'transcript-gate.md'),
  'sync-gbrain Step 1.6': join(ROOT, 'sync-gbrain', 'SKILL.md'),
};
const TS = '2026-10-03T17:00:00Z';
const RECOGNIZED = ['recent', 'all', 'off', 'recent+repos', 'all+repos', `new@${TS}`, `new@${TS}+repos`, ' Recent ', `NEW@${TS.toLowerCase()}+REPOS`];
const UNRECOGNIZED = ['A', 'incremental', 'new', 'off+repos', `recent@${TS}`, 'new@2026-10-03', `new@${TS}x`, 'yes'];

function gateBlock(file: string): string {
  const text = readFileSync(file, 'utf-8');
  const block = text.split('```bash\n').map((b) => b.split('\n```')[0]).find((b) => b.includes('has transcript_ingest_mode'));
  if (!block) throw new Error(`no transcript gate check block in ${file}`);
  return block.replaceAll('~/.claude/skills/gstack/bin/gstack-config', CONFIG_BIN);
}

function runGate(block: string, yaml: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'gstack-gate-'));
  try {
    if (yaml !== null) writeFileSync(join(root, 'config.yaml'), yaml);
    const r = spawnSync('bash', ['-c', block], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: root } });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('transcript consent gates recognize every value form', () => {
  for (const [name, file] of Object.entries(GATES)) {
    const block = gateBlock(file);

    test(`${name}: every stored grammar form is a choice, never re-asked`, () => {
      for (const value of RECOGNIZED) {
        const out = runGate(block, `transcript_ingest_mode: ${value}\ntranscript_repos: github.com/acme/app\n`);
        expect({ value, out }).toEqual({ value, out: `TRANSCRIPT_MODE: ${value.trim()} (repos: github.com/acme/app)` });
      }
    });

    test(`${name}: anything else is asked as not recognized by this version; absent is asked as not set`, () => {
      for (const value of UNRECOGNIZED) {
        const out = runGate(block, `transcript_ingest_mode: ${value}\n`);
        expect({ value, out }).toEqual({ value, out: `TRANSCRIPT_MODE: ask (stored value '${value}' is not recognized by this version)` });
      }
      expect(runGate(block, null)).toBe('TRANSCRIPT_MODE: ask (not set)');
    });

    test(`${name}: two questions, nothing stored until both are answered, scope before mode`, () => {
      const text = readFileSync(file, 'utf-8');
      expect(text).toContain('`new`');
      expect(text).toMatch(/second, separate question/i);
      expect(text).toMatch(/only this repo/i);
      expect(text).toMatch(/store nothing until\s+both answers are known/i);
      const scopeAt = text.indexOf('gstack-config set transcript_repos');
      const modeAt = text.indexOf('gstack-config set transcript_ingest_mode', scopeAt);
      expect(scopeAt).toBeGreaterThan(0);
      expect(modeAt).toBeGreaterThan(scopeAt);
      expect(text).toContain('gstack-config unset transcript_repos');
    });
  }
});
