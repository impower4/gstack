/**
 * Path spelling on Windows shells (#3088, #3100, #3101): Git Bash spells a
 * drive path /c/x, native git and Bun answer C:/x. bin/gstack-path-spelling.sh
 * and its TS twin lib/path-spelling.ts give one spelling; skill bash never
 * compares `git rev-parse --show-toplevel` with `pwd -P`, it checks "am I at
 * the checkout root" with `git rev-parse --show-prefix`, which has no spelling.
 *
 * Windows-safe: bash runs through explicit `bash -c` with forward-slash paths.
 * On Linux and macOS a uname/cygpath shim stands in for MSYS.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nativePath, samePath, shellPath } from '../lib/path-spelling';

const ROOT = path.resolve(import.meta.dir, '..');
const posix = (value: string) => value.replace(/\\/g, '/');
const HELPER = posix(path.join(ROOT, 'bin', 'gstack-path-spelling.sh'));
const ROOT_CHECK = '_p=$(git rev-parse --show-prefix 2>/dev/null) && [ -z "$_p" ] && [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]';

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });
function tmp(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'path-spelling-')));
  bases.push(base);
  return base;
}

function bash(script: string, opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const r = spawnSync('bash', ['-c', script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

/** A PATH whose uname says MINGW64 and whose cygpath maps /tmp-style paths under C:/msys64. */
function msysShim(): string {
  const shim = path.join(tmp(), 'shim');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'uname'), '#!/usr/bin/env bash\necho MINGW64_NT-10.0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(shim, 'cygpath'), [
    '#!/usr/bin/env bash',
    '[ "$1" = -am ] || exit 1',
    'case "$2" in',
    '  [A-Za-z]:*) printf "%s\\n" "$2" | tr "\\\\\\\\" / ;;',
    '  /[a-z]/*) d=${2:1:1}; printf "%s:%s\\n" "$(printf %s "$d" | tr a-z A-Z)" "${2:2}" ;;',
    '  /*) printf "C:/msys64%s\\n" "$2" ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  return `${shim}${path.delimiter}${process.env.PATH}`;
}

describe('bin/gstack-path-spelling.sh', () => {
  test.skipIf(process.platform === 'win32')('outside Windows shells every spelling is the path itself', () => {
    const r = bash(`. '${HELPER}'; gstack_path_shell /a/b; gstack_path_native /a/b; gstack_path_shell C:/x`);
    expect(r.out.split('\n')).toEqual(['/a/b', '/a/b', 'C:/x']);
  });

  test.skipIf(process.platform === 'win32')('under MSYS: drive, native and mount-alias spellings meet at /c/…', () => {
    const r = bash([
      `. '${HELPER}'`,
      'gstack_path_shell "C:\\\\Users\\\\me\\\\gstack"',
      'gstack_path_shell C:/Users/me/gstack',
      'gstack_path_shell /c/Users/me/gstack',
      'gstack_path_shell /tmp/x',
      'gstack_path_native /c/Users/me/gstack',
      'gstack_path_native /tmp/x',
      'gstack_path_same C:/Users/me/missing /c/Users/me/missing && echo same',
      'gstack_path_same C:/Users/me/a /c/Users/me/b || echo different',
    ].join('\n'), { env: { PATH: msysShim() } });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      '/c/Users/me/gstack', '/c/Users/me/gstack', '/c/Users/me/gstack', '/c/msys64/tmp/x',
      'C:/Users/me/gstack', 'C:/msys64/tmp/x', 'same', 'different',
    ]);
  });

  test('existing paths compare by filesystem identity, through a symlink too', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'real'));
    let linked = true;
    try { fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'), 'dir'); } catch { linked = false; }
    const b = posix(base);
    const r = bash([
      `. '${HELPER}'`,
      `gstack_path_same '${b}/real' '${b}/real/.' && echo same`,
      `gstack_path_same '${b}/real' '${b}' || echo different`,
      linked ? `gstack_path_same '${b}/link' '${b}/real' && echo linked` : 'echo linked',
    ].join('\n'));
    expect(r.out.split('\n')).toEqual(['same', 'different', 'linked']);
  });

  test('absolute in any spelling', () => {
    const r = bash(`. '${HELPER}'; for p in /a C:/a 'C:\\a' a ./a .git/index; do gstack_path_absolute "$p" && echo "abs $p" || echo "rel $p"; done`);
    expect(r.out.split('\n')).toEqual(['abs /a', 'abs C:/a', 'abs C:\\a', 'rel a', 'rel ./a', 'rel .git/index']);
  });
});

describe('lib/path-spelling.ts (the TS twin)', () => {
  test('win32 spellings', () => {
    expect(shellPath('C:\\Users\\me\\x.ts', 'win32')).toBe('/c/Users/me/x.ts');
    expect(shellPath('D:/a', 'win32')).toBe('/d/a');
    expect(shellPath('hosts\\claude\\x.ts', 'win32')).toBe('hosts/claude/x.ts');
    expect(shellPath('/c/a', 'win32')).toBe('/c/a');
    expect(nativePath('/c/Users/me', 'win32')).toBe('C:/Users/me');
    expect(nativePath('/c', 'win32')).toBe('C:/');
    expect(nativePath('C:\\a', 'win32')).toBe('C:/a');
    expect(samePath('C:/Users/Me/missing', '/c/users/me/missing/', 'win32')).toBe(true);
    expect(samePath('C:/a/missing', '/c/b/missing', 'win32')).toBe(false);
  });

  test('POSIX paths pass through unchanged', () => {
    expect(shellPath('C:/x', 'linux')).toBe('C:/x');
    expect(nativePath('/c/x', 'darwin')).toBe('/c/x');
    expect(samePath('/a/b', '/a/b/', 'linux')).toBe(true);
  });

  test('existing paths compare by filesystem identity', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'real'));
    expect(samePath(path.join(base, 'real'), path.join(base, 'real', '.'))).toBe(true);
    expect(samePath(path.join(base, 'real'), base)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('agrees with the bash helper on native spellings under MSYS', () => {
    const inputs = ['C:/Users/me/gstack', 'D:\\work\\x', 'c:/lower'];
    const r = bash(`. '${HELPER}'; for p in ${inputs.map(i => `'${i}'`).join(' ')}; do gstack_path_shell "$p"; done`, { env: { PATH: msysShim() } });
    expect(r.out.split('\n')).toEqual(inputs.map(i => shellPath(i, 'win32')));
  });
});

describe('bin/gstack-hook-check keeps its own copy of the mapping (it must run without helpers)', () => {
  const CHECK = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-hook-check'), 'utf8');

  test('its Bun-side shellPath equals lib/path-spelling.ts shellPath', () => {
    const src = /const shellPath = (\(value\) => [\s\S]*?: String\(value\));/.exec(CHECK)?.[1];
    expect(src).toBeTruthy();
    const inline = new Function('process', `return ${src};`);
    const inputs = ['C:\\Users\\me\\x.ts', 'D:/a/b', 'c:/lower', 'hosts\\claude\\x.ts', '/c/a', 'C:'];
    for (const platform of ['win32', 'linux']) {
      const mapped = inline({ platform });
      for (const i of inputs) expect(mapped(i)).toBe(shellPath(i, platform));
    }
  });

  test.skipIf(process.platform === 'win32')('its root canonicalization equals gstack_path_shell under MSYS', () => {
    const block = /(case "\$\(uname -s 2>\/dev\/null\)" in\n  MINGW\*\|MSYS\*\)[\s\S]*?\nesac)\n/.exec(CHECK)?.[1];
    expect(block).toBeTruthy();
    const roots = ['C:/Users/me/gstack', 'D:\\work\\gstack', '/c/Users/me/gstack', '/tmp/x'];
    const r = bash(roots.map(p => `ROOT='${p}'\n${block}\nprintf '%s\\n' "$ROOT"`).join('\n') + `\n. '${HELPER}'\n` + roots.map(p => `gstack_path_shell '${p}'`).join('\n'), { env: { PATH: msysShim() } });
    const lines = r.out.split('\n');
    expect(lines.slice(0, roots.length)).toEqual(lines.slice(roots.length));
    expect(lines[0]).toBe('/c/Users/me/gstack');
  });
});

/** The guard each template block runs, with the commands before it on the same line. */
function templateGuards(): Array<{ file: string; line: string }> {
  const guards: Array<{ file: string; line: string }> = [];
  for (const file of ['gstack-upgrade/SKILL.md.tmpl', 'spec/sections/gate-and-file.md.tmpl']) {
    for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
      if (line.includes('--show-prefix')) guards.push({ file, line });
    }
  }
  return guards;
}

describe('checkout-root guards in skill bash (/gstack-upgrade, /spec)', () => {
  test('all four guards use the --show-prefix root check', () => {
    const guards = templateGuards();
    expect(guards.map(g => g.file)).toEqual([
      'gstack-upgrade/SKILL.md.tmpl', 'gstack-upgrade/SKILL.md.tmpl', 'gstack-upgrade/SKILL.md.tmpl', 'spec/sections/gate-and-file.md.tmpl',
    ]);
    for (const g of guards) expect(g.line).toContain(ROOT_CHECK);
  });

  test('the root check passes at the root and through a symlink, and refuses below it, outside a repo and inside .git', () => {
    const base = tmp();
    const repo = path.join(base, 'gstack');
    fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
    for (const f of ['VERSION', 'setup', 'bin/gstack-config']) fs.writeFileSync(path.join(repo, f), 'x\n');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.mkdirSync(path.join(base, 'outside'));
    expect(bash('git init -q', { cwd: repo }).code).toBe(0);
    let linked = true;
    try { fs.symlinkSync(repo, path.join(base, 'link'), 'dir'); } catch { linked = false; }
    const env = { GIT_CEILING_DIRECTORIES: posix(base), GIT_DIR: undefined, GIT_WORK_TREE: undefined };
    const upgradeGuard = templateGuards()[0]!.line;
    const run = (dir: string) => {
      const guard = bash(`${upgradeGuard}\necho GUARD_PASSED`, { cwd: dir, env: { ...env, INSTALL_DIR: posix(dir) } });
      const bare = bash(`${ROOT_CHECK} && echo ROOT || echo REFUSED`, { cwd: dir, env });
      return { guard: guard.out.includes('GUARD_PASSED'), bare: bare.out };
    };
    expect(run(repo)).toEqual({ guard: true, bare: 'ROOT' });
    if (linked) expect(run(path.join(base, 'link'))).toEqual({ guard: true, bare: 'ROOT' });
    expect(run(path.join(repo, 'sub')).bare).toBe('REFUSED');
    expect(run(path.join(base, 'outside'))).toEqual({ guard: false, bare: 'REFUSED' });
    expect(run(path.join(repo, '.git')).bare).toBe('REFUSED');
    expect(run(path.join(repo, '.git', 'objects')).bare).toBe('REFUSED');
  });

  test('no skill template compares --show-toplevel with pwd -P', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tmpl') || (dir.endsWith(path.join('scripts', 'resolvers')) && entry.name.endsWith('.ts'))) {
          const text = fs.readFileSync(full, 'utf8');
          for (const block of text.match(/```bash\n[\s\S]*?```/g) ?? [text]) {
            const vars = [...block.matchAll(/(\w+)=\$\(git rev-parse --show-toplevel/g)].map(m => m[1]!);
            for (const line of block.split('\n')) {
              const toplevel = line.includes('--show-toplevel') || vars.some(v => line.includes(`"$${v}"`));
              if (toplevel && line.includes('$(pwd -P)') && /\s!?=\s/.test(line)) offenders.push(`${path.relative(ROOT, full)}: ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(ROOT);
    expect(offenders).toEqual([]);
  });
});
