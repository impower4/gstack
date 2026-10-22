import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

// Include the scope/Aside prerequisites used by Step 0, through report outputs.
export const ENG_REVIEW_EXCERPT = {
  skillPath: 'plan-eng-review/SKILL.md',
  startMarker: '## Scope gate',
  endMarker: '## Section self-check (before you finish)',
} as const;

// The question-procedure heading in the plan-review sections, with or without
// its older "CRITICAL RULE — " prefix.
export const ASK_QUESTIONS_HEADING = /^## [^\n]*How to ask questions[^\n]*$/m;

export function markerIndex(text: string, marker: string | RegExp, from: number): number {
  if (typeof marker === 'string') return text.indexOf(marker, from);
  const at = text.slice(from).search(marker);
  return at < 0 ? -1 : from + at;
}

// Same generated two-line pointer consumed by setup-gbrain-fixture.ts.
const STOP_POINTER =
  /^> \*\*STOP\.\*\* Before [^\n]*sections\/([a-z0-9-]+\.md)[^\n]*\n> in full\.[^\n]*/gm;

/** Expand on-demand sections where the agent reads them, then take the requested excerpt. */
export function readWorkflowExcerpt(skillPath: string, startMarker: string, endMarker: string | RegExp | null): string {
  const secDir = path.join(ROOT, path.dirname(skillPath), 'sections');
  const content = fs.readFileSync(path.join(ROOT, skillPath), 'utf-8').replace(STOP_POINTER, (_pointer, file: string) => {
    const body = fs.readFileSync(path.join(secDir, file), 'utf-8')
      .replace(/^<!--[^\n]*-->\n/gm, '').trim();
    if (body.length < 200) throw new Error(`${skillPath}: section ${file} is empty/stub`);
    return body;
  });
  const start = content.indexOf(startMarker);
  if (start < 0) throw new Error(`Start marker not found in ${skillPath}: "${startMarker}"`);
  const end = endMarker ? markerIndex(content, endMarker, start) : content.length;
  if (end < 0) throw new Error(`End marker not found in ${skillPath}: "${endMarker}"`);
  return content.slice(start, end);
}
