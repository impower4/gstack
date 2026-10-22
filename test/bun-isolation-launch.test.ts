/**
 * GSTA-56: each way gstack starts Bun keeps a hostile working directory's
 * .env and bunfig.toml out, on every platform the free lanes run, including
 * windows-latest under Git Bash. There MSYS rewrites --config=/dev/null to
 * --config=nul for the native bun.exe, which Bun 1.4.2 reads as an empty
 * config; a native Windows spawn has no /dev/null, so TypeScript callers use
 * bunIsolationArgs() (lib/bun-isolation.ts) instead of spelling the flag.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { bashCommandInvocation } from '../lib/script-invocation';

const PRINT = 'console.log("env=" + (process.env.GSTACK_LAUNCH_PROBE ?? "unset"))';
let project = '';
let preloadMarker = '';

function bash(command: string, extraEnv: Record<string, string> = {}) {
  const inv = bashCommandInvocation(command);
  if (!inv.ok) throw new Error(inv.error);
  return spawnSync(inv.cmd, inv.argv, { cwd: project, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...extraEnv } });
}

function expectIsolated(r: { status: number | null; stdout: string; stderr: string }, expected = 'env=unset') {
  expect(r.stderr.trim()).toBe('');
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(expected);
  expect(fs.existsSync(preloadMarker)).toBe(false);
}

beforeAll(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-launch-')));
  preloadMarker = path.join(project, 'preload-ran');
  fs.writeFileSync(path.join(project, '.env'), 'GSTACK_LAUNCH_PROBE=from-dotenv\n');
  fs.writeFileSync(path.join(project, 'preload.ts'), `require('fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');\n`);
  fs.writeFileSync(path.join(project, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
  fs.writeFileSync(path.join(project, 'probe.ts'), PRINT + '\n');
  fs.writeFileSync(path.join(project, 'shebang-probe'), `#!/usr/bin/env -S bun --no-env-file --config=/dev/null\n${PRINT}\n`);
  fs.chmodSync(path.join(project, 'shebang-probe'), 0o755);
});

afterAll(() => { if (project) fs.rmSync(project, { recursive: true, force: true }); });

describe('GSTA-56: isolated Bun launches on this platform', () => {
  test('control: a bare bun in the fixture loads its .env and runs its preload', () => {
    const r = spawnSync(process.execPath, ['probe.ts'], { cwd: project, encoding: 'utf8', timeout: 60_000 });
    expect(r.stdout).toContain('env=from-dotenv');
    expect(fs.existsSync(preloadMarker)).toBe(true);
    fs.rmSync(preloadMarker);
  });

  test('a script with the isolated shebang, executed from bash', () => {
    expectIsolated(bash('./shebang-probe'));
  });

  test('a bash caller spelling bun --no-env-file --config=/dev/null', () => {
    expectIsolated(bash(`bun --no-env-file --config=/dev/null -e '${PRINT}'`));
    expectIsolated(bash('bun --no-env-file --config=/dev/null run probe.ts'));
  });

  test('a TypeScript spawn with bunIsolationArgs()', () => {
    expectIsolated(spawnSync(process.execPath, [...bunIsolationArgs(), 'probe.ts'], { cwd: project, encoding: 'utf8', timeout: 60_000 }));
  });

  test("negative control: the user's shell environment still reaches an isolated launch", () => {
    expectIsolated(bash('./shebang-probe', { GSTACK_LAUNCH_PROBE: 'from-shell' }), 'env=from-shell');
  });
});
