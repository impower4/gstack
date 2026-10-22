/**
 * A kind-differentiated AskUserQuestion says its options are not comparable on
 * coverage. The preamble's "options differ in kind" note is one wording; any
 * brief statement of the same fact counts.
 */
export const KIND_NOTE_RE = /\b(?:options? (?:differ|are different) in kind|differ in kind|different kinds? of (?:choice|option|decision)s?|not comparable on (?:coverage|completeness)|no completeness score)\b/i;
