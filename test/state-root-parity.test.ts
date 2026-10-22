/**
 * Parity: lib/state-root.ts (TS) and bin/gstack-state-root.sh (bash) are the
 * two owners of the one state-root chain. Every row runs through both with an
 * empty PATH (the bash twin must use builtins only — hooks call it on every
 * tool use) and must produce byte-identical roots and config readings.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStateRoot, readConfigKey } from '../lib/state-root';

const ROOT = path.resolve(import.meta.dir, '..');
const TWIN = path.join(ROOT, 'bin', 'gstack-state-root.sh').replace(/\\/g, '/');
const BASH = Bun.which('bash') ?? '/bin/bash';

type Row = { name: string; env: Record<string, string>; win?: boolean };

// On a Windows host the MSYS runtime fills HOME before Git Bash starts, so a
// row that leaves HOME unset or empty reaches the bash twin with the runtime's
// HOME. Those rows compare both twins under the HOME the child actually saw;
// the unset-HOME branches themselves are covered on POSIX hosts.
const HOST_FILLS_HOME = process.platform === 'win32';

function bashEval(row: Row, body: string): { out: string; home: string } {
  const ostype = row.win ? 'msys' : 'linux-gnu';
  const r = spawnSync(BASH, ['-c', `OSTYPE=${ostype}; printf '%s\\0' "\${HOME-}"; . "${TWIN}" && ${body}`], {
    env: { USERPROFILE: '', ...row.env, PATH: '' },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (r.status !== 0) throw new Error(`bash twin failed for ${row.name}: ${r.stderr}`);
  const split = r.stdout.indexOf('\0');
  return { home: r.stdout.slice(0, split), out: r.stdout.slice(split + 1) };
}

function tsEnv(row: Row, childHome: string): Record<string, string> {
  const env: Record<string, string> = { USERPROFILE: '', ...row.env };
  if (HOST_FILLS_HOME && !row.env.HOME) env.HOME = childHome;
  return env;
}

const A = '/state/a', B = '/state/b', C = '/state/c';
const rootRows: Row[] = [
  { name: 'nothing set, HOME set', env: { HOME: '/home/u' } },
  { name: 'GSTACK_STATE_ROOT alone', env: { HOME: '/home/u', GSTACK_STATE_ROOT: A } },
  { name: 'GSTACK_HOME alone', env: { HOME: '/home/u', GSTACK_HOME: B } },
  { name: 'GSTACK_STATE_DIR alone', env: { HOME: '/home/u', GSTACK_STATE_DIR: C } },
  { name: 'STATE_ROOT + HOME differ', env: { HOME: '/home/u', GSTACK_STATE_ROOT: A, GSTACK_HOME: B } },
  { name: 'STATE_ROOT + STATE_DIR differ', env: { HOME: '/home/u', GSTACK_STATE_ROOT: A, GSTACK_STATE_DIR: C } },
  { name: 'GSTACK_HOME + STATE_DIR differ', env: { HOME: '/home/u', GSTACK_HOME: B, GSTACK_STATE_DIR: C } },
  { name: 'all three differ', env: { HOME: '/home/u', GSTACK_STATE_ROOT: A, GSTACK_HOME: B, GSTACK_STATE_DIR: C } },
  { name: 'plugin data with gstack plugin root', env: { HOME: '/home/u', CLAUDE_PLUGIN_DATA: '/plug', CLAUDE_PLUGIN_ROOT: '/plugins/gstack' } },
  { name: 'plugin data with mixed-case gstack root', env: { HOME: '/home/u', CLAUDE_PLUGIN_DATA: '/plug', CLAUDE_PLUGIN_ROOT: '/plugins/GStack-1.2' } },
  { name: 'plugin data with foreign plugin root', env: { HOME: '/home/u', CLAUDE_PLUGIN_DATA: '/plug', CLAUDE_PLUGIN_ROOT: '/plugins/codex' } },
  { name: 'plugin data without plugin root', env: { HOME: '/home/u', CLAUDE_PLUGIN_DATA: '/plug' } },
  { name: 'GSTACK_STATE_DIR beats plugin data', env: { HOME: '/home/u', GSTACK_STATE_DIR: C, CLAUDE_PLUGIN_DATA: '/plug', CLAUDE_PLUGIN_ROOT: '/plugins/gstack' } },
  { name: 'empty strings count as unset', env: { HOME: '/home/u', GSTACK_STATE_ROOT: '', GSTACK_HOME: '', GSTACK_STATE_DIR: '', CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '' } },
  { name: 'empty STATE_ROOT falls to GSTACK_HOME', env: { HOME: '/home/u', GSTACK_STATE_ROOT: '', GSTACK_HOME: B } },
  { name: 'empty plugin data with gstack root', env: { HOME: '/home/u', CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '/plugins/gstack' } },
  { name: 'unset HOME', env: {} },
  { name: 'empty HOME', env: { HOME: '' } },
  { name: 'unset HOME ignores USERPROFILE off Windows', env: { USERPROFILE: 'C:/Users/u' } },
  { name: 'path with spaces and newline', env: { HOME: '/home/u', GSTACK_HOME: '/state/with space\n' } },
  { name: 'Windows: HOME unset uses USERPROFILE', env: { USERPROFILE: 'C:/Users/u' }, win: true },
  { name: 'Windows: HOME wins over USERPROFILE', env: { HOME: '/c/Users/h', USERPROFILE: 'C:/Users/u' }, win: true },
  { name: 'Windows: nothing set', env: {}, win: true },
  { name: 'Windows: GSTACK_HOME backslash path', env: { GSTACK_HOME: 'C:\\gstack\\state', USERPROFILE: 'C:/Users/u' }, win: true },
];

describe('state root parity (bash twin vs lib/state-root.ts)', () => {
  for (const row of rootRows) {
    test(row.name, () => {
      const bash = bashEval(row, 'gstack_state_root; printf x');
      expect(bash.out.replace(/x$/, '')).toBe(resolveStateRoot(tsEnv(row, bash.home), row.win ? 'win32' : 'linux'));
    });
  }

  test('precedence is GSTACK_STATE_ROOT, GSTACK_HOME, GSTACK_STATE_DIR, gstack plugin data, $HOME/.gstack, .gstack', () => {
    const base = { HOME: '/home/u', CLAUDE_PLUGIN_DATA: '/plug', CLAUDE_PLUGIN_ROOT: '/x/gstack' };
    expect(resolveStateRoot({ ...base, GSTACK_STATE_ROOT: A, GSTACK_HOME: B, GSTACK_STATE_DIR: C }, 'linux')).toBe(A);
    expect(resolveStateRoot({ ...base, GSTACK_HOME: B, GSTACK_STATE_DIR: C }, 'linux')).toBe(B);
    expect(resolveStateRoot({ ...base, GSTACK_STATE_DIR: C }, 'linux')).toBe(C);
    expect(resolveStateRoot(base, 'linux')).toBe('/plug');
    expect(resolveStateRoot({ HOME: '/home/u' }, 'linux')).toBe('/home/u/.gstack');
    expect(resolveStateRoot({}, 'linux')).toBe('.gstack');
  });
});

describe('config key parity (gstack_read_config_key vs readConfigKey)', () => {
  let tmp: string;
  let resolved: string, home: string, legacyOverride: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cfg-parity-'));
    resolved = path.join(tmp, 'resolved');
    home = path.join(tmp, 'home');
    legacyOverride = path.join(tmp, 'legacy');
    fs.mkdirSync(resolved, { recursive: true });
    fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
    fs.mkdirSync(legacyOverride, { recursive: true });
    fs.writeFileSync(path.join(resolved, 'config.yaml'), [
      '# telemetry: off   (comment lines never match)',
      'telemetry: community',
      'codex_reviews: enabled',
      'update_check:   true   ',
      'memorable_recall: on\r',
      'proactive: true',
      'proactive: false',
      'founder_resources: true',
      'empty_key:',
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.gstack', 'config.yaml'), [
      'telemetry: anonymous',
      'codex_reviews: disabled',
      'memorable_recall: bogus',
      'proactive: true',
      'founder_resources: false',
      'only_legacy: yes',
    ].join('\n'));
    fs.writeFileSync(path.join(legacyOverride, 'config.yaml'), 'telemetry: off\nupdate_check: false');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const keys = ['telemetry', 'codex_reviews', 'update_check', 'memorable_recall', 'proactive', 'founder_resources', 'empty_key', 'only_legacy', 'missing'];

  test('every key reads identically through both twins, with and without the test legacy override', () => {
    const envs: Row[] = [
      { name: 'resolved + real home', env: { HOME: home, GSTACK_HOME: resolved } },
      { name: 'legacy override', env: { HOME: home, GSTACK_HOME: resolved, GSTACK_TEST_LEGACY_ROOT: legacyOverride } },
      { name: 'resolved is the default root', env: { HOME: home } },
      { name: 'no HOME', env: { GSTACK_HOME: resolved } },
      { name: 'Windows USERPROFILE home', env: { USERPROFILE: home, GSTACK_HOME: resolved }, win: true },
    ];
    for (const row of envs) {
      for (const key of keys) {
        const bash = bashEval(row, `gstack_read_config_key ${key}; printf x`);
        const ts = readConfigKey(key, tsEnv(row, bash.home), row.win ? 'win32' : 'linux') ?? '';
        expect(`${row.name}/${key}=${bash.out.replace(/x$/, '')}`).toBe(`${row.name}/${key}=${ts}`);
      }
    }
  });

  test('merged keys take the most restrictive value; other keys read the resolved root only', () => {
    const env = { HOME: home, GSTACK_HOME: resolved };
    expect(readConfigKey('telemetry', env, 'linux')).toBe('anonymous');
    expect(readConfigKey('codex_reviews', env, 'linux')).toBe('disabled');
    expect(readConfigKey('update_check', env, 'linux')).toBe('true');
    expect(readConfigKey('memorable_recall', env, 'linux')).toBe('bogus');
    expect(readConfigKey('proactive', env, 'linux')).toBe('false');
    expect(readConfigKey('founder_resources', env, 'linux')).toBe('true');
    expect(readConfigKey('only_legacy', env, 'linux')).toBeNull();
    expect(readConfigKey('empty_key', env, 'linux')).toBeNull();
    const overridden = { ...env, GSTACK_TEST_LEGACY_ROOT: legacyOverride };
    expect(readConfigKey('telemetry', overridden, 'linux')).toBe('off');
    expect(readConfigKey('codex_reviews', overridden, 'linux')).toBe('enabled');
  });
});
