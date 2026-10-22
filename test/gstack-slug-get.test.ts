/**
 * `gstack-slug --get NAME` (#2763): skill bash blocks read one raw value with
 * a plain assignment, because worktree-isolated Claude Code sessions refuse
 * `eval "$(gstack-slug)"`. Each value must equal what the eval form sets.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.join(path.resolve(import.meta.dir, '..'), 'bin', 'gstack-slug');

function sh(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync('bash', ['-c', script, 'sh', BIN], {
    cwd, encoding: 'utf-8', timeout: 30_000,
    env: { PATH: process.env.PATH ?? '', USERPROFILE: '', ...env },
  });
}

describe('gstack-slug --get', () => {
  test('SLUG, BRANCH and the identity fields equal the eval values, including a root with spaces', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gslug-get-'));
    const repo = path.join(tmp, 'my repo');
    try {
      fs.mkdirSync(repo);
      const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8', timeout: 30_000 });
      expect(git('init', '-q', '-b', 'feat/get-mode').status).toBe(0);
      expect(git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init').status).toBe(0);
      expect(git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git').status).toBe(0);
      const env = { HOME: path.join(tmp, 'home'), GSTACK_HOME: path.join(tmp, 'state') };
      const evaluated = sh('eval "$("$1" --identity)"; printf "%s\\n" "$SLUG" "$BRANCH" "$PROJECT_REMOTE" "$PROJECT_ROOT" "$LEGACY_SLUG"', repo, env);
      expect(evaluated.status, evaluated.stderr).toBe(0);
      const [slug, branch, remote, root, legacy] = evaluated.stdout.split('\n');
      expect(slug).toBe('acme-widgets');
      expect(branch).toBe('feat-get-mode');
      expect(root).toBe(fs.realpathSync(repo));
      const want: Record<string, string> = { SLUG: slug!, BRANCH: branch!, PROJECT_REMOTE: remote!, PROJECT_ROOT: root!, LEGACY_SLUG: legacy! };
      for (const [name, value] of Object.entries(want)) {
        const got = sh(`V=$("$1" --get ${name}) || exit 9; printf '%s' "$V"`, repo, env);
        expect(got.status, `${name}: ${got.stderr}`).toBe(0);
        expect(got.stdout, name).toBe(value);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the GSTACK_PROJECT_SLUG pin applies, and an unknown name is a usage error with empty stdout', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gslug-get-'));
    try {
      const env = { HOME: tmp, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_PROJECT_SLUG: 'pinned-slug' };
      expect(sh('"$1" --get SLUG', tmp, env).stdout).toBe('pinned-slug\n');
      const bad = sh('"$1" --get NOPE', tmp, env);
      expect(bad.status).toBe(2);
      expect(bad.stdout).toBe('');
      expect(bad.stderr).toContain('usage: gstack-slug --get');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
