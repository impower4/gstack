/**
 * #3102 / D5: consent is enforced by the binaries that send, so no generated
 * skill may start an outside CLI any other way. In every rendered bash fence
 * (Claude and Codex hosts), `codex exec|review` at a command position must run
 * behind `"$_CODEX_PROBE" run-with-timeout`, and the Claude CLI is never run
 * directly: Claude Code reviews go through bin/gstack-claude-code. Prose and
 * quoted strings are ignored; only command positions count.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-send-boundary-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const POSITION = String.raw`(?:^|[;&|]\s*|\$\(\s*|\b(?:then|do|else|if|!)\s+)`;
const CODEX = new RegExp(`${POSITION}(?:g?timeout\\s+\\S+\\s+)?((?:"\\$_CODEX_PROBE"\\s+run-with-timeout\\s+(?:--user-invoked\\s+)?(?:--effort\\s+\\w+\\s+(?:--request-effort\\s+'[^']*'\\s+)?)?\\d+\\s+)?)codex\\s+(?:exec|review)\\b`);
/** A headless Claude prompt run (`claude -p`, `--print`, or a prompt on stdin), or the resolved CLAUDE_BIN; `claude mcp|auth|config` manage the CLI and send no repository content. */
const CLAUDE = new RegExp(`${POSITION}(?:command\\s+)?(?:"\\$\\{?CLAUDE_BIN\\}?"|claude(?=\\s)(?![^|;&]*\\s(?:mcp|auth|config|update|doctor)\\b)[^|;&]*(?:\\s(?:-p|--print)\\b|\\s<\\s*\\S))`);

/** Lines in bash fences that start an outside CLI without its consent-enforcing wrapper. */
function directLaunches(markdown: string): string[] {
  const bad: string[] = [];
  for (const match of markdown.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const raw of match[1]!.split('\n')) {
      const line = raw.trim().replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, m => (m.startsWith('"$') ? m : '""'));
      if (line.startsWith('#')) continue;
      const codex = CODEX.exec(line);
      if (codex && !codex[1]) bad.push(raw.trim());
      if (CLAUDE.test(line)) bad.push(raw.trim());
    }
  }
  return bad;
}

function render(host: string): string[] {
  const out = path.join(TMP, host);
  const r = spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', host, '--out-dir', out], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`render ${host} failed: ${r.stderr}`);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) files.push(p);
    }
  };
  walk(out);
  return files;
}

describe('generated skills start outside CLIs only through the consent-enforcing binaries', () => {
  for (const host of ['claude', 'codex']) {
    test(`${host}: no direct codex exec/review or Claude CLI launch`, () => {
      const files = render(host);
      expect(files.length).toBeGreaterThan(20);
      const bad = files.flatMap(f => directLaunches(fs.readFileSync(f, 'utf8')).map(l => `${path.relative(TMP, f)}: ${l}`));
      expect(bad).toEqual([]);
      const wrapped = files.filter(f => /run-with-timeout (?:--user-invoked )?(?:--effort \w+ (?:--request-effort '[^']*' )?)?\d+ codex|gstack-claude-code/.test(fs.readFileSync(f, 'utf8')));
      expect(wrapped.length).toBeGreaterThan(5);
    });
  }

  test('negative controls: direct launches are flagged, wrapped ones and prose are not', () => {
    const fence = (body: string) => '```bash\n' + body + '\n```';
    expect(directLaunches(fence('codex exec - -C "$_REPO_ROOT" < prompt'))).toHaveLength(1);
    expect(directLaunches(fence('timeout 300 codex review --base main'))).toHaveLength(1);
    expect(directLaunches(fence('OUT=$(codex exec "review this")'))).toHaveLength(1);
    expect(directLaunches(fence('if true; then codex review --base main; fi'))).toHaveLength(1);
    expect(directLaunches(fence('claude -p "review" < prompt'))).toHaveLength(1);
    expect(directLaunches(fence('"$CLAUDE_BIN" -p < prompt'))).toHaveLength(1);
    expect(directLaunches(fence('claude < prompt > out'))).toHaveLength(1);
    expect(directLaunches(fence('claude mcp add --scope user gbrain -- "$GBRAIN_BIN" serve'))).toHaveLength(0);
    expect(directLaunches(fence('"$_CODEX_PROBE" run-with-timeout 540 codex exec - -s read-only'))).toHaveLength(0);
    expect(directLaunches(fence('"$_CODEX_PROBE" run-with-timeout --user-invoked 330 codex review --base main'))).toHaveLength(0);
    expect(directLaunches(fence('"$CLAUDE_RUNNER" --cwd "$_REPO_ROOT" --access none --timeout-ms 600000 < prompt'))).toHaveLength(0);
    expect(directLaunches(fence('echo "run by hand: codex exec - -C $_REPO_ROOT < $PROMPT_FILE" >&2'))).toHaveLength(0);
    expect(directLaunches('Run `codex exec` yourself.\n')).toHaveLength(0);
  });
});
