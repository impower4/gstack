/**
 * source-root — the gstack checkout behind an install root. setup records the
 * source checkout in `<install root>/.source-path` (`_link_runtime_dists`,
 * Windows copy roots and the Copilot root); files that live only in the
 * checkout (autoplan/DRIVER.md) resolve through it. A root without the file,
 * or whose recorded path no longer exists, is its own source.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveSourceRoot(root: string): string {
  try {
    const recorded = fs.readFileSync(path.join(root, '.source-path'), 'utf8').split('\n', 1)[0]!.trim();
    if (recorded && fs.statSync(recorded).isDirectory()) return path.resolve(recorded);
  } catch { /* no record, or a stale one */ }
  return root;
}
