import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { childEnvironment, EMPTY_GLOBAL_GIT_CONFIG, executable } from '../lib/cso/process';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function homeWithGlobalConfig(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-git-global-'));
  roots.push(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = leaked-global\n');
  fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'git', 'config'), '[user]\n\temail = leaked@xdg.invalid\n');
  return home;
}

function gitConfig(home: string, env: Record<string, string>, args: string[]) {
  return spawnSync(executable('git'), ['config', ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
}

describe('CSO child Git reads no global or system config (#3082)', () => {
  test('uses the /dev/null spelling on every platform and keeps NOSYSTEM', () => {
    const env = childEnvironment(os.tmpdir());
    expect(EMPTY_GLOBAL_GIT_CONFIG).toBe('/dev/null');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  test('the fixture home is read when the override is absent', () => {
    const home = homeWithGlobalConfig();
    const { GIT_CONFIG_GLOBAL: _ignored, ...env } = childEnvironment(home);
    const result = gitConfig(home, env, ['--global', '--list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('user.name=leaked-global');
  });

  test('git config --global --list is empty and exits 0 under the CSO environment', () => {
    const home = homeWithGlobalConfig();
    const result = gitConfig(home, childEnvironment(home), ['--global', '--list']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('neither the home nor the XDG config reaches the merged view', () => {
    const home = homeWithGlobalConfig();
    const result = gitConfig(home, childEnvironment(home), ['--list']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('leaked');
  });
});
