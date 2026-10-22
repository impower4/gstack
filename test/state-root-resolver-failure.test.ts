/**
 * Resolver failure is fail-stop (W1). With bin/gstack-state-root.sh removed
 * from an install, a real bash block copied from a generated SKILL.md and a
 * migrated executable both stop with the reinstall message, and nothing is
 * written outside the test's temp root.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStateRoot } from '../lib/state-root';

const ROOT = path.resolve(import.meta.dir, '..');

/** The Eureka ```bash block of a generated SKILL.md: it resolves the state root through gstack-paths. */
function eurekaBlock(): string {
  const md = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
  const start = md.indexOf('**Eureka:**');
  const open = md.indexOf('```bash\n', start) + '```bash\n'.length;
  return md.slice(open, md.indexOf('\n```', open));
}

/** Every path under dir, except a host git wrapper's own log dir (not gstack's). */
function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.capy') continue;
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...listTree(p));
  }
  return out;
}

describe('state-root resolver failure', () => {
  test('a generated SKILL.md block and a migrated bin stop with the reinstall message when the twin is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-resolver-fail-'));
    try {
      const home = path.join(tmp, 'home');
      const bin = path.join(home, '.claude', 'skills', 'gstack', 'bin');
      const cwd = path.join(tmp, 'cwd');
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(cwd);
      for (const b of ['gstack-paths', 'gstack-slug', 'gstack-config', 'gstack-context-recovery']) {
        fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(bin, b));
        fs.chmodSync(path.join(bin, b), 0o755);
      }
      const env = {
        PATH: process.env.PATH ?? '', HOME: home, TMPDIR: path.join(tmp, 'tmp'),
        GSTACK_HOME: '', GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '', CLAUDE_PLUGIN_DATA: '',
      };
      expect(resolveStateRoot(env)).toBe(`${home}/.gstack`);
      const before = listTree(tmp).sort();

      const block = eurekaBlock();
      expect(block).toContain('GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"');
      const skill = spawnSync('bash', ['-c', block + '\necho REACHED_END'], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
      expect(skill.status).not.toBe(0);
      expect(skill.stderr).toContain('gstack-paths failed; reinstall with ./setup or /gstack-upgrade');
      expect(skill.stdout).not.toContain('REACHED_END');

      const recovery = spawnSync('bash', [path.join(bin, 'gstack-context-recovery')], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
      expect(recovery.status).toBe(1);
      expect(recovery.stdout).toBe('');
      expect(recovery.stderr).toContain('reinstall with ./setup or /gstack-upgrade');

      const config = spawnSync('bash', [path.join(bin, 'gstack-config'), 'set', 'telemetry', 'off'], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
      expect(config.status).toBe(1);
      expect(config.stderr).toContain('cannot resolve the gstack state root');
      expect(config.stderr).toContain('reinstall with ./setup or /gstack-upgrade');

      expect(listTree(tmp).sort()).toEqual(before);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
