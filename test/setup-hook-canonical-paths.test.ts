/**
 * Canonical-only hook registration (phantom-hooks fix, v1.67.2).
 *
 * Static tripwires over `setup` and `bin/gstack-settings-hook`. The defect
 * class these pin against: hook commands baked from the SETUP-TIME tree
 * (`$SOURCE_GSTACK_DIR` = `pwd -P` of the running tree) into the user's
 * GLOBAL ~/.claude/settings.json. Conductor worktrees are ephemeral, so every
 * deleted workspace left dead hooks erroring on each AskUserQuestion fire.
 *
 * The contract:
 *   - hook registration paths come ONLY from `_hook_command_path` (canonical
 *     install: ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/gstack) — an
 *     ephemeral tree can never be baked in; missing canonical = skip + log.
 *   - setup heals BEFORE any tag-presence guard (`prune-stale --repoint`),
 *     so a dead tagged entry can't block re-registration forever.
 *   - the heal is visible when it changes anything (no full output
 *     suppression at the call site).
 *   - the settings-hook binary's bun scripts share one JS prelude (KNOWN_HOOKS
 *     identity table + helpers) so the dedupe key and the prune predicate
 *     cannot drift.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const setupSrc = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const ROOT_HELPER = path.join(ROOT, 'bin', 'gstack-claude-root.sh');
const rootHelperSrc = fs.readFileSync(ROOT_HELPER, 'utf-8');
const memorableSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-memorable'), 'utf-8');
const hookBinSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), 'utf-8');
const uninstallSrc = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-uninstall'), 'utf-8');

describe('setup: canonical-only hook paths', () => {
  test('CANONICAL_GSTACK_ROOT honors CLAUDE_CONFIG_DIR with ~/.claude fallback', () => {
    expect(rootHelperSrc).toContain('"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/gstack"');
  });

  test('setup and gstack-memorable take the root from the one sourced helper', () => {
    for (const [src, sourceLine] of [
      [setupSrc, '. "$SOURCE_GSTACK_DIR/bin/gstack-claude-root.sh" ||'],
      [memorableSrc, '. "$(dirname "$0")/gstack-claude-root.sh" ||'],
    ]) {
      expect(src).toContain(sourceLine);
      expect(src).toContain('CANONICAL_GSTACK_ROOT="$(gstack_canonical_claude_root)"');
      expect(src).not.toContain('CANONICAL_GSTACK_ROOT="${CLAUDE_CONFIG_DIR');
    }
  });

  describe('gstack_canonical_claude_root', () => {
    function installAt(root: string) {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'gstack-session-update'), '#!/bin/sh\n', { mode: 0o755 });
    }

    function resolve(home: string, configDir?: string): string {
      const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home };
      if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
      const r = spawnSync('bash', ['-c', 'set -u; . "$1" && gstack_canonical_claude_root', '_', ROOT_HELPER.replace(/\\/g, '/')],
        { env, encoding: 'utf-8', timeout: 10_000 });
      expect(r.status).toBe(0);
      return r.stdout.replace(/\n$/, '');
    }

    function withHome(fn: (home: string) => void) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-canon-'));
      try {
        installAt(path.join(home, '.claude', 'skills', 'gstack'));
        fn(home);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }

    test('no CLAUDE_CONFIG_DIR resolves to the $HOME install', () => {
      withHome((home) => {
        expect(resolve(home)).toBe(path.join(home, '.claude', 'skills', 'gstack'));
      });
    });

    test('a per-session config dir linking back to the $HOME install resolves to the $HOME spelling', () => {
      withHome((home) => {
        const session = path.join(home, 'session-1234');
        fs.mkdirSync(session);
        fs.symlinkSync(path.join(home, '.claude', 'skills'), path.join(session, 'skills'));
        expect(resolve(home, session)).toBe(path.join(home, '.claude', 'skills', 'gstack'));
      });
    });

    test('a config dir with its own install keeps that install', () => {
      withHome((home) => {
        const other = path.join(home, 'other-config');
        installAt(path.join(other, 'skills', 'gstack'));
        expect(resolve(home, other)).toBe(path.join(other, 'skills', 'gstack'));
      });
    });

    test('a config dir with no install falls back to the $HOME install', () => {
      withHome((home) => {
        const empty = path.join(home, 'empty-config');
        fs.mkdirSync(empty);
        expect(resolve(home, empty)).toBe(path.join(home, '.claude', 'skills', 'gstack'));
      });
    });

    test('with no $HOME install the config-dir spelling stands, even when it is empty', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-canon-'));
      try {
        const empty = path.join(home, 'empty-config');
        fs.mkdirSync(empty);
        expect(resolve(home, empty)).toBe(path.join(empty, 'skills', 'gstack'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  test('_hook_command_path body never references the running tree', () => {
    const start = setupSrc.indexOf('_hook_command_path() {');
    expect(start).toBeGreaterThan(-1);
    const end = setupSrc.indexOf('\n}', start);
    const body = setupSrc.slice(start, end);
    expect(body).not.toContain('SOURCE_GSTACK_DIR');
    expect(body).toContain('CANONICAL_GSTACK_ROOT');
  });

  test('every hook var routes through _hook_command_path; no raw SOURCE_GSTACK_DIR hook assignment remains', () => {
    for (const rel of [
      'hosts/claude/hooks/question-log-hook',
      'hosts/claude/hooks/question-preference-hook',
      'hosts/claude/hooks/auq-error-fallback-hook',
      'hosts/claude/hooks/timeline-stop-hook',
      'bin/gstack-session-update',
    ]) {
      expect(setupSrc).toContain(`$(_hook_command_path ${rel}`);
    }
    // The bug: FOO_HOOK="$SOURCE_GSTACK_DIR/hosts/claude/hooks/..."
    expect(setupSrc).not.toMatch(/="\$SOURCE_GSTACK_DIR\/hosts\/claude\/hooks\//);
    expect(setupSrc).not.toMatch(/HOOK_CMD="(bash )?\$SOURCE_GSTACK_DIR\/bin\/gstack-session-update"/);
  });

  test('SessionStart registers via schema-aware add-event under its identity source', () => {
    expect(setupSrc).toMatch(
      /add-event --event SessionStart --command "\$HOOK_CMD" --source gstack-session-update/,
    );
  });

  test('every add-event source in setup has a KNOWN_HOOKS table row', () => {
    // Future-hook tripwire: a new add-event registration whose hook basename
    // is missing from the identity table would be invisible to the healer,
    // the --no-team sweep, and uninstall.
    const rels = [...setupSrc.matchAll(/_hook_command_path (\S+)/g)].map((m) => m[1]);
    expect(rels.length).toBeGreaterThanOrEqual(5);
    for (const rel of rels) {
      const basename = rel.split('/').pop()!;
      expect(hookBinSrc).toContain(`"${basename}":`);
    }
  });
});

describe('setup: heal-first ordering + visibility', () => {
  test('prune-stale --repoint runs before any list-sources guard or add-event registration', () => {
    const heal = setupSrc.indexOf('prune-stale --repoint');
    const firstGuard = setupSrc.indexOf('list-sources');
    const firstAdd = setupSrc.indexOf('add-event');
    expect(heal).toBeGreaterThan(-1);
    expect(heal).toBeLessThan(firstGuard);
    expect(heal).toBeLessThan(firstAdd);
  });

  test('the heal call site is not output-suppressed (zero silent settings mutations)', () => {
    const lines = setupSrc.split('\n').filter((l) => l.includes('prune-stale --repoint'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line).not.toContain('>/dev/null');
      expect(line).not.toContain('2>&1');
    }
    // Captured for the change-only summary line.
    expect(setupSrc).toMatch(/_HEAL_OUT=\$\("\$SETTINGS_HOOK" prune-stale/);
    expect(setupSrc).toContain('healed hook registrations');
  });

  test('heal counters use the ${VAR:-0} idiom, never `grep -c || echo 0`', () => {
    // Prior learning grep-c-double-emit-fail-open: `grep -c ... || echo 0`
    // double-emits "0\n0" on no-match and breaks numeric guards open.
    expect(setupSrc).toContain('${_HEAL_REMOVED:-0}');
    expect(setupSrc).toContain('${_HEAL_REPOINTED:-0}');
    const healRegion = setupSrc.slice(
      setupSrc.indexOf('_HEAL_OUT='),
      setupSrc.indexOf('healed hook registrations'),
    );
    expect(healRegion).not.toMatch(/grep -c .*\|\| echo 0/);
  });

  test('--no-team teardown includes the auq source and the identity sweep', () => {
    const idx = setupSrc.indexOf('# Also tear down plan-tune');
    expect(idx).toBeGreaterThan(-1);
    const slice = setupSrc.slice(idx, idx + 900);
    expect(slice).toContain('remove-source --source plan-tune-cathedral');
    expect(slice).toContain('remove-source --source auq-error-fallback');
    expect(slice).toContain('remove-source --source gstack-timeline-stop');
    expect(slice).toContain('prune-stale --all');
  });
});

describe('gstack-settings-hook: shared prelude (dedupe key == prune predicate)', () => {
  test('every bun script call site uses the shared JS prelude concatenation', () => {
    const codeLines = hookBinSrc.split('\n').filter((l) => !l.trim().startsWith('#'));
    const bunCalls = codeLines.filter((l) => l.includes('bun --no-env-file --config=/dev/null -e '));
    const preludeCalls = codeLines.filter((l) => l.includes(`bun --no-env-file --config=/dev/null -e "$_HOOK_JS_PRELUDE"'`));
    expect(bunCalls.length).toBeGreaterThanOrEqual(6);
    expect(preludeCalls.length).toBe(bunCalls.length);
  });

  test('the prelude contains no single quotes (single-quoted shell assignment)', () => {
    const start = hookBinSrc.indexOf("_HOOK_JS_PRELUDE='");
    expect(start).toBeGreaterThan(-1);
    const end = hookBinSrc.indexOf("\n'", start);
    const prelude = hookBinSrc.slice(start + "_HOOK_JS_PRELUDE='".length, end);
    expect(prelude).not.toContain("'");
    // And no shell-expansion hazards inside the double-quoted call-site expansion.
    expect(prelude).not.toContain('`');
  });

  test('KNOWN_HOOKS table carries all six identities with source+event+relpath', () => {
    for (const [name, source, event] of [
      ['question-log-hook', 'plan-tune-cathedral', 'PostToolUse'],
      ['question-preference-hook', 'plan-tune-cathedral', 'PreToolUse'],
      ['auq-error-fallback-hook', 'auq-error-fallback', 'PostToolUse'],
      ['timeline-stop-hook', 'gstack-timeline-stop', 'Stop'],
      ['gstack-session-update', 'gstack-session-update', 'SessionStart'],
      ['memorable-user-prompt-hook', 'gstack-memorable', 'UserPromptSubmit'],
    ]) {
      const rowStart = hookBinSrc.indexOf(`"${name}":`);
      expect(rowStart).toBeGreaterThan(-1);
      const row = hookBinSrc.slice(rowStart, hookBinSrc.indexOf('}', rowStart));
      expect(row).toContain(`source: "${source}"`);
      expect(row).toContain(`event: "${event}"`);
      expect(row).toContain('relpath: "');
    }
  });
});

describe('gstack-uninstall: hook cleanup runs before install-root deletion', () => {
  test('the settings cleanup block precedes every install-root rm -rf', () => {
    // Pre-fix bug: SETTINGS_HOOK=$(dirname "$0")/gstack-settings-hook resolved
    // INSIDE the install root, which was already deleted by the time cleanup
    // ran — a real global uninstall silently orphaned every hook.
    const cleanup = uninstallSrc.indexOf('Remove gstack hooks from Claude Code settings');
    const rootDelete = uninstallSrc.indexOf('rm -rf "$CLAUDE_SKILLS/gstack"');
    expect(cleanup).toBeGreaterThan(-1);
    expect(rootDelete).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(rootDelete);
  });

  test('uninstall removes every named source and sweeps untagged strays', () => {
    expect(uninstallSrc).toContain('remove-source --source plan-tune-cathedral');
    expect(uninstallSrc).toContain('remove-source --source auq-error-fallback');
    expect(uninstallSrc).toContain('remove-source --source gstack-timeline-stop');
    expect(uninstallSrc).toContain('remove-source --source gstack-memorable');
    expect(uninstallSrc).toContain('prune-stale --all');
  });
});

describe('the defect-class warning is written down where the next author will see it', () => {
  test('setup carries the never-register-tree-relative-paths warning', () => {
    expect(setupSrc).toMatch(/NEVER register .*SOURCE_GSTACK_DIR.*hook paths/);
  });
});

describe('matcher-literal drift tripwire (review-army)', () => {
  test("every --matcher literal in setup equals its KNOWN_HOOKS row's matcher", () => {
    // gsOwnedRow requires an EXACT matcher match — if setup's registration
    // matcher drifts from the table row, identity re-pointing/pruning silently
    // stops recognizing the hook and the phantom-duplicate class returns.
    const rowMatcher = (name: string) => {
      const rowStart = hookBinSrc.indexOf(`"${name}":`);
      expect(rowStart).toBeGreaterThan(-1);
      const row = hookBinSrc.slice(rowStart, hookBinSrc.indexOf('}', rowStart));
      return row.match(/matcher: "([^"]*)"/)![1];
    };
    const pairs: Array<[string, string]> = [
      ['question-log-hook', '(AskUserQuestion|mcp__.*__AskUserQuestion)'],
      ['question-preference-hook', '(AskUserQuestion|mcp__.*__AskUserQuestion)'],
      ['auq-error-fallback-hook', '(AskUserQuestion|mcp__.*__AskUserQuestion)'],
    ];
    for (const [name, expected] of pairs) {
      expect(rowMatcher(name)).toBe(expected);
    }
    // And setup registers those hooks with exactly that matcher literal.
    const matcherLiterals = [...setupSrc.matchAll(/--matcher '([^']+)'/g)].map((m) => m[1]);
    expect(matcherLiterals.length).toBeGreaterThanOrEqual(3);
    for (const lit of matcherLiterals) {
      expect(lit).toBe('(AskUserQuestion|mcp__.*__AskUserQuestion)');
    }
  });
});
