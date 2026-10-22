/**
 * GSTA-56 ratchet: every Bun that gstack starts ignores the working
 * directory's .env files and bunfig.toml (lib/bun-isolation.ts). Bun reads
 * both from the directory it starts in, gstack runs inside the repository it
 * audits, and a bunfig.toml preload runs code before gstack's own. Five entry
 * kinds are held to the isolated form:
 *   1. bun shebangs: exactly ISOLATED_SHEBANG (`bun run <file>` ignores the
 *      shebang, so callers carry the flags too);
 *   2. shell callers in shipped shell files, skill templates, generated skill
 *      docs and resolvers: `bun --no-env-file --config=/dev/null` before
 *      `run`, `-e`/`-p` or a script path;
 *   3. TypeScript spawns of a Bun: bunIsolationArgs() (or browse's
 *      bunChildFlags()) in the argument list;
 *   4. scriptInvocation, which launches gstack's own bun bins;
 *   5. `bun build --compile`: both --no-compile-autoload-dotenv and
 *      --no-compile-autoload-bunfig.
 * test/bun-dotenv-isolation.test.ts runs the real bins in a hostile fixture.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs, emptyBunConfig } from '../lib/bun-isolation';
import { scriptInvocation } from '../lib/script-invocation';
import { emptyBunConfig as browseEmptyBunConfig } from '../browse/src/bun-child-config';

const ROOT = path.resolve(import.meta.dir, '..');
const FLAGS = '--no-env-file --config=/dev/null';
const ISOLATED_SHEBANG = `#!/usr/bin/env -S bun ${FLAGS}`;

const TRACKED = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.split('\0').filter(Boolean)
  .filter(f => !/(^|\/)test\//.test(f) && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());

function firstLine(file: string): string {
  const fd = fs.openSync(path.join(ROOT, file), 'r');
  try {
    const buf = Buffer.alloc(160);
    return buf.subarray(0, fs.readSync(fd, buf, 0, 160, 0)).toString('utf8').split('\n')[0] ?? '';
  } finally { fs.closeSync(fd); }
}

const BUN_WORD = /(^|[\s;&|({`"']|\$\()(bun|"\$\{?BUN(?:_[A-Z]+)?\}?"|\$\{?BUN(?:_[A-Z]+)?\}?)(?=[ \t])/g;

/** Whether the text after a `bun` word starts a program: -e/-p, a script path, `run <var>` or a bin path. A package script (`bun run build`) is not one. */
function runsCode(rest: string): boolean {
  const r = rest.replace(/^\s+/, '').replace(/^(?:--(?:no-env-file|cwd[= ]\S+)\s+)*/, '');
  return /^(?:run\s+)?(?:-e|-p|--eval|--print)(?:\s|=|$)/.test(r)
    || /^(?:run\s+)?["']?[^\s"'|;&)]*\.(?:ts|js|mjs|cjs|tsx)(?:["'\s)|;&\\`]|$)/.test(r)
    || /^run\s+["']?\$\{?[A-Za-z_]/.test(r)
    || /^(?:run\s+)?["']?[~$]?[^\s"']*\/bin\/[\w.-]+["']?(?:[\s`)]|$)/.test(r);
}

/** Bun invocations on one shell line that start a program without the isolation flags. */
function unisolatedBunCalls(line: string): string[] {
  if (/^\s*(#|\/\/|\*)/.test(line)) return [];
  const out: string[] = [];
  for (const m of line.matchAll(BUN_WORD)) {
    const at = m.index! + m[1]!.length;
    if (/\bln\s+-\w+\s+$/.test(line.slice(0, at))) continue;
    const rest = line.slice(at + m[2]!.length);
    if (!rest.startsWith(` ${FLAGS}`) && runsCode(rest)) out.push(line.slice(at, at + 80));
  }
  return out;
}

/** Each entry runs code that already belongs to its own directory, so that directory's config is the code's own. */
const SHELL_EXEMPT: Record<string, string> = {
  'skillify/SKILL.md.tmpl': 'describes how a codified browser-skill runs its own script in its own directory',
  'skillify/SKILL.md': 'generated from skillify/SKILL.md.tmpl',
};

const isShell = (f: string) => f.endsWith('.sh') || /^#!.*\b(?:ba|z)?sh\b/.test(firstLine(f));
const isSkillSource = (f: string) => f.endsWith('.tmpl') || /^scripts\/resolvers\/.+\.ts$/.test(f)
  || /(^|\/)SKILL\.md$/.test(f) || /\/sections\/[^/]+\.md$/.test(f);

describe('GSTA-56: gstack never takes configuration from the audited repository', () => {
  test('every bun shebang is the isolated shebang', () => {
    const offenders = TRACKED.filter(f => { const l = firstLine(f); return l.startsWith('#!') && /\bbun\b/.test(l) && l !== ISOLATED_SHEBANG; });
    expect(offenders).toEqual([]);
    expect(TRACKED.filter(f => firstLine(f) === ISOLATED_SHEBANG).length).toBeGreaterThan(100);
  });

  test('developer scripts run as ./scripts/<name>.ts start isolated', () => {
    const scripts = [
      'browse/scripts/extension-id.ts',
      'scripts/detect-bump.ts',
      'scripts/eval-compare.ts',
      'scripts/eval-summary.ts',
      'scripts/garry-output-comparison.ts',
      'scripts/judge-controls.ts',
      'scripts/measure-journal-read.ts',
    ];
    expect(scripts.filter(f => firstLine(f) !== ISOLATED_SHEBANG)).toEqual([]);
  });

  test('the shell-caller detector flags unisolated calls and passes isolated ones', () => {
    for (const bad of [
      'bun run ~/.claude/skills/gstack/bin/gstack-render.ts x.html',
      'out=$(bun "$BIN/gstack-runtime-pins.ts" --project "$p")',
      'printf x | bun -e "console.log(1)"',
      'exec bun run "$ENTRY" "$@"',
      'QUEUE=$(bun run ~/.claude/skills/gstack/bin/gstack-next-version --base main)',
      '"$BUN" -e \'1\'',
      'bun --no-env-file run "$X/bin/gstack-design-detect.ts"',
      'running=$(bun -p process.execPath)',
    ]) expect(unisolatedBunCalls(bad)).not.toEqual([]);
    for (const ok of [
      `bun ${FLAGS} run ~/.claude/skills/gstack/bin/gstack-render.ts x.html`,
      `printf x | bun ${FLAGS} -e "console.log(1)"`,
      'cd "$SRC" && bun run build',
      'bun install --frozen-lockfile',
      'bun test test/foo.test.ts',
      '# bun run scripts/x.ts in a comment',
      'say "installing bun $WANT from its release archive"',
      'ln -sf bun "$HOME/.bun/bin/bunx"',
    ]) expect(unisolatedBunCalls(ok)).toEqual([]);
  });

  test('shell callers, skill templates, generated skill docs and resolvers pass the isolation flags', () => {
    const offenders: string[] = [];
    for (const f of TRACKED) {
      if (f.startsWith('.github/') || SHELL_EXEMPT[f] || !(isSkillSource(f) || isShell(f))) continue;
      fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        for (const call of unisolatedBunCalls(line)) offenders.push(`${f}:${i + 1}: ${call}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('TypeScript spawns of a Bun carry bunIsolationArgs()', () => {
    const SPAWN_BUN = /\b(?:spawn|spawnSync|execFile|execFileSync|Bun\.spawn|Bun\.spawnSync)\(\s*\[?\s*(?:process\.execPath|['"]bun['"]|bunExecutable\(\))\s*,?/g;
    const EXEMPT: Record<string, string> = {
      'browse/src/cli.ts': 'the Windows launcher string runs under node -e, where process.execPath is node',
    };
    const offenders: string[] = [];
    for (const f of TRACKED) {
      if (f.startsWith('.github/') || f.startsWith('scripts/') || /\.test\.ts$|^test-setup\.ts$/.test(f) || EXEMPT[f]) continue;
      if (!f.endsWith('.ts') && !/^#!.*\bbun\b/.test(firstLine(f))) continue;
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(SPAWN_BUN)) {
        const lineStart = src.lastIndexOf('\n', m.index!) + 1;
        if (/^\s*(?:\/\/|\*)/.test(src.slice(lineStart, m.index!))) continue;
        const args = src.slice(m.index! + m[0].length, m.index! + m[0].length + 160);
        if (/bunIsolationArgs\(\)|bunChildFlags\(\)|['"]--version['"]|--no-env-file['"][^\]]*--config=\$\{emptyBunConfig\(\)\}/.test(args)) continue;
        const held = /^\s*([A-Za-z_]\w*)\s*[,)]/.exec(args)?.[1];
        if (held && new RegExp(`\\b(?:const|let)\\s+${held}\\s*=\\s*\\[\\s*\\.\\.\\.bunIsolationArgs\\(\\)`).test(src)) continue;
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}: ${m[0]}${args.split('\n')[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('scriptInvocation launches a bun bin with the isolation flags first', () => {
    const inv = scriptInvocation(path.join(ROOT, 'bin', 'gstack-decision-log'), ['--help'], { bunExe: 'bun' });
    expect(inv).toEqual({ ok: true, cmd: 'bun', argv: [...bunIsolationArgs(), path.join(ROOT, 'bin', 'gstack-decision-log'), '--help'] });
    expect(bunIsolationArgs('linux')).toEqual(['--no-env-file', '--config=/dev/null']);
    expect(bunIsolationArgs('win32')).toEqual(['--no-env-file', `--config=${emptyBunConfig('win32')}`]);
    expect(browseEmptyBunConfig('linux')).toBe(emptyBunConfig('linux'));
    expect(fs.statSync(browseEmptyBunConfig('win32')).size).toBe(0);
    expect(fs.statSync(emptyBunConfig('win32')).size).toBe(0);
  });

  test('the Windows empty bunfig outlives the process that named it, so a detached child can still read it', () => {
    const lib = path.join(ROOT, 'lib', 'bun-isolation.ts');
    const made = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', `const { emptyBunConfig } = await import(${JSON.stringify(lib)}); console.log(emptyBunConfig('win32'));`], { encoding: 'utf8', timeout: 30_000 });
    expect(made.status).toBe(0);
    const file = made.stdout.trim();
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).size).toBe(0);
    fs.writeFileSync(file, 'preload = ["./x.ts"]\n');
    expect(emptyBunConfig('win32')).toBe(file);
    expect(fs.statSync(file).size).toBe(0);
  });

  test('every bun build --compile disables .env and bunfig autoload', () => {
    const offenders: string[] = [];
    for (const f of TRACKED) {
      if (!/(^|\/)(package\.json|setup|[^/]+\.sh|[^/]+\.ya?ml)$/.test(f) && !/(^|\/)scripts\/build[^/]*\.ts$/.test(f)) continue;
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line) || !/\bbuild --compile\b/.test(line)) return;
        let cmd = line;
        for (let j = i; /\\\s*$/.test(lines[j] ?? '') && j + 1 < lines.length; j++) cmd += lines[j + 1];
        for (const one of cmd.split(/&&|;/).filter(c => /\bbuild --compile\b/.test(c))) {
          if (!one.includes('--no-compile-autoload-dotenv') || !one.includes('--no-compile-autoload-bunfig')) offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
