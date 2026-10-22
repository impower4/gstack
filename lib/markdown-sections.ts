/**
 * markdown-sections — the one heading parser the Captain brief
 * (lib/captain-brief.ts) and gstack-pr-shots --heading (lib/pr-shots.ts)
 * share. ATX headings only (`#`..`######` then a space), never inside a
 * fenced code block (three backticks or ~~~, closed by the same fence or longer);
 * CRLF is read as LF. A section runs from its heading to the next heading of
 * the same or a higher level, or the end of the text. Titles match after
 * normalization (case, arrows, punctuation and spacing folded), against an
 * alias list; the first match wins and later duplicates are reported.
 */

export interface Heading { level: number; title: string; line: number }
export interface Section { heading: Heading; body: string; duplicates: number }

const ATX = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Every heading outside fenced code, with its 0-based line. */
export function headings(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    const f = FENCE.exec(line);
    if (f) {
      const mark = f[1]!;
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = ATX.exec(line);
    if (m) out.push({ level: m[1]!.length, title: m[2]!.trim(), line: i });
  });
  return out;
}

/** Folded title: lower case, arrows and dashes to one space, punctuation dropped. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/→|->|=>|—|–/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The section whose title matches one of `aliases` (normalized), or undefined. */
export function findSection(text: string, aliases: string[]): Section | undefined {
  const want = new Set(aliases.map(normalizeTitle));
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const all = headings(text);
  const hits = all.filter(h => want.has(normalizeTitle(h.title)));
  const first = hits[0];
  if (!first) return undefined;
  const next = all.find(h => h.line > first.line && h.level <= first.level);
  const body = lines.slice(first.line + 1, next ? next.line : lines.length).join('\n').replace(/^\n+|\s+$/g, '');
  return { heading: first, body, duplicates: hits.length - 1 };
}

/** The first H1 title, for naming a plan. */
export function firstTitle(text: string): string | undefined {
  return headings(text).find(h => h.level === 1)?.title;
}
