#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * gstack-windows-bash — the doctor's `windows bash` row: the Git Bash gstack's
 * TypeScript hands its bash scripts to on Windows, and what chose it
 * (lib/script-invocation.ts resolveWindowsBash, the one resolver).
 *
 *   gstack-windows-bash [--probe <file>]
 *
 * Prints `WINDOWS_BASH: <path>` and `WINDOWS_BASH_SOURCE: <source>` (exit 0),
 * or `WINDOWS_BASH_REFUSED: <BASH_UNAVAILABLE line listing each candidate>`
 * (exit 1); `WINDOWS_BASH_WARNING: <text>` when GSTACK_GIT_BASH and
 * GSTACK_BASH differ. --probe reads the discovery inputs from a JSON file
 * ({exists, gitExecPath, which, uname}, the shape of
 * test/fixtures/windows-bash-resolution.json) so tests drive it on any OS;
 * without it the resolver probes this machine. Exit 2 on usage.
 */
import * as fs from 'node:fs';
import { resolveWindowsBash, type BashProbe } from '../lib/script-invocation';

const usage = 'usage: gstack-windows-bash [--probe <file>]';
const args = process.argv.slice(2);
let probe: BashProbe = {};
if (args[0] === '-h' || args[0] === '--help') { console.log(usage); process.exit(0); }
if (args.length > 0) {
  if (args[0] !== '--probe' || args.length !== 2) { console.error(usage); process.exit(2); }
  const p = JSON.parse(fs.readFileSync(args[1], 'utf8')) as { exists?: string[]; gitExecPath?: string | null; which?: Record<string, string>; uname?: Record<string, string> };
  const exists = new Set(p.exists ?? []);
  probe = {
    exists: f => exists.has(f),
    gitExecPath: () => p.gitExecPath ?? null,
    which: cmd => p.which?.[cmd] ?? null,
    uname: bash => p.uname?.[bash] ?? null,
  };
}

const res = resolveWindowsBash(probe);
if (res.warning) console.log(`WINDOWS_BASH_WARNING: ${res.warning}`);
if (!res.ok) {
  console.log(`WINDOWS_BASH_REFUSED: ${res.message}`);
  process.exit(1);
}
console.log(`WINDOWS_BASH: ${res.bash}`);
console.log(`WINDOWS_BASH_SOURCE: ${res.source}`);
