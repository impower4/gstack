/**
 * One spelling for paths on Windows shells. Git Bash (MSYS) spells a drive
 * path /c/x, native programs (git.exe, bun.exe) answer C:/x or C:\x, and MSYS
 * converts /c/x arguments to C:/x before a native program starts. Comparing two
 * spellings as strings is the bug class behind #3088, #3100 and #3101.
 * Bash twin: bin/gstack-path-spelling.sh.
 */
import * as fs from 'node:fs';

/** Git Bash's drive spelling (/c/x) of a native path on Windows; unchanged elsewhere. */
export function shellPath(value: string, platform: string = process.platform): string {
  if (platform !== 'win32') return value;
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):(?=\/|$)/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/** The native spelling (C:/x) of a Git Bash drive path on Windows; unchanged elsewhere. */
export function nativePath(value: string, platform: string = process.platform): string {
  if (platform !== 'win32') return value;
  const slashed = value.replace(/\\/g, '/');
  const drive = /^\/([A-Za-z])(?=\/|$)/.exec(slashed);
  if (!drive) return slashed;
  return `${drive[1]!.toUpperCase()}:${slashed.slice(2) || '/'}`;
}

/** True when a and b name the same file: filesystem identity when both exist, else equal spellings. */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const left = nativePath(a, platform);
  const right = nativePath(b, platform);
  try {
    const sa = fs.statSync(left, { bigint: true });
    const sb = fs.statSync(right, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    const trim = (v: string) => (v.length > 1 ? v.replace(/\/+$/, '') : v);
    return platform === 'win32'
      ? trim(left).toLowerCase() === trim(right).toLowerCase()
      : trim(left) === trim(right);
  }
}
