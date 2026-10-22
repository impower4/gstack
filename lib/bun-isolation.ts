/**
 * How gstack starts Bun (GSTA-56). Bun configures itself from the directory it
 * starts in: `.env`, `.env.local` and `.env.<NODE_ENV>` become environment
 * variables, and a `bunfig.toml` preload runs code before the entry point.
 * gstack runs inside the user's repository, so that directory belongs to the
 * code under review. Every Bun gstack starts passes --no-env-file and an empty
 * --config: shebangs and shell callers spell it
 * `bun --no-env-file --config=/dev/null`, TypeScript spawns use
 * bunIsolationArgs(). test/bun-entry-isolation.test.ts holds every entry point
 * to that form.
 *
 * POSIX passes /dev/null. Native Windows has no /dev/null and `--config=NUL`
 * panicked Bun 1.3.10 while parsing the flag (#3085), so a TypeScript spawn on
 * Windows gets an empty bunfig in a fixed directory under the per-user temp
 * root, re-checked to be a zero-byte regular file before each spawn; anything
 * else is replaced, so the file cannot become a preload vector. The file is
 * never removed: a detached child (the timeline hook's repair) reads it after
 * the parent that named it has exited.
 * browse/src/bun-child-config.ts keeps its own copy of emptyBunConfig(): the
 * Windows native cookie qualification binds that file's bytes and bundles it
 * without lib/.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isEmptyRegularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size === 0;
  } catch {
    return false;
  }
}

export function emptyBunConfig(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return '/dev/null';
  const dir = path.join(os.tmpdir(), 'gstack-empty-bunfig');
  const file = path.join(dir, 'bunfig.toml');
  if (isEmptyRegularFile(file)) return file;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`empty Bun config directory ${dir} is not a directory`);
  fs.rmSync(file, { recursive: true, force: true });
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (!isEmptyRegularFile(file)) throw new Error(`empty Bun config ${file} is not a zero-byte file`);
  return file;
}

/** The flags that keep a spawned Bun from reading the working directory's .env and bunfig.toml. */
export function bunIsolationArgs(platform: NodeJS.Platform = process.platform): string[] {
  return ['--no-env-file', `--config=${emptyBunConfig(platform)}`];
}
