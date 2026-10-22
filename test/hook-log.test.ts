/**
 * hosts/claude/hooks/hook-log.ts is the one hook-errors.log writer. All five
 * Claude Code hooks must log under the same resolved state root for the same
 * env, and the log must end up 0600 even when it already existed as 0644.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOKS = path.join(ROOT, 'hosts', 'claude', 'hooks');

function runHook(name: string, stdin: string, env: Record<string, string>, cwd: string) {
  return spawnSync('bash', [path.join(HOOKS, name)], {
    input: stdin,
    cwd,
    env: { ...process.env, GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '', CLAUDE_PLUGIN_DATA: '', ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('hook-log: one root, one mode', () => {
  test('all five hooks append to <resolved root>/hook-errors.log, and a 0644 log becomes 0600', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-log-'));
    try {
      const state = path.join(tmp, 'state');
      const home = path.join(tmp, 'home');
      const proj = path.join(tmp, 'hooklog-proj');
      fs.mkdirSync(state, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(proj, { recursive: true });
      const log = path.join(state, 'hook-errors.log');
      fs.writeFileSync(log, '');
      fs.chmodSync(log, 0o644);
      const env = { GSTACK_HOME: state, HOME: home };

      for (const hook of ['question-log-hook', 'question-preference-hook', 'auq-error-fallback-hook', 'memorable-user-prompt-hook']) {
        const r = runHook(hook, '{not json', env, proj);
        expect(r.status).toBe(0);
      }
      const slug = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-slug')], { cwd: proj, env: { ...process.env, ...env }, encoding: 'utf-8', timeout: 30_000 })
        .stdout.match(/^SLUG=(.+)$/m)?.[1];
      expect(slug).toBeTruthy();
      const timeline = path.join(state, 'projects', slug!, 'timeline.jsonl');
      fs.mkdirSync(path.dirname(timeline), { recursive: true });
      fs.writeFileSync(timeline, '');
      fs.truncateSync(timeline, 10 * 1024 * 1024 + 1);
      expect(runHook('timeline-stop-hook', JSON.stringify({ cwd: proj }), env, proj).status).toBe(0);

      const text = fs.readFileSync(log, 'utf-8');
      for (const hook of ['question-log-hook', 'question-preference-hook', 'auq-error-fallback-hook', 'memorable-user-prompt-hook', 'timeline-stop-hook']) {
        expect(text).toContain(` ${hook}: `);
      }
      expect(fs.existsSync(path.join(home, '.gstack', 'hook-errors.log'))).toBe(false);
      if (process.platform !== 'win32') expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rate limit drops a repeat key within the window and logs it again after', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-log-rl-'));
    const saved = process.env.GSTACK_HOME;
    process.env.GSTACK_HOME = tmp;
    try {
      const { logHookError, LOG_RATE_LIMIT_MS } = await import('../hosts/claude/hooks/hook-log');
      logHookError('rl-hook', 'first', { rateLimit: { nowMs: 1_000, key: 'k' } });
      logHookError('rl-hook', 'second', { rateLimit: { nowMs: 2_000, key: 'k' } });
      logHookError('rl-hook', 'third', { rateLimit: { nowMs: 1_000 + LOG_RATE_LIMIT_MS, key: 'k' } });
      logHookError('rl-hook', 'plain');
      const lines = fs.readFileSync(path.join(tmp, 'hook-errors.log'), 'utf-8').trim().split('\n');
      expect(lines.map((l) => l.split(': ')[1])).toEqual(['first', 'third', 'plain']);
    } finally {
      if (saved === undefined) delete process.env.GSTACK_HOME; else process.env.GSTACK_HOME = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
