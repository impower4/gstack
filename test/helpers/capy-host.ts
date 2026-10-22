/**
 * capy-host — one simulated Capy cloud host for every test that exercises
 * install, upgrade, runtime or unattended-workflow behavior. The shape is the
 * field host: Bun 1.3.14 first on PATH (the image's /usr/local/bin/bun), no
 * Codex CLI, an ephemeral home, and optionally a verified Bun 1.4.2 in
 * `$HOME/.bun/bin` that is NOT on PATH (what gstack-capy-install leaves
 * behind). The stub Bun answers `--version` with the simulated version and
 * forwards everything else to the Bun running the test, so TypeScript bins
 * still run. Real git, jq, unzip, sha256sum and coreutils stay reachable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CapyHost {
  base: string; home: string; stateRoot: string; systemBin: string; bunInstallBin: string;
  env: Record<string, string>;
  /** PATH with the verified Bun first, the way a GSTACK_LAUNCH-prefixed command sees it. */
  launchPath: string;
  cleanup(): void;
}

export interface CapyHostOptions {
  /** Version the PATH Bun reports (the image's /usr/local/bin/bun). Default 1.3.14. */
  systemBun?: string;
  /** Install a verified Bun reporting this version in $HOME/.bun/bin (off PATH). Default none. */
  verifiedBun?: string;
  /** Extra tool names to hide from the inherited PATH (bun and codex are always hidden). */
  hide?: string[];
}

const writeScript = (file: string, lines: string[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['#!/usr/bin/env bash', ...lines].join('\n') + '\n', { mode: 0o755 });
};

/** The inherited PATH with every directory that holds a hidden tool replaced by a symlink farm without it. */
export function pathWithout(base: string, hide: string[]): string {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir, i) => {
    if (!hide.some(n => fs.existsSync(path.join(dir, n)))) return dir;
    const shim = path.join(base, `host-path-${i}`);
    fs.mkdirSync(shim, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (hide.includes(name)) continue;
      try { fs.symlinkSync(path.join(dir, name), path.join(shim, name)); } catch { /* unreadable entry */ }
    }
    return shim;
  }).join(path.delimiter);
}

/** A Bun stand-in: `--version` prints `version`; anything else runs the real Bun under test. */
export function writeBunStub(file: string, version: string): void {
  writeScript(file, [`[ "\${1:-}" = --version ] && { echo "${version}"; exit 0; }`, `exec "${process.execPath}" "$@"`]);
}

export function capyHost(opts: CapyHostOptions = {}): CapyHost {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capy-host-')));
  const home = path.join(base, 'home');
  const stateRoot = path.join(home, '.gstack');
  const systemBin = path.join(base, 'usr-local-bin');
  const bunInstallBin = path.join(home, '.bun', 'bin');
  fs.mkdirSync(home, { recursive: true });
  writeBunStub(path.join(systemBin, 'bun'), opts.systemBun ?? '1.3.14');
  if (opts.verifiedBun) writeBunStub(path.join(bunInstallBin, 'bun'), opts.verifiedBun);
  const inherited = pathWithout(base, ['bun', 'codex', ...(opts.hide ?? [])]);
  const env: Record<string, string> = {
    PATH: [systemBin, inherited].join(path.delimiter),
    HOME: home, TMPDIR: base, BUN_INSTALL: path.join(home, '.bun'),
    GSTACK_HOME: stateRoot, GSTACK_STATE_ROOT: stateRoot, GSTACK_EPHEMERAL: '1',
    GSTACK_LEASE_DIR: path.join(base, 'gstack-leases'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
  return {
    base, home, stateRoot, systemBin, bunInstallBin, env,
    launchPath: [bunInstallBin, env.PATH].join(path.delimiter),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
