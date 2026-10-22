/**
 * plan_mode_preamble through the real ./setup on a default Claude install (#3168).
 *
 * The default install serves the committed SKILL.md files with no render, so
 * with the key off setup must render the skills without the plan-mode
 * preamble and serve that render (router included, via gstack-relink); with
 * the key back on, the render goes away, including when the gbrain detector
 * fails (the gbrain=unknown branch that otherwise keeps a render).
 * Fixture: test/helpers/install-fixture.ts, overlay helpers:
 * test/helpers/claude-overlay-fixture.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, defaultRender, failableBun, fakeDetect, record, served, setup } from './helpers/claude-overlay-fixture';
import { rmSync } from 'node:fs';
import { ROOT, cleanupFixtures, cleanupSeed, makeFixture, makeSource, put } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const SAFE = '## Plan Mode Safe Operations';
const alias = (skills: string) => readFileSync(join(skills, '_gstack-command/SKILL.md'), 'utf8');
const asAlias = (router: string) => router.replace(/^name: gstack$/m, 'name: _gstack-command');

describe.skipIf(process.platform === 'win32')('./setup with plan_mode_preamble', () => {
  test('off renders the default install without the preamble and keeps it through a failed render; on (detector failing) serves the committed files again', () => {
    const f = makeFixture();
    failableBun(f);
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    fakeDetect(src);
    const skills = join(f.home, '.claude/skills');
    const committedSkill = readFileSync(join(ROOT, 'autoplan/SKILL.md'), 'utf8');
    const committedRouter = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
    expect(committedSkill).toContain(SAFE);

    expect(config(f, src, 'set', 'plan_mode_preamble', 'off').status).toBe(0);
    const off = setup(f, src);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain('and no plan-mode preamble');
    expect(record(defaultRender(f))).toMatchObject({ overlay: 'claude', source: 'default', gbrain: 'absent', render: 'user', plan_mode: 'off' });
    expect(served(skills)).not.toContain(SAFE);
    expect(served(skills)).not.toContain('## Skill Invocation During Plan Mode');
    expect(readFileSync(join(src, 'SKILL.md'), 'utf8')).not.toContain(SAFE);
    expect(off.out).not.toContain('Claude skill overlay:');
    expect(alias(skills)).toBe(asAlias(readFileSync(join(src, 'SKILL.md'), 'utf8')));

    put(join(f.home, 'fail-render'), '1');
    const failed = setup(f, src);
    expect(failed.status, failed.out).toBe(0);
    expect(record(defaultRender(f))).toMatchObject({ plan_mode: 'off', render: 'user' });
    expect(served(skills)).not.toContain(SAFE);
    rmSync(join(f.home, 'fail-render'));

    expect(config(f, src, 'set', 'plan_mode_preamble', 'on').status).toBe(0);
    put(join(f.home, 'gbrain-mode'), 'fail');
    const on = setup(f, src);
    expect(on.status, on.out).toBe(0);
    expect(on.out).toContain('gstack-gbrain-detect failed');
    expect(existsSync(defaultRender(f))).toBe(false);
    expect(existsSync(`${defaultRender(f)}.overlay`)).toBe(false);
    expect(served(skills)).toBe(readFileSync(join(src, 'autoplan/SKILL.md'), 'utf8'));
    expect(served(skills)).toBe(committedSkill);
    expect(readFileSync(join(src, 'SKILL.md'), 'utf8')).toBe(committedRouter);
    expect(alias(skills)).toBe(asAlias(committedRouter));
  }, 240_000);
});
