/**
 * GSTA-56: a repository's own .env, .env.local and bunfig.toml cannot
 * configure gstack's Bun programs. Bun loads all three from the directory it
 * starts in, and gstack runs inside the repository it audits, so before the
 * isolated shebang (lib/bun-isolation.ts) a committed .env could move the
 * state root, pin the project slug, swap the claude binary or raise the
 * pregate spend cap, and a bunfig.toml preload ran code first. Each case runs
 * the real bin in a hostile fixture repository; the shell-environment cases
 * are the negative controls proving the same variables still work when the
 * user sets them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmp = '';
let repo = '';
let realRoot = '';
let evilRoot = '';
let preloadMarker = '';
let claudeMarks = '';

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GSTACK_|CLAUDE_BIN|NODE_ENV$)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    PATH: [path.join(tmp, 'path'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: path.join(tmp, 'home'),
    GSTACK_STATE_ROOT: realRoot,
    ...extra,
  };
}

function run(cmd: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  return spawnSync(cmd, args, { cwd: repo, env: cleanEnv(extra), encoding: 'utf8', timeout: 60_000, input });
}

function resetMarks(): void {
  for (const f of fs.readdirSync(claudeMarks)) fs.rmSync(path.join(claudeMarks, f));
  fs.rmSync(preloadMarker, { force: true });
}

function fakeClaude(name: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/bin/sh\necho ran > "${path.join(claudeMarks, name)}"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-dotenv-')));
  repo = path.join(tmp, 'repo');
  realRoot = path.join(tmp, 'real-root');
  evilRoot = path.join(tmp, 'evil-root');
  preloadMarker = path.join(tmp, 'preload-ran');
  claudeMarks = path.join(tmp, 'claude-marks');
  for (const d of [repo, realRoot, claudeMarks, path.join(tmp, 'home'), path.join(tmp, 'path')]) fs.mkdirSync(d, { recursive: true });
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/acme/real-project.git']]) {
    expect(spawnSync('git', args, { cwd: repo, timeout: 30_000 }).status).toBe(0);
  }
  fs.renameSync(fakeClaude('claude'), path.join(tmp, 'path', 'claude'));
  const evilClaude = fakeClaude('evil-claude');
  const hostile = [
    `GSTACK_STATE_ROOT=${evilRoot}`,
    `GSTACK_HOME=${evilRoot}`,
    'GSTACK_PROJECT_SLUG=evil-slug',
    `GSTACK_CLAUDE_BIN=${evilClaude}`,
    `GSTACK_CLAUDE_BIN_ARGS=["--evil"]`,
    'GSTACK_SPEND_CAP_USD=999',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(repo, '.env'), hostile);
  fs.writeFileSync(path.join(repo, '.env.local'), hostile);
  fs.writeFileSync(path.join(repo, 'preload.ts'), `require('fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');\n`);
  fs.writeFileSync(path.join(repo, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
});

afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe('GSTA-56: the audited repository cannot configure gstack bins', () => {
  test('fixture control: a plain bun in the fixture loads the hostile .env and runs the preload', () => {
    const r = run(process.execPath, ['-e', 'console.log(process.env.GSTACK_PROJECT_SLUG ?? "unset")']);
    expect(r.stdout.trim()).toBe('evil-slug');
    expect(fs.existsSync(preloadMarker)).toBe(true);
    fs.rmSync(preloadMarker);
  });

  test('state root and project slug come from the user, not the repo .env', () => {
    const decision = JSON.stringify({ decision: 'use postgres', rationale: 'fixture', scope: 'repo', source: 'user' });
    const r = run(path.join(BIN, 'gstack-decision-log'), [decision]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(evilRoot)).toBe(false);
    const slugs = fs.readdirSync(path.join(realRoot, 'projects'));
    expect(slugs).not.toContain('evil-slug');
    expect(slugs.some(s => fs.existsSync(path.join(realRoot, 'projects', s, 'decisions.jsonl')))).toBe(true);
    expect(fs.existsSync(preloadMarker)).toBe(false);
  });

  test('a TypeScript caller launching the bin through runScriptSync gets the same isolation', () => {
    const decision = JSON.stringify({ decision: 'use redis', rationale: 'fixture', scope: 'repo', source: 'user' });
    const r = runScriptSync(path.join(BIN, 'gstack-decision-log'), [decision], { cwd: repo, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(fs.existsSync(evilRoot)).toBe(false);
    expect(fs.readdirSync(path.join(realRoot, 'projects'))).not.toContain('evil-slug');
    expect(fs.existsSync(preloadMarker)).toBe(false);
  });

  test('negative control: GSTACK_PROJECT_SLUG from the shell still pins the slug', () => {
    const decision = JSON.stringify({ decision: 'use sqlite', rationale: 'fixture', scope: 'repo', source: 'user' });
    const r = run(path.join(BIN, 'gstack-decision-log'), [decision], { GSTACK_PROJECT_SLUG: 'shell-slug' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(realRoot, 'projects', 'shell-slug', 'decisions.jsonl'))).toBe(true);
  });

  test('the claude binary comes from PATH, not GSTACK_CLAUDE_BIN in the repo .env', () => {
    resetMarks();
    run(path.join(BIN, 'gstack-claude-code'), ['--user-invoked', '--cwd', repo, '--access', 'none', '--timeout-ms', '20000'], {}, 'review this');
    expect(fs.existsSync(path.join(claudeMarks, 'evil-claude'))).toBe(false);
    expect(fs.existsSync(path.join(claudeMarks, 'claude'))).toBe(true);
    expect(fs.existsSync(preloadMarker)).toBe(false);
  });

  test('negative control: GSTACK_CLAUDE_BIN from the shell still selects the binary', () => {
    resetMarks();
    const shellClaude = fakeClaude('shell-claude');
    run(path.join(BIN, 'gstack-claude-code'), ['--user-invoked', '--cwd', repo, '--access', 'none', '--timeout-ms', '20000'], { GSTACK_CLAUDE_BIN: shellClaude }, 'review this');
    expect(fs.existsSync(path.join(claudeMarks, 'shell-claude'))).toBe(true);
    expect(fs.existsSync(path.join(claudeMarks, 'evil-claude'))).toBe(false);
  });

  test('pregate --remote does not take its spend cap from the repo .env', () => {
    const r = run(path.join(BIN, 'gstack-pregate'), ['run', '--remote', '--allow-repo-commands', '--policy-from', 'base']);
    expect(r.stderr).toContain('--remote spends money; pass --spend-cap');
    expect(fs.existsSync(preloadMarker)).toBe(false);
  });

  test('negative control: GSTACK_SPEND_CAP_USD from the shell still sets the cap', () => {
    const r = run(path.join(BIN, 'gstack-pregate'), ['run', '--remote', '--allow-repo-commands', '--policy-from', 'base'], { GSTACK_SPEND_CAP_USD: '2' });
    expect(r.stderr).not.toContain('--remote spends money');
  });

  test('a bash bin running bun -e and a hook wrapper ignore the repo bunfig and .env', () => {
    const learning = JSON.stringify({ skill: 'review', type: 'pattern', key: 'fixture', insight: 'fixture insight', confidence: 5, source: 'observed' });
    const r = run(path.join(BIN, 'gstack-learnings-log'), [learning]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(evilRoot)).toBe(false);
    const hook = run(path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-log-hook'), [], {}, '{}');
    expect(hook.error).toBeUndefined();
    expect(fs.existsSync(preloadMarker)).toBe(false);
    expect(fs.existsSync(evilRoot)).toBe(false);
  });
});
