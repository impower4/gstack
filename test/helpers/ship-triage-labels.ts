export type TriageLabel = 'in-branch' | 'pre-existing';

const LABEL = /\b(in[- ]branch|pre[- ]existing)\b/gi;
const normalize = (label: string): TriageLabel => (/^in/i.test(label) ? 'in-branch' : 'pre-existing');

/**
 * Classify each seeded ship-triage failure from the agent's final message.
 * Prefers the requested JSON object ({"<test file>": "in-branch" | "pre-existing"});
 * otherwise uses the lines that name exactly one failure and exactly one label.
 * A failure labelled both ways, or not at all, stays undefined.
 */
export function triageLabels(output: string): { string?: TriageLabel; math?: TriageLabel } {
  const result: { string?: TriageLabel; math?: TriageLabel } = {};
  for (const block of output.match(/\{[^{}]*\}/g) ?? []) {
    let parsed: unknown;
    try { parsed = JSON.parse(block); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string' || !/^(in[- ]branch|pre[- ]existing)$/i.test(value.trim())) continue;
      if (/string|truncate/i.test(key)) result.string = normalize(value.trim());
      if (/math|divide/i.test(key)) result.math = normalize(value.trim());
    }
  }
  if (result.string && result.math) return result;
  const seen: Record<'string' | 'math', Set<TriageLabel>> = { string: new Set(), math: new Set() };
  for (const line of output.split('\n')) {
    const names = (['string', 'math'] as const).filter(name =>
      (name === 'string' ? /string|truncate/i : /math|divide/i).test(line));
    const labels = [...new Set([...line.matchAll(LABEL)].map(match => normalize(match[1]!)))];
    if (names.length === 1 && labels.length === 1) seen[names[0]!].add(labels[0]!);
  }
  for (const name of ['string', 'math'] as const) {
    if (!result[name] && seen[name].size === 1) result[name] = [...seen[name]][0];
  }
  return result;
}
