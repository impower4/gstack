/**
 * Structural reader for the shared QA exploratory "Names used below" list.
 * Tests check the commands built from these names (argument order, the CLI each
 * name is bound to) instead of pinning the names' spelling.
 */
export interface QaProbeNames {
  dir: string;
  deadline: string;
  guard: string;
  recorder: string;
}

export function qaProbeNames(text: string): QaProbeNames {
  const start = text.indexOf('Names used below');
  if (start < 0) throw new Error('QA exploratory text has no "Names used below" list');
  const block = text.slice(start, text.indexOf('\n\n', start));
  const bound = (pattern: RegExp, what: string) => {
    const match = block.match(pattern);
    if (!match) throw new Error(`QA probe names: no ${what} binding in:\n${block}`);
    return match[1]!;
  };
  const dir = bound(/^- ([A-Z][A-Z_]+): [^\n]*probe directory/m, 'probe directory');
  const names = {
    dir,
    deadline: bound(new RegExp(`([A-Z][A-Z_]+): \`${dir}/deadline\\.json\``), 'deadline file'),
    guard: bound(/^- ([A-Z][A-Z_]+) = `[^`\n]*\/gstack-qa-deadline`/m, 'gstack-qa-deadline'),
    recorder: bound(/^- ([A-Z][A-Z_]+) = `[^`\n]*\/gstack-qa-evidence`/m, 'gstack-qa-evidence'),
  };
  if (new Set(Object.values(names)).size !== 4) throw new Error(`QA probe names must be distinct: ${JSON.stringify(names)}`);
  return names;
}
