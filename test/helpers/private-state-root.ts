/**
 * Point GSTACK_HOME at a fresh private directory for every test in the calling
 * file, and restore the previous value afterwards. Use in test files whose
 * code under test writes state (error logs, caches) through the state root, so
 * a run never appends to the developer's real ~/.gstack (#2895).
 */
import { afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function usePrivateStateRoot(): { readonly dir: string } {
  const state = { dir: '' };
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.GSTACK_HOME;
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-private-state-'));
    process.env.GSTACK_HOME = state.dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = previous;
    fs.rmSync(state.dir, { recursive: true, force: true });
  });
  return state;
}
