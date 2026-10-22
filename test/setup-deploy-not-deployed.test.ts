import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SKILL = fs.readFileSync(path.resolve(import.meta.dir, '..', 'setup-deploy', 'SKILL.md'), 'utf-8');

function section(heading: string, next: string): string {
  const start = SKILL.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SKILL.indexOf(next, start + heading.length);
  expect(end).toBeGreaterThan(start);
  return SKILL.slice(start, end);
}

describe('setup-deploy handles a project with nothing live yet', () => {
  const question = section('1. **How are deploys triggered?**', "2. **What's the production URL?**");

  test('not deployed yet and never deploys are separate answers', () => {
    expect(question).toContain('E) Nothing is deployed yet');
    expect(question).toContain('F) This project never deploys (library, CLI, tool)');
  });

  test('nothing deployed yet stops before the URL question and writes nothing', () => {
    const onE = question.slice(question.indexOf('On E,'));
    expect(onE).toContain('stop here and write nothing');
    expect(onE).toContain('no production URL and no deploy trigger to record');
    expect(onE).toContain('re-run `/setup-deploy` after the first production deploy exists');
  });

  test('a project that never deploys still gets the none configuration', () => {
    expect(question).toContain('On F, Step 4 writes the `none` configuration');
    expect(SKILL).toContain('If the project does not deploy, set platform/URL/workflow/status/health/trigger to `none`');
  });
});
