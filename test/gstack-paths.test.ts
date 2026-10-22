import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-paths');

// Invoke via `bash` rather than executing the shebang-script directly.
// On Windows, spawnSync(scriptPath, ...) goes through CreateProcess, which
// doesn't parse `#!/usr/bin/env bash`. Production usage always sources the
// helper from inside a bash block (`eval "$(~/.claude/skills/gstack/bin/gstack-paths)"`)
// so bash is always the executor — this matches that contract.
//
// USERPROFILE: '' is a Windows-specific override. Git Bash auto-populates
// HOME from USERPROFILE at shell startup if HOME is unset/empty, which
// silently breaks the "HOME unset" test scenarios. Clearing USERPROFILE
// alongside HOME prevents that auto-population on Windows runners.
function run(env: Record<string, string | undefined>): Record<string, string> {
  const result = spawnSync('bash', [BIN], {
    env: { PATH: process.env.PATH, USERPROFILE: '', ...env } as Record<string, string>,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`gstack-paths failed (status ${result.status}): ${result.stderr}`);
  }
  const out: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe('gstack-paths', () => {
  test('GSTACK_HOME wins over CLAUDE_PLUGIN_DATA and HOME', () => {
    const got = run({
      GSTACK_HOME: '/tmp/explicit-state',
      CLAUDE_PLUGIN_DATA: '/tmp/plugin-data',
      HOME: '/tmp/home',
    });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/explicit-state');
  });

  test('CLAUDE_PLUGIN_DATA ignored when CLAUDE_PLUGIN_ROOT is absent or non-gstack', () => {
    // Without CLAUDE_PLUGIN_ROOT, falls through to HOME path.
    const noRoot = run({ CLAUDE_PLUGIN_DATA: '/tmp/plugin-data', HOME: '/tmp/home' });
    expect(noRoot.GSTACK_STATE_ROOT).toBe('/tmp/home/.gstack');

    // With a CLAUDE_PLUGIN_ROOT that doesn't contain "gstack" (e.g. the codex plugin),
    // still falls through to HOME path — this is the cross-plugin contamination scenario.
    const wrongRoot = run({
      CLAUDE_PLUGIN_DATA: '/tmp/codex-data',
      CLAUDE_PLUGIN_ROOT: '/tmp/openai-codex',
      HOME: '/tmp/home',
    });
    expect(wrongRoot.GSTACK_STATE_ROOT).toBe('/tmp/home/.gstack');
  });

  test('CLAUDE_PLUGIN_DATA respected when CLAUDE_PLUGIN_ROOT identifies gstack', () => {
    const got = run({
      CLAUDE_PLUGIN_DATA: '/tmp/gstack-plugin-data',
      CLAUDE_PLUGIN_ROOT: '/tmp/gstack-garrytan',
      HOME: '/tmp/home',
    });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/gstack-plugin-data');
  });

  test('HOME-derived state root when GSTACK_HOME and CLAUDE_PLUGIN_DATA unset', () => {
    const got = run({ HOME: '/tmp/myhome' });
    expect(got.GSTACK_STATE_ROOT).toBe('/tmp/myhome/.gstack');
  });

  test('CWD fallback when HOME also unset (container env)', () => {
    // Skip on Windows: Git Bash auto-derives HOME from USERPROFILE,
    // HOMEDRIVE, and HOMEPATH at shell startup. Even with all three
    // cleared, bash falls back to /c/Users/<user>. The container env
    // (HOME genuinely unset) is unreachable on Windows runners. The bash
    // script's CWD fallback IS correct — exercised on Linux/Mac CI.
    if (process.platform === 'win32') return;
    const got = run({ HOME: '' });
    expect(got.GSTACK_STATE_ROOT).toBe('.gstack');
  });

  test('PLAN_ROOT chain: GSTACK_PLAN_DIR > CLAUDE_PLANS_DIR > HOME > CWD', () => {
    expect(run({ GSTACK_PLAN_DIR: '/tmp/explicit', HOME: '/h' }).PLAN_ROOT).toBe('/tmp/explicit');
    expect(run({ CLAUDE_PLANS_DIR: '/tmp/claude', HOME: '/h' }).PLAN_ROOT).toBe('/tmp/claude');
    expect(run({ HOME: '/tmp/myhome' }).PLAN_ROOT).toBe('/tmp/myhome/.claude/plans');
    // CWD fallback only verifiable on POSIX — Git Bash auto-populates HOME.
    if (process.platform !== 'win32') {
      expect(run({ HOME: '' }).PLAN_ROOT).toBe('.claude/plans');
    }
  });

  test('TMP_ROOT chain: TMPDIR > TMP > .gstack/tmp', () => {
    expect(run({ TMPDIR: '/tmp/x', HOME: '/h' }).TMP_ROOT).toBe('/tmp/x');
    expect(run({ TMP: '/tmp/y', HOME: '/h' }).TMP_ROOT).toBe('/tmp/y');
    expect(run({ HOME: '' }).TMP_ROOT).toBe('.gstack/tmp');
  });

  test('emits all three exports on every invocation', () => {
    const got = run({ HOME: '/tmp/h' });
    expect(got).toHaveProperty('GSTACK_STATE_ROOT');
    expect(got).toHaveProperty('PLAN_ROOT');
    expect(got).toHaveProperty('TMP_ROOT');
  });

  // Regression: values must survive `eval "$(gstack-paths)"`, which is the
  // documented calling convention. A bare `echo` emits an unquoted RHS, so eval
  // re-parses it: backslashes become escapes and spaces become word separators.
  // On Windows $TMP is always a backslash path, so every skill that then runs
  // mktemp "$TMP_ROOT/..." fails and the bash block dies before doing any work.
  // These run identically on POSIX — the values are just strings.
  function evalRoundTrip(env: Record<string, string | undefined>, varName: string): string {
    const result = spawnSync(
      'bash',
      ['-c', `eval "$(bash "$1")"; printf '%s' "\${${varName}}"`, 'sh', BIN],
      {
        env: { PATH: process.env.PATH, USERPROFILE: '', ...env } as Record<string, string>,
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    if (result.status !== 0) {
      throw new Error(`eval round-trip failed (status ${result.status}): ${result.stderr}`);
    }
    return result.stdout;
  }

  // Values are POSIX-shaped on purpose: MSYS/Git Bash rewrites `C:\...` env
  // values to `/c/...` before bash sees them, so a literal Windows path would
  // assert the translation layer rather than the quoting. A backslash is a
  // backslash to eval either way, which is the behavior under test.
  test('eval round-trip preserves backslashes (#2374)', () => {
    // Skip on Windows: MSYS also rewrites backslashes to forward slashes in
    // env values, so a literal backslash cannot be injected through the
    // environment on a Git Bash runner. The escape-eating this guards against
    // is pure eval semantics, so exercising it on Linux/macOS CI is sufficient
    // — same reasoning as the HOME-unset skips above.
    if (process.platform === 'win32') return;
    const backslashed = '/tmp/back\\slash/dir';
    expect(evalRoundTrip({ TMPDIR: backslashed, HOME: '/h' }, 'TMP_ROOT')).toBe(backslashed);
  });

  test('eval round-trip preserves spaces (#2374)', () => {
    // Bare echo made eval word-split this, leaving the variable empty and
    // emitting `<second-word>: command not found`.
    const spaced = '/tmp/two words/dir';
    expect(evalRoundTrip({ TMPDIR: spaced, HOME: '/h' }, 'TMP_ROOT')).toBe(spaced);
  });

  test('eval round-trip preserves quotes, and leaves plain paths alone (#2374)', () => {
    expect(evalRoundTrip({ TMPDIR: "/tmp/o'brien", HOME: '/h' }, 'TMP_ROOT')).toBe("/tmp/o'brien");
    expect(evalRoundTrip({ GSTACK_HOME: '/tmp/state root' }, 'GSTACK_STATE_ROOT')).toBe(
      '/tmp/state root',
    );
    expect(evalRoundTrip({ HOME: '/tmp/myhome' }, 'PLAN_ROOT')).toBe('/tmp/myhome/.claude/plans');
  });

  test('output is shell-evalable: only KEY=VALUE lines, no extra prose', () => {
    const result = spawnSync('bash', [BIN], {
      env: { PATH: process.env.PATH, USERPROFILE: '', HOME: '/tmp/h' } as Record<string, string>,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const lines = result.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      expect(line).toMatch(/^[A-Z_]+=.*/);
    }
  });
});

// Skill bash blocks read one value with --get (#2763): worktree-isolated
// Claude Code sessions refuse eval/source but run NAME=$(literal --get NAME).
describe('gstack-paths --get', () => {
  function assignRoundTrip(env: Record<string, string | undefined>, name: string): { status: number | null; value: string; stderr: string } {
    const result = spawnSync('bash', ['-c', `V=$(bash "$1" --get ${name}); : "\${V:?gstack-paths failed}"; printf '%s' "$V"`, 'sh', BIN], {
      env: { PATH: process.env.PATH, USERPROFILE: '', ...env } as Record<string, string>,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { status: result.status, value: result.stdout, stderr: result.stderr };
  }
  const evalValue = (env: Record<string, string | undefined>, name: string) => spawnSync('bash', ['-c', `eval "$(bash "$1")"; printf '%s' "\${${name}}"`, 'sh', BIN], {
    env: { PATH: process.env.PATH, USERPROFILE: '', ...env } as Record<string, string>, encoding: 'utf-8', timeout: 30_000,
  }).stdout;

  test('each name matches the eval output, byte for byte', () => {
    const env = { GSTACK_HOME: '/tmp/state root', TMPDIR: '/tmp/two words/', HOME: "/tmp/o'brien" };
    for (const name of ['GSTACK_STATE_ROOT', 'PLAN_ROOT', 'TMP_ROOT']) {
      const got = assignRoundTrip(env, name);
      expect(got.status).toBe(0);
      expect(got.value).toBe(evalValue(env, name));
    }
    expect(assignRoundTrip(env, 'GSTACK_STATE_ROOT').value).toBe('/tmp/state root');
    expect(assignRoundTrip(env, 'TMP_ROOT').value).toBe('/tmp/two words');
  });

  test('a backslash path needs no quoting round-trip', () => {
    if (process.platform === 'win32') return; // MSYS rewrites backslashes in env values (see #2374 tests)
    expect(assignRoundTrip({ TMPDIR: '/tmp/back\\slash/dir', HOME: '/h' }, 'TMP_ROOT').value).toBe('/tmp/back\\slash/dir');
  });

  test('an unknown name is a usage error with empty stdout, so the caller guard fires', () => {
    const got = assignRoundTrip({ HOME: '/h' }, 'NOPE');
    expect(got.status).not.toBe(0);
    expect(got.value).toBe('');
    expect(got.stderr).toContain('usage: gstack-paths --get');
    expect(got.stderr).toContain('gstack-paths failed');
  });
});

describe('CEO plan persistence uses the selected state root', () => {
  for (const source of ['SKILL.md.tmpl', 'SKILL.md']) {
    for (const route of ['explicit', 'plugin', 'home'] as const) {
      test(`${source}: saved plan is discovered only in ${route} state across shells`, () => {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-state-path-'));
        try {
          const home = path.join(temporary, 'home');
          const explicit = path.join(temporary, "explicit state's directory");
          const plugin = path.join(temporary, 'plugin state');
          const selected = route === 'explicit' ? explicit : route === 'plugin' ? plugin : path.join(home, '.gstack');
          const expected = path.join(selected, 'projects', 'ceo-state-fixture', 'ceo-plans');
          fs.mkdirSync(home);
          const document = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', source), 'utf8');
          // Only the directory-preparation commands precede the plan-format fence.
          // Later review-loop Bash blocks are outside this path-resolution contract.
          const section = document.split('### 0H. Persist CEO Plan')[1]!.split('\n```markdown\n')[0]!;
          // Execute the shipped commands with only their installation paths
          // rebound, as the hermetic skill runtime does. No copied save logic.
          const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]!
            .replaceAll('~/.claude/skills/gstack/bin/gstack-slug', 'bash "$GSTACK_TEST_BIN/gstack-slug"')
            .replaceAll('~/.claude/skills/gstack/bin/gstack-paths', 'bash "$GSTACK_TEST_BIN/gstack-paths"'));
          expect(blocks).toHaveLength(1);
          const result = spawnSync('bash', ['-c', ['set -eu', ...blocks,
            'test -d "$EXPECTED_CEO_PLANS"',
            'printf "\\nCEO_STATE_VERIFIED\\n"',
          ].join('\n')], {
            cwd: temporary,
            env: { PATH: process.env.PATH, USERPROFILE: '', HOME: home,
              GSTACK_TEST_BIN: path.join(ROOT, 'bin'), GSTACK_PROJECT_SLUG: 'ceo-state-fixture',
              GSTACK_HOME: route === 'explicit' ? explicit : '',
              CLAUDE_PLUGIN_DATA: route === 'home' ? '' : plugin,
              CLAUDE_PLUGIN_ROOT: route === 'home' ? '' : '/plugins/gstack',
              TMPDIR: path.join(temporary, 'tmp'), EXPECTED_CEO_PLANS: expected },
            encoding: 'utf8', timeout: 10_000,
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stdout).toContain('CEO_STATE_VERIFIED');
          expect(fs.statSync(expected).isDirectory()).toBe(true);
          const printed = result.stdout.split('\n').find(line => line.startsWith('CEO_PLANS='))?.slice('CEO_PLANS='.length);
          expect(printed).toBeDefined();
          // A later tool receives the printed absolute path, not shell-local
          // CEO_PLANS. No executable archive example relies on that variable.
          const later = spawnSync('bash', ['-c', 'test "$1" = "$EXPECTED_CEO_PLANS" && test -d "$1"', 'sh', printed!], {
            env: { PATH: process.env.PATH, EXPECTED_CEO_PLANS: expected }, encoding: 'utf8', timeout: 10_000,
          });
          expect(later.error).toBeUndefined();
          expect(later.status).toBe(0);
          if (route !== 'home') expect(fs.existsSync(path.join(home, '.gstack', 'projects', 'ceo-state-fixture', 'ceo-plans'))).toBe(false);
          if (route === 'explicit') expect(fs.existsSync(path.join(plugin, 'projects', 'ceo-state-fixture', 'ceo-plans'))).toBe(false);

          const selectedPlan = path.join(expected, '2026-09-14-selected.md');
          fs.writeFileSync(selectedPlan, '# Selected CEO plan\n');
          // A more recent plan in a different root must not supersede the
          // selected root. Other projects cannot satisfy an empty lookup.
          const otherProject = path.join(selected, 'projects', 'another-project', 'ceo-plans');
          fs.mkdirSync(otherProject, { recursive: true });
          fs.writeFileSync(path.join(otherProject, '2099-other-project.md'), '# Other project\n');
          if (route !== 'home') {
            const legacy = path.join(home, '.gstack', 'projects', 'ceo-state-fixture', 'ceo-plans');
            fs.mkdirSync(legacy, { recursive: true });
            const decoy = path.join(legacy, '2099-wrong-root.md');
            fs.writeFileSync(decoy, '# Wrong root\n');
            fs.utimesSync(decoy, new Date('2099-01-01'), new Date('2099-01-01'));
          }
          const design = fs.readFileSync(path.join(ROOT, 'design-html', source), 'utf8')
            .split('## Step 0: Input Detection')[1]!.split('### Case A:')[0]!;
          const detectionBlocks = [...design.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]!);
          const ceoBlock = detectionBlocks.findIndex(block => block.includes('_CEO='));
          expect(ceoBlock).toBeGreaterThanOrEqual(0);
          // Execute actual input-detection commands through the CEO lookup,
          // including its existing slug setup, in a new Bash process.
          const reader = detectionBlocks.slice(0, ceoBlock + 1).join('\n')
            .replaceAll('~/.claude/skills/gstack/bin/gstack-slug', 'bash "$GSTACK_TEST_BIN/gstack-slug"')
            .replaceAll('~/.claude/skills/gstack/bin/gstack-paths', 'bash "$GSTACK_TEST_BIN/gstack-paths"');
          const readPlan = () => spawnSync('bash', ['-c', 'set -eu\n' + reader], {
            cwd: temporary,
            env: { PATH: process.env.PATH, USERPROFILE: '', HOME: home,
              GSTACK_TEST_BIN: path.join(ROOT, 'bin'), GSTACK_PROJECT_SLUG: 'ceo-state-fixture',
              GSTACK_HOME: route === 'explicit' ? explicit : '',
              CLAUDE_PLUGIN_DATA: route === 'home' ? '' : plugin,
              CLAUDE_PLUGIN_ROOT: route === 'home' ? '' : '/plugins/gstack',
              TMPDIR: path.join(temporary, 'tmp') },
            encoding: 'utf8', timeout: 10_000,
          });
          const discovered = readPlan();
          expect(discovered.error).toBeUndefined();
          expect(discovered.status).toBe(0);
          expect(discovered.stdout.trim()).toBe(`CEO_PLAN: ${selectedPlan}`);
          fs.unlinkSync(selectedPlan);
          const empty = readPlan();
          expect(empty.error).toBeUndefined();
          expect(empty.status).toBe(0);
          expect(empty.stdout.trim()).toBe('NO_CEO_PLAN');
        } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      });
    }
  }
});

describe('gstack-paths state-root contract (W1)', () => {
  const DOC = 'https://github.com/garrytan/gstack/blob/main/docs/state-root.md';
  function runRaw(args: string[], env: Record<string, string>, bin = BIN) {
    return spawnSync('bash', [bin, ...args], {
      env: { PATH: process.env.PATH, USERPROFILE: '', TMPDIR: os.tmpdir(), ...env } as Record<string, string>,
      encoding: 'utf-8',
      timeout: 30_000,
    });
  }

  test('GSTACK_STATE_ROOT and GSTACK_STATE_DIR join the chain in declared precedence', () => {
    expect(run({ HOME: '/tmp/home', GSTACK_STATE_ROOT: '/tmp/a', GSTACK_HOME: '/tmp/b' }).GSTACK_STATE_ROOT).toBe('/tmp/a');
    expect(run({ HOME: '/tmp/home', GSTACK_STATE_DIR: '/tmp/c' }).GSTACK_STATE_ROOT).toBe('/tmp/c');
    expect(run({ HOME: '/tmp/home', GSTACK_HOME: '/tmp/b', GSTACK_STATE_DIR: '/tmp/c' }).GSTACK_STATE_ROOT).toBe('/tmp/b');
    expect(run({ HOME: '/tmp/home', GSTACK_STATE_DIR: '/tmp/c', CLAUDE_PLUGIN_DATA: '/tmp/p', CLAUDE_PLUGIN_ROOT: '/x/gstack' }).GSTACK_STATE_ROOT).toBe('/tmp/c');
  });

  test('reading its own output back as input returns the same root', () => {
    const env = { HOME: '/tmp/home', GSTACK_HOME: '/tmp/b', GSTACK_STATE_DIR: '/tmp/c' };
    const first = run(env).GSTACK_STATE_ROOT;
    expect(run({ ...env, GSTACK_STATE_ROOT: first }).GSTACK_STATE_ROOT).toBe(first);
  });

  test('stderr is empty on success, even with disagreeing root variables', () => {
    const r = runRaw([], { HOME: '/tmp/home', GSTACK_STATE_ROOT: '/tmp/a', GSTACK_HOME: '/tmp/b', GSTACK_STATE_DIR: '/tmp/c' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  test('--explain golden: default environment', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-explain-'));
    try {
      const r = runRaw(['--explain'], { HOME: home, GSTACK_TEST_LEGACY_ROOT: '' });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe([
        `state root: ${home}/.gstack (selected by default)`,
        'chain (first non-empty wins):',
        '  GSTACK_STATE_ROOT    unset',
        '  GSTACK_HOME          unset',
        '  GSTACK_STATE_DIR     unset',
        '  CLAUDE_PLUGIN_DATA   unset',
        `  default              ${home}/.gstack  selected`,
        'merged privacy keys (most restrictive value across roots wins):',
        '  telemetry:        not set (default applies)',
        '  memorable_recall: not set (default applies)',
        '  codex_reviews:    not set (default applies)',
        '  update_check:     not set (default applies)',
        `docs: ${DOC}`,
        '',
      ].join('\n'));
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('--explain golden: disagreeing environment with state in $HOME/.gstack', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-explain-'));
    const home = path.join(tmp, 'home');
    const a = path.join(tmp, 'a');
    try {
      fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), 'telemetry: off\ncodex_reviews: disabled\n');
      fs.mkdirSync(a);
      fs.writeFileSync(path.join(a, 'config.yaml'), 'telemetry: community\nupdate_check: true\n');
      const r = runRaw(['--explain'], {
        HOME: home, GSTACK_TEST_LEGACY_ROOT: '', GSTACK_STATE_ROOT: a, GSTACK_HOME: '/tmp/b',
        CLAUDE_PLUGIN_DATA: '/tmp/p', CLAUDE_PLUGIN_ROOT: '/plugins/codex',
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe([
        `state root: ${a} (selected by GSTACK_STATE_ROOT)`,
        'chain (first non-empty wins):',
        `  GSTACK_STATE_ROOT    ${a}  selected`,
        '  GSTACK_HOME          /tmp/b  ignored',
        '  GSTACK_STATE_DIR     unset',
        '  CLAUDE_PLUGIN_DATA   /tmp/p  ignored',
        `  default              ${home}/.gstack  ignored`,
        `default root ${home}/.gstack also holds gstack state: yes`,
        'merged privacy keys (most restrictive value across roots wins):',
        `  telemetry:        off (from ${home}/.gstack/config.yaml)`,
        '  memorable_recall: not set (default applies)',
        `  codex_reviews:    disabled (from ${home}/.gstack/config.yaml)`,
        `  update_check:     true (from ${a}/config.yaml)`,
        `docs: ${DOC}`,
        '',
      ].join('\n'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a missing bin/gstack-state-root.sh fails stop: nonzero, empty stdout, message, no writes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-paths-broken-'));
    try {
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      fs.copyFileSync(BIN, path.join(bin, 'gstack-paths'));
      const tmpRoot = path.join(tmp, 'tmproot');
      const r = runRaw([], { HOME: path.join(tmp, 'home'), TMPDIR: tmpRoot }, path.join(bin, 'gstack-paths'));
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('gstack-paths: cannot resolve the gstack state root');
      expect(r.stderr).toContain(path.join(bin, 'gstack-state-root.sh'));
      expect(r.stderr).toContain('./setup');
      expect(r.stderr).toContain('/gstack-upgrade');
      expect(r.stderr).toContain(DOC);
      expect(fs.readdirSync(tmp).sort()).toEqual(['bin']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
