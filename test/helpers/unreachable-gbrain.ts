/**
 * Make `gbrain` resolve to a stub that fails at once, so tests that model an
 * unreachable brain never reach a developer's installed gbrain (#2829). Call in
 * beforeEach and pass the returned directory to the cleanup in afterEach;
 * test-setup.ts restores PATH after every test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function useUnreachableGbrain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-unreachable-gbrain-'));
  fs.writeFileSync(path.join(dir, 'gbrain'), '#!/bin/sh\necho "gbrain unreachable (test stub)" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gbrain.cmd'), '@echo gbrain unreachable (test stub) 1>&2\r\n@exit /b 1\r\n');
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  process.env[key] = `${dir}${path.delimiter}${process.env[key] ?? ''}`;
  return dir;
}

export function removeUnreachableGbrain(dir: string | undefined): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
