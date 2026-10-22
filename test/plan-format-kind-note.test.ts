import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { KIND_NOTE_RE } from './helpers/plan-format-kind-note';
import { generateAskUserFormat } from '../scripts/resolvers/preamble/generate-ask-user-format';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/plan-format-kind-notes.json'), 'utf8')) as
  { known_good: string[]; known_bad: string[] };

describe('plan-format kind note', () => {
  test('accepts the kind note the AskUserQuestion format itself prescribes', () => {
    const format = generateAskUserFormat({ skillName: 'plan-ceo-review', host: 'claude', paths: HOST_PATHS.claude } as TemplateContext);
    const prescribed = /Note: options differ in kind[^`\n]*/.exec(format)?.[0];
    expect(prescribed).toBeDefined();
    expect(prescribed!).toMatch(KIND_NOTE_RE);
  });
  test.each(stored.known_good)('accepts %s', line => expect(line).toMatch(KIND_NOTE_RE));
  test.each(stored.known_bad)('rejects %s', line => expect(line).not.toMatch(KIND_NOTE_RE));
});
