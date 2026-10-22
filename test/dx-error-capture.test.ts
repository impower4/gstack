import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DX_CAPTURE_CODES, DX_CAPTURE_HELP } from '../lib/dx-error-capture';

const BIN = path.resolve(import.meta.dir, '../bin/gstack-error-capture');
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dx-error-capture-'));
const STATE = path.join(ROOT, 'state');
const FAKE_HOME = path.join(ROOT, 'home');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randomAlnum = (length: number) => [...randomBytes(length)].map(byte => ALNUM[byte % ALNUM.length]).join('');
const TOKEN = ['gh', 'p_'].join('') + randomAlnum(36);
const TOKEN_HALVES = [TOKEN.slice(0, 20), TOKEN.slice(20)];
const PASSED_VALUE = 'plain' + randomAlnum(20);
const EMAIL = ['alice.smith', 'acme-corp.io'].join('@');
const HOME_PATH = ['', 'home', 'alice', 'project', 'settings.json'].join('/');
const ERROR_LINE = /^gstack-error-capture: .+; fix: .+ \(DX_CAPTURE_[A-Z_]+\)\n$/;

const FIXTURES: Record<string, string> = {
  'tty.ts': "import { openSync } from 'node:fs';\nopenSync('/dev/tty', 'r');\n",
  'refuse.ts': "console.error('error: stdin is not a tty; pass --yes to skip the confirmation');\nprocess.exit(1);\n",
  'prompt.ts': "process.stdout.write('Continue? [y/N] ');\nfor await (const _ of process.stdin) {}\nconsole.error('Error: EOF while reading the answer');\nprocess.exit(1);\n",
  'sleeper.ts': "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nwriteFileSync(process.argv[2], String(child.pid));\nsetInterval(() => {}, 1000);\n",
  'ignore-term.ts': "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n",
  'exit124.ts': "process.exit(124);\n",
  'secrets.ts': [
    "const token = process.argv[2] + process.argv[3];",
    "const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));",
    "const write = (stream: NodeJS.WriteStream, text: string) => new Promise(resolve => stream.write(text, resolve));",
    "await write(process.stdout, 'token ' + token + '\\n');",
    "await write(process.stdout, JSON.stringify({ outer: { list: [{ secret: token }] } }) + '\\n');",
    "await write(process.stderr, 'auth failed for ' + token + '\\n');",
    "await write(process.stderr, token.slice(0, 10) + '\\x1b[0m' + token.slice(10) + '\\n');",
    "await sleep(50);",
    "await write(process.stdout, 'split ' + token.slice(0, 15));",
    "await sleep(50);",
    "await write(process.stdout, token.slice(15) + ' done\\n');",
    "process.exit(1);",
  ].join('\n'),
  'cross.ts': "const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));\nawait new Promise(resolve => process.stdout.write(process.argv[2], resolve));\nawait sleep(50);\nawait new Promise(resolve => process.stderr.write(process.argv[3], resolve));\n",
  'echo-json-env.ts': "console.log(JSON.stringify({ value: process.env.DX_TEST_VALUE }));\n",
  'cjk.ts': "console.error('\u9519'.repeat(5000));\nprocess.exit(1);\n",
  'echo-env.ts': "const value = process.env.DX_TEST_VALUE ?? '';\nconsole.log('value=' + value);\nconsole.error('encoded=' + Buffer.from(value).toString('base64'));\n",
  'big.ts': "const token = process.argv[2] + process.argv[3];\nprocess.stdout.write('a '.repeat(45) + token + ' ' + 'b'.repeat(200) + '\\n');\n",
  'bad-utf8.ts': "process.stdout.write(Buffer.from([0x6f, 0x6b, 0xff, 0xfe, 0x0a]));\nprocess.stderr.write('fine\\n');\n",
  'pii.ts': "console.error('cannot open " + HOME_PATH + " for " + EMAIL + "');\nprocess.exit(2);\n",
  'exit0.ts': "console.error('Error: could not connect to the database');\nprocess.exit(0);\n",
  'env.ts': "import { readFileSync, statSync } from 'node:fs';\nconst config = process.env.HOME + '/.config/tool/config.json';\nlet copied = null;\ntry { copied = { text: readFileSync(config, 'utf8'), mode: statSync(config).mode & 0o777 }; } catch {}\nconsole.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, term: process.env.TERM, keys: Object.keys(process.env).sort(), copied }));\n",
};
for (const [name, source] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(ROOT, name), source);
fs.writeFileSync(path.join(ROOT, 'no-version.sh'), '#!/bin/sh\necho "unknown option: $1" >&2\nexit 2\n', { mode: 0o755 });
fs.mkdirSync(path.join(FAKE_HOME, '.config/tool'), { recursive: true });
fs.writeFileSync(path.join(FAKE_HOME, '.config/tool/config.json'), '{"color":false}\n');
fs.symlinkSync(path.join(FAKE_HOME, '.config/tool/config.json'), path.join(FAKE_HOME, '.linked.json'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function helper(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: STATE, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function capture(flags: string[], fixture: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = helper([...flags, '--', process.execPath, path.join(ROOT, fixture), ...args], env);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return { ...result, record: JSON.parse(lines[0]) };
}

function gone(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return true; }
  try { return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').replace(/^.*\) /s, '').startsWith('Z'); } catch { return true; }
}

const leaksToken = (text: string) => text.includes(TOKEN) || text.includes(TOKEN.slice(4));

describe('gstack-error-capture terminal evidence', () => {
  test('reading /dev/tty without a controlling terminal is refused, not timed out', () => {
    const { record } = capture([], 'tty.ts');
    expect(record.timed_out).toBe(false);
    expect(record.exit_code).not.toBe(0);
    expect(record.terminal.verdict).toBe('refused_no_alternative');
    expect(record.launch).toBe('ok');
  });

  test('a TTY failure naming --yes is refused_with_alternative', () => {
    const { record } = capture([], 'refuse.ts');
    expect(record.exit_code).toBe(1);
    expect(record.terminal).toEqual({ verdict: 'refused_with_alternative', evidence: 'stderr matched "not a tty"; alternative "--yes"' });
  });

  test('EOF at a prompt with stdin closed is unknown, not blocking', () => {
    const { record } = capture([], 'prompt.ts');
    expect(record.timed_out).toBe(false);
    expect(record.terminal.verdict).toBe('unknown');
    expect(record.stdout).toBe('Continue? [y/N] ');
  });

  test('a sleeper past the deadline is killed with its descendant', async () => {
    const pidFile = path.join(ROOT, 'sleeper.pid');
    const started = Date.now();
    const { record } = capture(['--deadline', '2'], 'sleeper.ts', [pidFile]);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(record.timed_out).toBe(true);
    expect(record.exit_code).toBeNull();
    expect(record.deadline_s).toBe(2);
    expect(record.terminal.verdict).toBe('blocking');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 30 && !gone(pid); i++) await Bun.sleep(100);
    expect(gone(pid)).toBe(true);
  }, 30_000);

  test('a target ignoring SIGTERM is still killed at the deadline', () => {
    const { record } = capture(['--deadline', '1'], 'ignore-term.ts');
    expect(record.timed_out).toBe(true);
    expect(record.terminal.verdict).toBe('blocking');
  }, 30_000);

  test('a target exiting 124 itself is not timed out', () => {
    const { record } = capture(['--deadline', '10'], 'exit124.ts');
    expect(record.timed_out).toBe(false);
    expect(record.exit_code).toBe(124);
    expect(record.terminal.verdict).toBe('none');
  });

  test('an error reported with exit 0 is recorded as exit 0', () => {
    const { record } = capture([], 'exit0.ts');
    expect(record.exit_code).toBe(0);
    expect(record.stderr).toContain('could not connect to the database');
    expect(record.terminal.verdict).toBe('none');
  });
});

describe('gstack-error-capture redaction', () => {
  test('a HIGH token on stdout, stderr, nested JSON, behind ANSI and split across writes is masked everywhere', () => {
    const result = capture([], 'secrets.ts', TOKEN_HALVES);
    expect(leaksToken(result.stdout)).toBe(false);
    expect(leaksToken(result.stderr)).toBe(false);
    const { record } = result;
    expect(record.stdout).toContain('<REDACTED-github.pat>');
    expect(record.stdout).toContain('split <REDACTED-github.pat> done');
    expect(record.stderr).toContain('auth failed for <REDACTED-github.pat>');
    expect(record.stderr).not.toContain('\u001b');
    expect(record.secret_findings.classes).toEqual(['github.pat']);
    expect(record.secret_findings.count).toBe(5);
    expect(record.scan_complete).toBe(true);
    expect(record.withheld_reason).toEqual({ stdout: null, stderr: null });
  });

  test('a token split across stdout and stderr withholds both streams', () => {
    const result = capture([], 'cross.ts', TOKEN_HALVES);
    expect(leaksToken(result.stdout)).toBe(false);
    expect(result.record.stdout).toBe('withheld');
    expect(result.record.stderr).toBe('withheld');
    expect(result.record.withheld_reason).toEqual({ stdout: 'cross_stream_finding', stderr: 'cross_stream_finding' });
  });

  test('an unpatterned --pass-env value is masked literally and in base64 with --approved', () => {
    const result = capture(['--pass-env', 'DX_TEST_VALUE', '--approved'], 'echo-env.ts', [], { DX_TEST_VALUE: PASSED_VALUE });
    const encoded = Buffer.from(PASSED_VALUE).toString('base64');
    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain(PASSED_VALUE);
      expect(text).not.toContain(encoded);
    }
    expect(result.record.stdout).toBe('value=<REDACTED-passed_env.value>\n');
    expect(result.record.secret_findings).toEqual({ count: 2, classes: ['passed_env.value'] });
    expect(result.record.passed_env).toEqual(['DX_TEST_VALUE']);
    expect(result.record.containment.env).toContain('DX_TEST_VALUE');
  });

  test('a --pass-env value the target JSON-escapes is masked, and decoding stdout cannot rebuild it', () => {
    const value = 'quo"te' + randomAlnum(12);
    const result = capture(['--pass-env', 'DX_TEST_VALUE', '--approved'], 'echo-json-env.ts', [], { DX_TEST_VALUE: value });
    expect(result.stdout).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(JSON.stringify(JSON.parse(result.record.stdout))).not.toContain(value.slice(6));
    expect(result.record.secret_findings.count).toBeGreaterThan(0);
  });

  test.each([['CI', 'true'], ['DX_MODE', 'none']])('forwarding %p=%p, a protocol value, does not trip the final secret check', (name, value) => {
    const { record } = capture(['--pass-env', name, '--approved'], 'exit0.ts', [], { [name]: value });
    expect(record.exit_code).toBe(0);
    expect(record.terminal.verdict).toBe('none');
  });

  test('multi-byte output under the publish cap is recorded, not withheld', () => {
    const { record } = capture([], 'cjk.ts');
    expect(record.stderr).toBe('\u9519'.repeat(5000) + '\n');
    expect(record.truncated.stderr).toBe(false);
  });

  test('truncation runs after redaction and drops the run cut at --max-bytes', () => {
    const result = capture(['--max-bytes', '100'], 'big.ts', TOKEN_HALVES);
    expect(leaksToken(result.stdout)).toBe(false);
    expect(result.record.truncated).toEqual({ stdout: true, stderr: false });
    expect(result.record.stdout).toBe('a '.repeat(45));
    expect(result.record.secret_findings.classes).toEqual(['github.pat']);
  });

  test('invalid UTF-8 withholds only that stream', () => {
    const { record } = capture([], 'bad-utf8.ts');
    expect(record.stdout).toBe('withheld');
    expect(record.withheld_reason).toEqual({ stdout: 'invalid_utf8', stderr: null });
    expect(record.stderr).toBe('fine\n');
    expect(record.scan_complete).toBe(false);
  });

  test('emails and home paths are masked as other_masked, not secrets', () => {
    const result = capture([], 'pii.ts');
    expect(result.stdout).not.toContain(EMAIL);
    expect(result.stdout).not.toContain(HOME_PATH);
    expect(result.record.secret_findings).toEqual({ count: 0, classes: [] });
    expect(result.record.other_masked.classes).toEqual(['internal.user_path', 'pii.email']);
  });
});

describe('gstack-error-capture containment', () => {
  test('the target gets a temp cwd and HOME, a scrubbed env and TERM=dumb; the run dir is removed', () => {
    const staleDir = path.join(STATE, 'error-capture', 'run-' + spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 }).pid + '-stale');
    fs.mkdirSync(staleDir, { recursive: true });
    const { record } = capture([], 'env.ts', [], { DX_UNLISTED_SECRET_NAME: 'x', MISE_GITHUB_TOKEN: 'y', MISE_ENV: 'dev',
      MISE_GLOBAL_CONFIG_FILE: path.join(FAKE_HOME, 'mise.toml'), MISE_TRUSTED_CONFIG_PATHS: FAKE_HOME, MISE_DATA_DIR: path.join(FAKE_HOME, '.mise') });
    const seen = JSON.parse(record.stdout);
    expect(seen.cwd.startsWith(fs.realpathSync(STATE))).toBe(true);
    expect(seen.home.startsWith(fs.realpathSync(STATE))).toBe(true);
    expect(seen.xdg).toBe(seen.home + '/.config');
    expect(seen.term).toBe('dumb');
    expect(seen.keys).not.toContain('DX_UNLISTED_SECRET_NAME');
    expect(seen.keys).not.toContain('MISE_GITHUB_TOKEN');
    for (const name of ['MISE_ENV', 'MISE_GLOBAL_CONFIG_FILE', 'MISE_TRUSTED_CONFIG_PATHS']) expect(seen.keys).not.toContain(name);
    expect(seen.keys).toContain('MISE_DATA_DIR');
    expect(record.containment).toEqual({ cwd: 'temp', home: 'temp', env: seen.keys });
    expect(fs.readdirSync(path.join(STATE, 'error-capture'))).toEqual([]);
    expect(fs.statSync(path.join(STATE, 'error-capture')).mode & 0o777).toBe(0o700);
  });

  test('--copy-config copies a file under HOME to the same relative path with mode 0600', () => {
    const { record } = capture(['--approved', '--copy-config', path.join(FAKE_HOME, '.config/tool/config.json')], 'env.ts', [], { HOME: FAKE_HOME });
    expect(record.copied_config).toEqual(['.config/tool/config.json']);
    expect(JSON.parse(record.stdout).copied).toEqual({ text: '{"color":false}\n', mode: 0o600 });
  });

  test('--copy-config refuses a symlink', () => {
    const result = helper(['--approved', '--copy-config', path.join(FAKE_HOME, '.linked.json'), '--', process.execPath, '--version'], { HOME: FAKE_HOME });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(ERROR_LINE);
    expect(result.stderr).toContain('(DX_CAPTURE_CONFIG_REFUSED)');
  });

  test('--launch-check reports a started target as launch ok even when --version is rejected', () => {
    const result = helper(['--launch-check', '--', path.join(ROOT, 'no-version.sh')]);
    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.launch).toBe('ok');
    expect(record.exit_code).toBe(2);
  });

  test('--launch-check runs <cmd> --version inside the containment', () => {
    const result = helper(['--launch-check', '--', process.execPath]);
    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.launch).toBe('ok');
    // argv is redacted like the streams, so a home-directory execPath may be masked.
    expect(record.argv).toHaveLength(2);
    expect(record.argv[1]).toBe('--version');
  });
});

describe('gstack-error-capture own errors', () => {
  test('its own diagnostics are redacted: a token in an unknown flag never reaches stderr', () => {
    const result = helper(['--' + TOKEN, '--', process.execPath]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(ERROR_LINE);
    expect(result.stderr).toContain('(DX_CAPTURE_USAGE)');
    expect(leaksToken(result.stderr)).toBe(false);
  });

  test('a --pass-env value reflected in a rejected flag value is masked even before validation', () => {
    const result = helper(['--pass-env', 'DX_TEST_VALUE', '--approved', '--deadline', PASSED_VALUE, '--', process.execPath], { DX_TEST_VALUE: PASSED_VALUE });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('(DX_CAPTURE_BAD_DEADLINE)');
    expect(result.stderr).not.toContain(PASSED_VALUE);
  });

  test('--pass-env without --approved is refused with exit 3', () => {
    const result = helper(['--pass-env', 'DX_TEST_VALUE', '--', process.execPath, path.join(ROOT, 'echo-env.ts')], { DX_TEST_VALUE: PASSED_VALUE });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(ERROR_LINE);
    expect(result.stderr).toContain('(DX_CAPTURE_APPROVAL_REQUIRED)');
    expect(result.stderr).not.toContain(PASSED_VALUE);
  });

  test.each([
    [['--deadline', '2', process.execPath], 2, 'DX_CAPTURE_USAGE'],
    [['--bogus', '--', process.execPath], 2, 'DX_CAPTURE_USAGE'],
    [['--deadline', 'soon', '--', process.execPath], 2, 'DX_CAPTURE_BAD_DEADLINE'],
    [['--max-bytes', '0', '--', process.execPath], 2, 'DX_CAPTURE_BAD_MAX_BYTES'],
    [['--approved', '--pass-env', 'DX_SURELY_UNSET_VAR', '--', process.execPath], 2, 'DX_CAPTURE_BAD_PASS_ENV'],
    [['--approved', '--pass-env', 'HOME', '--', process.execPath], 2, 'DX_CAPTURE_BAD_PASS_ENV'],
    [['--approved', '--cwd', '/nonexistent-dx-capture-dir', '--', process.execPath], 2, 'DX_CAPTURE_BAD_CWD'],
  ] as Array<[string[], number, string]>)('%p exits %p with %p', (args, status, code) => {
    const result = helper(args);
    expect(result.status).toBe(status);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(ERROR_LINE);
    expect(result.stderr).toContain('(' + code + ')');
  });

  test('SIGTERM to the helper kills the target group, prints no record and exits 1', async () => {
    const pidFile = path.join(ROOT, 'interrupted.pid');
    const child = spawn(process.execPath, [BIN, '--deadline', '20', '--', process.execPath, path.join(ROOT, 'sleeper.ts'), pidFile], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GSTACK_STATE_ROOT: STATE },
    });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await Bun.sleep(50);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    expect(await closed).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(ERROR_LINE);
    expect(stderr).toContain('(DX_CAPTURE_INTERRUPTED)');
    for (let i = 0; i < 30 && !gone(pid); i++) await Bun.sleep(100);
    expect(gone(pid)).toBe(true);
    expect(fs.readdirSync(path.join(STATE, 'error-capture'))).toEqual([]);
  }, 30_000);

  test('an unresolvable binary records launch not_found and exits 1', () => {
    const result = helper(['--', 'dx-capture-no-such-binary']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).launch).toBe('not_found');
    expect(result.stderr).toMatch(ERROR_LINE);
    expect(result.stderr).toContain('(DX_CAPTURE_NOT_FOUND)');
  });

  test('--help documents flags, record fields, exit codes and every code', () => {
    const result = helper(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(DX_CAPTURE_HELP);
    for (const word of ['--deadline', '--max-bytes', '--pass-env', '--copy-config', '--cwd', '--approved', '--launch-check',
      'timed_out', 'terminal', 'secret_findings', 'other_masked', 'scan_complete', 'withheld_reason', 'containment', '3 refused']) {
      expect(DX_CAPTURE_HELP).toContain(word);
    }
    expect(DX_CAPTURE_HELP).toContain('(default ' + DX_CAPTURE_CODES.DX_CAPTURE_BAD_MAX_BYTES.fix.split(' ')[1] + ')');
    expect(DX_CAPTURE_HELP).toContain('Usage: ' + DX_CAPTURE_CODES.DX_CAPTURE_USAGE.fix);
    for (const [code, row] of Object.entries(DX_CAPTURE_CODES)) {
      expect(code.startsWith('DX_CAPTURE_')).toBe(true);
      expect(DX_CAPTURE_HELP).toContain(code + ' (exit ' + row.exit);
    }
  });
});
