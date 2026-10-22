import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
// Test-only base control; neither source is run as an account updater.
const SCRIPT = process.env.GSTACK_HEARTBEAT_TEST_SCRIPT ?? path.join(ROOT, 'bin/gstack-session-update');
const FIXTURE = path.join(ROOT, 'test/fixtures/session-update-heartbeat.sh');

describe.skipIf(process.platform === 'win32')('session updater heartbeat lifecycle', () => {
  for (const mode of ['normal', 'failure', 'TERM', 'HUP', 'reclaimed'] as const) {
    test(`${mode}: reap owned heartbeat and sleeper; preserve unrelated process and lock owner`, () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-heartbeat-'));
      try {
        fs.chmodSync(base, 0o700);
        const result = spawnSync('bash', [FIXTURE, SCRIPT, mode, base], {
          encoding: 'utf8', timeout: 5_000,
          env: { PATH: '/usr/bin:/bin' },
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const status = mode === 'failure' ? 7 : mode === 'TERM' ? 143 : mode === 'HUP' ? 129 : 0;
        expect(result.stdout).toBe(`closed status=${status} sentinel=alive heartbeat=absent sleeper=absent\n`);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }, 7_000);
  }
});
