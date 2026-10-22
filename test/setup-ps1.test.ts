/**
 * setup.ps1: the Windows entry point checks Git for Windows, Bun and Node.js,
 * then runs ./setup in Git Bash with every argument passed as its own argv
 * entry, never pasted into shell source. The behavioral cases copy the script
 * next to a stub ./setup that prints its argv and run it under pwsh, and
 * under Windows PowerShell 5.1's legacy native-argument passing: pwsh with
 * $PSNativeCommandArgumentPassing = 'Legacy' here, powershell.exe on Windows
 * (#3130: the 5.1 legacy mode stripped the double quotes inside the bash -c
 * script, and bash failed with "unexpected EOF").
 */
import { describe, test, expect, afterEach, beforeAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(import.meta.dir, '..', 'setup.ps1');
const SOURCE = fs.readFileSync(SCRIPT, 'utf-8');
const PWSH = Bun.which('pwsh');
const BASH = Bun.which('bash');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stubCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-'));
  dirs.push(dir);
  fs.copyFileSync(SCRIPT, path.join(dir, 'setup.ps1'));
  fs.writeFileSync(path.join(dir, 'setup'), '#!/usr/bin/env bash\nprintf \'cwd=%s\\n\' "$PWD"\nfor a in "$@"; do printf \'arg=[%s]\\n\' "$a"; done\nexit 7\n', { mode: 0o755 });
  return dir;
}

const IS_WIN = process.platform === 'win32';
/** Windows PowerShell 5.1 itself on Windows; elsewhere pwsh in Legacy argument mode. */
function runPs1Legacy(dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  let cmd: string;
  let argv: string[];
  if (IS_WIN) {
    cmd = 'powershell.exe';
    argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'setup.ps1'), ...args];
  } else {
    fs.writeFileSync(path.join(dir, 'legacy.ps1'), "$PSNativeCommandArgumentPassing = 'Legacy'\n& (Join-Path $PSScriptRoot 'setup.ps1') @args\nexit $LASTEXITCODE\n");
    cmd = PWSH!;
    argv = ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'legacy.ps1'), ...args];
  }
  const r = spawnSync(cmd, argv, {
    cwd: os.tmpdir(),
    encoding: 'utf-8',
    env: { ...process.env, ...(IS_WIN ? {} : { GSTACK_GIT_BASH: BASH! }), ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function runPs1(dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(PWSH!, ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'setup.ps1'), ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf-8',
    env: { ...process.env, ...(process.platform === 'win32' ? {} : { GSTACK_GIT_BASH: BASH! }), ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('setup.ps1', () => {
  // The first Windows PowerShell 5.1 launch on a runner pays a cold start (up to
  // 5 s on windows-latest) that later launches do not; pay it here, outside the
  // per-test timeout of the legacy cases below.
  beforeAll(() => {
    if ((PWSH || IS_WIN) && BASH) runPs1Legacy(stubCheckout(), ['--host', 'codex']);
  }, 60_000);

  test('passes arguments NUL-separated through a private file to a constant bash script', () => {
    expect(SOURCE).toContain(`& $bash -c 'set -f; IFS=; mapfile -d '''' -t argv < $1; rm -f -- $1; exec ./setup \${argv[@]}' setup $argFile`);
    const script = SOURCE.match(/& \$bash -c '((?:[^']|'')*)' setup \$argFile/)![1]!;
    expect(script).not.toContain('"');
    expect(SOURCE).toContain('foreach ($arg in $args) { $writer.Write([string]$arg); $writer.Write([char]0) }');
    expect(SOURCE).not.toMatch(/-join|Invoke-Expression|\biex\b|git-bash\.exe/);
    expect([...SOURCE].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  test.skipIf(!PWSH || !BASH)('forwards every argument literally from the script directory and keeps the exit code', () => {
    const dir = stubCheckout();
    const args = ['--host', 'codex', 'two words', '$(touch PWNED)', "it's", '"quoted"', ';echo injected', '`whoami`'];
    const { code, out } = runPs1(dir, args);
    expect(code).toBe(7);
    const lines = out.split(/\r?\n/);
    expect(lines.filter((l) => l.startsWith('arg=['))).toEqual(args.map((a) => `arg=[${a}]`));
    expect(lines.find((l) => l.startsWith('cwd='))).toContain(path.basename(dir));
    expect(out).not.toContain('injected\n');
    expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), 'PWNED'))).toBe(false);
  });

  test.skipIf(!PWSH || !BASH || process.platform === 'win32')('a missing prerequisite names its winget command and runs nothing', () => {
    const dir = stubCheckout();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-bin-'));
    dirs.push(bin);
    for (const tool of ['git', 'node']) {
      const real = Bun.which(tool);
      if (real) fs.symlinkSync(real, path.join(bin, tool));
    }
    const { code, out } = runPs1(dir, ['--host', 'codex'], { PATH: bin });
    expect(code).toBe(1);
    expect(out).toContain('Bun: winget install --id Oven-sh.Bun -e');
    expect(out).not.toContain('Git for Windows:');
    expect(out).not.toContain('arg=[');
  });

  // Arguments Node cannot hand to powershell.exe intact are left out on Windows:
  // there the command line is parsed before setup.ps1 sees it.
  const ADVERSARIAL = ['--host', 'codex', 'two words', '$(touch PWNED)', "it's", ';echo injected', '`whoami`', '*',
    ...(IS_WIN ? [] : ['"quoted"', 'a\\"b\\'])];

  test.skipIf((!PWSH && !IS_WIN) || !BASH)('Windows PowerShell 5.1 (legacy argument passing): forwards every argument literally, with a space in TMPDIR', () => {
    const dir = stubCheckout();
    const tmp = path.join(dir, 'temp with space');
    fs.mkdirSync(tmp);
    const { code, out } = runPs1Legacy(dir, ADVERSARIAL, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
    expect(out).not.toContain('unexpected EOF');
    expect(code, out).toBe(7);
    expect(out.split(/\r?\n/).filter((l) => l.startsWith('arg=['))).toEqual(ADVERSARIAL.map((a) => `arg=[${a}]`));
    expect(out).not.toContain('injected\n');
    expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), 'PWNED'))).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  test.skipIf((!PWSH && !IS_WIN) || !BASH)('an empty argument is refused before anything runs', () => {
    const dir = stubCheckout();
    for (const run of [runPs1Legacy, ...(PWSH ? [runPs1] : [])]) {
      const { code, out } = run(dir, ['--host', '', 'codex']);
      expect(code, out).toBe(2);
      expect(out).toContain('setup.ps1: argument 2 is empty; setup takes no empty arguments. Nothing was installed or changed. (SETUP_PS1_EMPTY_ARGUMENT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#setup-ps1-empty-argument)');
      expect(out).not.toContain('arg=[');
    }
  });
});

/**
 * Git Bash resolution: setup.ps1's own refusal and warning text, then every
 * row of lib/script-invocation.ts's table (test/fixtures/windows-bash-resolution.json)
 * so the two resolvers cannot drift. The override and its deprecated alias,
 * both set, a missing override, a scoop shim, per-user, portable and
 * machine-wide Git, an MSYS bash on PATH, and the WSL and non-MSYS
 * rejections. pwsh on Linux with every location injected: PATH,
 * git --exec-path, LOCALAPPDATA, ProgramFiles and SystemRoot. A shared row's
 * C:/... path lives under <root>/C/..., with its separators kept as written.
 */
describe.skipIf(!PWSH || IS_WIN)('setup.ps1: Git Bash resolution', () => {
  type Row = {
    name: string;
    git?: string;                        // where the fake git lives (default bin/git)
    execPath?: string;                   // what git --exec-path prints (relative to the root); none when absent
    gitBash?: string[];                  // fake Git Bash files
    pathBash?: Record<string, string>;   // bash on PATH -> what its uname -s prints
    env?: Record<string, string>;        // values may start with @ for a root-relative path
    used?: string;                       // the bash that ran setup
    refused?: string[];                  // the refusal lines that must appear
    warnings?: number;                   // how many differ-warnings print
  };
  const ROWS: Row[] = [
    { name: 'override', gitBash: ['custom/bash.exe', 'Program Files/Git/bin/bash.exe'], env: { GSTACK_GIT_BASH: '@custom/bash.exe', ProgramFiles: '@Program Files' }, used: 'custom/bash.exe' },
    { name: 'alias', gitBash: ['custom/bash.exe'], env: { GSTACK_BASH: '@custom/bash.exe' }, used: 'custom/bash.exe' },
    { name: 'both set and differ: GSTACK_GIT_BASH wins, one warning', gitBash: ['a/bash.exe', 'b/bash.exe'], env: { GSTACK_GIT_BASH: '@a/bash.exe', GSTACK_BASH: '@b/bash.exe' }, used: 'a/bash.exe', warnings: 1 },
    { name: 'both set to the same path: no warning', gitBash: ['a/bash.exe'], env: { GSTACK_GIT_BASH: '@a/bash.exe', GSTACK_BASH: '@a/bash.exe' }, used: 'a/bash.exe', warnings: 0 },
    { name: 'a missing override is refused, never skipped', gitBash: ['Program Files/Git/bin/bash.exe'], env: { GSTACK_GIT_BASH: '@nope/bash.exe', ProgramFiles: '@Program Files' }, refused: ['setup.ps1: GSTACK_GIT_BASH names @nope/bash.exe, which does not exist.'] },
    { name: 'a missing alias is refused by its own name', env: { GSTACK_BASH: '@nope/bash.exe' }, refused: ['setup.ps1: GSTACK_BASH names @nope/bash.exe, which does not exist.'] },
    { name: 'scoop shim: git --exec-path finds the real install', git: 'scoop/shims/git', execPath: 'scoop/apps/git/current/mingw64/libexec/git-core', gitBash: ['scoop/apps/git/current/bin/bash.exe'], used: 'scoop/apps/git/current/bin/bash.exe' },
    { name: 'per-user Git', execPath: 'nowhere/mingw64/libexec/git-core', gitBash: ['AppData/Local/Programs/Git/bin/bash.exe'], env: { LOCALAPPDATA: '@AppData/Local' }, used: 'AppData/Local/Programs/Git/bin/bash.exe' },
    { name: 'portable Git: the folders around git.exe', git: 'PortableGit/cmd/git', gitBash: ['PortableGit/bin/bash.exe'], used: 'PortableGit/bin/bash.exe' },
    { name: 'machine-wide Git', gitBash: ['Program Files/Git/bin/bash.exe'], env: { ProgramFiles: '@Program Files' }, used: 'Program Files/Git/bin/bash.exe' },
    { name: 'an MSYS bash on PATH', pathBash: { 'msys64/usr/bin/bash': 'MINGW64_NT-10.0-19045' }, used: 'msys64/usr/bin/bash' },
    { name: 'WSL rejection (System32 and WindowsApps)', pathBash: { 'Windows/System32/bash': 'Linux', 'Users/u/AppData/Local/Microsoft/WindowsApps/bash': 'Linux' }, env: { SystemRoot: '@Windows' },
      refused: ["  @Windows/System32/bash: WSL's bash, not Git Bash", "  @Users/u/AppData/Local/Microsoft/WindowsApps/bash: WSL's bash, not Git Bash"] },
    { name: 'a PATH bash that is not MSYS', pathBash: { 'usr/bin/bash': 'Linux' }, refused: ["  @usr/bin/bash: not Git Bash (uname -s printed 'Linux')"] },
    { name: 'missing: every candidate and why, then both recipes', execPath: 'Git/mingw64/libexec/git-core', env: { LOCALAPPDATA: '@AppData/Local', ProgramFiles: '@Program Files' },
      refused: ['setup.ps1: Git Bash (bash.exe) was not found. Tried:', '  @Git/bin/bash.exe: not found', '  @bin/bin/bash.exe: not found', '  @AppData/Local/Programs/Git/bin/bash.exe: not found', '  @Program Files/Git/bin/bash.exe: not found'] },
  ];
  type SharedRow = {
    name: string;
    env?: Record<string, string>;
    exists?: string[];
    gitExecPath?: string;
    which?: { git?: string; bash?: string };
    uname?: string;
    expect: { bash?: string; source?: string; refused?: boolean };
    warning?: string | null;
  };
  const SHARED: SharedRow[] = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, 'fixtures', 'windows-bash-resolution.json'), 'utf-8')).rows;
  const underRoot = (p: string) => p.replace(/^([A-Za-z]):(?=[\\/])/, '$1');
  const fwd = (p: string) => underRoot(p).replace(/\\/g, '/');
  const command = (p: string) => fwd(p).replace(/\.exe$/i, '');
  for (const s of SHARED) {
    const pathBash = s.which?.bash ? command(s.which.bash) : undefined;
    const env: Record<string, string> = { ProgramFiles: '@C/Program Files', SystemRoot: '@C/Windows' };
    for (const [k, v] of Object.entries(s.env ?? {})) env[k] = `@${underRoot(v)}`;
    ROWS.push({
      name: `shared table: ${s.name}`,
      git: s.which?.git ? command(s.which.git) : undefined,
      execPath: s.gitExecPath ? fwd(s.gitExecPath) : undefined,
      gitBash: (s.exists ?? []).map(fwd).filter((f) => f.replace(/\.exe$/i, '') !== pathBash),
      pathBash: pathBash ? { [pathBash]: s.uname ?? '' } : undefined,
      env,
      used: s.expect.bash ? (s.expect.source === 'PATH' ? pathBash : fwd(s.expect.bash)) : undefined,
      refused: s.expect.refused ? [] : undefined,
      warnings: s.warning === undefined ? undefined : s.warning ? 1 : 0,
    });
  }
  const RECIPE = [
    "  PowerShell (new windows; restart Claude Code after): [Environment]::SetEnvironmentVariable('GSTACK_GIT_BASH', 'C:\\Program Files\\Git\\bin\\bash.exe', 'User')",
    '  Claude Code: add "GSTACK_GIT_BASH": "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe" to the "env" block of ~/.claude/settings.json',
    'Nothing was installed or changed. (BASH_UNAVAILABLE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#bash-unavailable)',
  ];
  const WARNING = 'GSTACK_BASH is a deprecated alias: unset it.';

  function put(file: string, body: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o755 });
  }

  for (const row of ROWS) {
    test(row.name, () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-bash-')));
      dirs.push(root);
      const at = (v: string) => v.replace(/@/g, `${root}/`);
      fs.copyFileSync(SCRIPT, path.join(root, 'setup.ps1'));
      put(path.join(root, row.git ?? 'bin/git'), `#!/bin/sh\n[ "$1" = --exec-path ] && ${row.execPath ? `echo '${root}/${row.execPath}'` : ':'}\nexit 0\n`);
      for (const tool of ['bun', 'node']) put(path.join(root, 'bin', tool), '#!/bin/sh\nexit 0\n');
      for (const f of row.gitBash ?? []) put(path.join(root, f), '#!/bin/sh\necho "BASH_USED=$0"\n');
      for (const [f, kernel] of Object.entries(row.pathBash ?? {})) {
        put(path.join(root, f), `#!/bin/sh\n[ "$2" = 'uname -s' ] && { echo '${kernel}'; exit 0; }\necho "BASH_USED=$0"\n`);
      }
      const PATH = [...new Set([path.join(root, 'bin'), path.dirname(path.join(root, row.git ?? 'bin/git')),
        ...Object.keys(row.pathBash ?? {}).map((f) => path.dirname(path.join(root, f)))])].join(':');
      const env: Record<string, string> = { PATH, HOME: root, TMPDIR: root };
      for (const [k, v] of Object.entries(row.env ?? {})) env[k] = at(v);
      const r = spawnSync(PWSH!, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'setup.ps1'), '--host', 'codex'],
        { cwd: root, encoding: 'utf-8', env, timeout: 60_000 });
      const out = (r.stdout || '') + (r.stderr || '');
      const lines = out.split(/\r?\n/);
      if (row.used) {
        expect(r.status, out).toBe(0);
        expect(lines.filter((l) => l.startsWith('BASH_USED=')).map((l) => l.replace(/\\/g, '/'))).toEqual([`BASH_USED=${path.join(root, row.used)}`]);
      } else {
        expect(r.status, out).toBe(1);
        expect(out).not.toContain('BASH_USED=');
        for (const l of [...row.refused!.map(at), ...RECIPE]) expect(lines, out).toContain(l);
      }
      if (row.warnings !== undefined) expect(lines.filter((l) => l.includes(WARNING)), out).toHaveLength(row.warnings);
    });
  }
});
