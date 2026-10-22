import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const source = (name: string) => readFileSync(join(root, 'land-and-deploy', name), 'utf8');

describe('land-and-deploy handles a recorded command deploy trigger', () => {
  test('Step 5 routes a recorded command trigger before URL polling', () => {
    const merge = source('sections/merge-and-deploy.md');
    const route = merge.indexOf('2. Recorded command trigger');
    expect(route).toBeGreaterThanOrEqual(0);
    expect(route).toBeLessThan(merge.indexOf('Explicit `VERIFY_URL`'));
    expect(route).toBeLessThan(merge.indexOf('Otherwise use configured production URL/status checks'));
    const body = merge.slice(route, merge.indexOf('3. Explicit `VERIFY_URL`')).replace(/\s+/g, ' ');
    expect(body).toContain('production has not moved yet');
    expect(body).toContain('only with their explicit approval');
    expect(body).toContain('a zero exit is not revision proof');
  });

  test('a pending workflow or platform trigger is not mistaken for a command trigger', () => {
    const merge = source('sections/merge-and-deploy.md');
    expect(merge.replace(/\s+/g, ' ')).toContain('A configured workflow or platform trigger whose run has not appeared remains pending');
  });

  test('Strategy D points at the route and still demands revision proof', () => {
    const main = source('SKILL.md');
    const start = main.indexOf('### Strategy D: Custom deploy hooks');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = main.slice(start, main.indexOf('### Common: Timing and failure handling')).replace(/\s+/g, ' ');
    expect(body).toContain('A recorded command trigger follows Step 5 route 2');
    expect(body).toContain('only with their explicit approval');
    expect(body).toContain('not revision proof on its own');
  });
});
