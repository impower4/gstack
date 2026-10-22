/**
 * Installs stuck on the Git Bash hook-check false positive (#3088, #3100) run
 * their own old updater and old /gstack-upgrade text, so code on main cannot
 * reach them; the troubleshooting page their held-update and setup messages
 * link to can. Both anchors name the false positive and give one copy-paste
 * recovery, which also covers /gstack-upgrade's "is not a gstack checkout".
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/troubleshooting.md'), 'utf8');
const RECOVERY = 'cd ~/.claude/skills/gstack && git pull --ff-only --autostash && ./setup';

function section(anchor: string): string {
  const start = DOC.indexOf(`<a id="${anchor}"></a>`);
  expect(start).toBeGreaterThan(-1);
  const next = DOC.indexOf('<a id="', start + 1);
  return DOC.slice(start, next === -1 ? undefined : next);
}

describe('troubleshooting: the Git Bash hook false positive', () => {
  for (const anchor of ['setup-hook-does-not-parse', 'auto-update-hook-does-not-parse']) {
    test(`#${anchor} names the false positive and the one recovery`, () => {
      const text = section(anchor);
      expect(text).toContain('Git Bash');
      expect(text).toContain('from 1.91.31');
      expect(text).toContain('bun could not bundle the TypeScript entry');
      expect(text).toContain(RECOVERY);
      expect(text).toContain('is not a gstack checkout');
      expect(text).not.toContain('Nothing to do locally');
    });
  }

  test('#upgrade-not-a-checkout points Git Bash users at the same recovery', () => {
    expect(section('upgrade-not-a-checkout')).toContain('cd <install dir> && git pull --ff-only --autostash && ./setup');
  });

  test('every anchor the updater, setup and doctor link to exists', () => {
    const sources = ['bin/gstack-session-update', 'setup', 'bin/gstack-doctor', 'bin/gstack-install-registry.sh'];
    const anchors = new Set(sources.flatMap(f => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/troubleshooting\.md#([a-z0-9-]+)/g)].map(m => m[1]!)));
    for (const a of ['auto-update-hook-does-not-parse', 'auto-update-hook-check-unavailable', 'setup-hook-does-not-parse', 'setup-runtime-root-contains-checkout']) expect(anchors.has(a)).toBe(true);
    for (const a of anchors) expect(DOC, a).toContain(`<a id="${a}"></a>`);
  });
});
