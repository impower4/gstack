import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Tripwire for the port extraction snippet in /open-gstack-browser.
//
// Step 2 reads the port out of .gstack/browse.json to tell the user which one
// the Side Panel needs. A `grep -o '"port":[0-9]*'` pattern cannot match:
// every writer of that file in browse/src/server.ts serializes with
// `JSON.stringify(state, null, 2)`, so the real bytes are `"port": 34567`
// — colon, SPACE, digits. (The skill no longer reads the pid at all: the
// browse CLI owns daemon liveness and replacement.)
//
// So this test does not match strings; it RUNS the snippets the skill tells
// the agent to run, against a state file written exactly the way the server
// writes one, and asserts the values come back out.

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = path.join(ROOT, 'open-gstack-browser', 'SKILL.md');
const TMPL = path.join(ROOT, 'open-gstack-browser', 'SKILL.md.tmpl');

/** The exact shape browse/src/server.ts writes (JSON.stringify(state, null, 2)). */
function writeStateFile(dir: string, pid: number, port: number): string {
  const file = path.join(dir, 'browse.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ pid, port, token: 'not-a-real-token', mode: 'headed' }, null, 2),
  );
  return file;
}

/** Pull the grep pipeline for `field` out of the skill prose and run it. */
function extractViaSkill(source: string, field: 'port', stateFile: string): string {
  const line = source
    .split('\n')
    .find((l) => l.includes(`grep -o '"${field}":`));
  expect(line, `no ${field} extraction line found in the skill`).toBeDefined();

  // Keep only the pipeline itself: everything from the first `grep` on, so the
  // surrounding shell (cat of a git-root path, variable assignment) does not
  // have to be reproduced here.
  const pipeline = line!.slice(line!.indexOf('grep -o'));
  const script = `cat ${JSON.stringify(stateFile)} | ${pipeline.replace(/\)$/, '')}`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 }).trim();
}

describe('/open-gstack-browser state-file extraction', () => {
  for (const [label, file] of [['generated', SKILL], ['template', TMPL]] as const) {
    test(`${label}: the port survives the pretty-printed state file`, () => {
      const source = fs.readFileSync(file, 'utf-8');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-state-'));
      try {
        const stateFile = writeStateFile(dir, 12060, 34567);
        expect(extractViaSkill(source, 'port', stateFile)).toBe('34567');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('server.ts still writes the state file pretty-printed', () => {
    // If a refactor ever switches to compact JSON, the snippets above keep
    // working (the pattern tolerates zero spaces too) — but the reason this
    // test exists changes, so make the coupling visible instead of implicit.
    const server = fs.readFileSync(path.join(ROOT, 'browse', 'src', 'server.ts'), 'utf-8');
    expect(server).toContain('JSON.stringify(state, null, 2)');
  });
});
