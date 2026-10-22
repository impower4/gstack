/**
 * Copy bin/gstack-office-hours-review and every local module it imports into a
 * fixture, so the copied formatter loads the same modules as the checkout.
 * Marathon 39032308051 copied a hand-kept file list that missed
 * lib/spec-review-cap.ts, and every formatter command failed at module load.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');

export function copyOfficeHoursFormatter(fixtureRoot: string): string {
  const pending = ['bin/gstack-office-hours-review'];
  const copied = new Set<string>();
  while (pending.length) {
    const relative = pending.pop()!;
    if (copied.has(relative)) continue;
    copied.add(relative);
    const source = path.join(ROOT, relative);
    const target = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    for (const [, specifier] of fs.readFileSync(source, 'utf8').matchAll(/\b(?:from|import)\s+'(\.\.?\/[^']+)'/g)) {
      const resolved = path.relative(ROOT, path.resolve(path.dirname(source), specifier!));
      pending.push(path.extname(resolved) ? resolved : `${resolved}.ts`);
    }
  }
  const formatter = path.join(fixtureRoot, 'bin/gstack-office-hours-review');
  fs.chmodSync(formatter, 0o755);
  return formatter;
}
