/**
 * Tokenising for tool search.
 *
 * Tool names are identifiers (`list_directory`, `getFileContents`,
 * `github__search_code`) and queries are plain English, so both are split on
 * identifier boundaries, lower-cased, lightly stemmed and mapped through a
 * small synonym table. Everything here is symmetric: queries and documents
 * go through the same function, so a crude stemmer only has to be consistent,
 * not linguistically right.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of',
  'on', 'or', 'our', 'that', 'the', 'their', 'them', 'then', 'this', 'to',
  'use', 'used', 'using', 'via', 'was', 'we', 'what', 'when', 'which', 'with',
  'you', 'your',
]);

/**
 * Words that name the same thing in tool descriptions and in requests. Each
 * group maps to its first member. Kept deliberately small: a wrong synonym
 * costs precision on every query that contains it.
 */
const SYNONYM_GROUPS: string[][] = [
  ['directory', 'folder', 'dir'],
  ['repository', 'repo'],
  ['delete', 'remove', 'rm', 'erase'],
  ['list', 'ls', 'enumerate'],
  ['search', 'find', 'lookup', 'grep'],
  ['message', 'msg'],
  ['fetch', 'download', 'retrieve'],
  ['create', 'make'],
  ['issue', 'ticket', 'bug'],
  ['email', 'mail'],
  ['event', 'meeting'],
  ['web', 'website', 'webpage'],
  ['rename', 'move', 'mv'],
  ['reaction', 'react'],
];

/** Abbreviations that expand to more than one word. */
const EXPANSIONS: Record<string, string[]> = {
  pr: ['pull', 'request'],
  prs: ['pull', 'request'],
  db: ['database'],
  sql: ['sql', 'database'],
};

const VOWEL = /[aeiouy]/;

/**
 * Suffix stripping, applied identically to queries and documents. Plurals
 * first, so "meetings" and "meeting" land on the same stem.
 */
export function stem(word: string): string {
  let result = word;
  if (result.length > 4 && result.endsWith('ies')) result = `${result.slice(0, -3)}y`;
  else if (result.length > 4 && /(ches|shes|sses|xes)$/.test(result)) result = result.slice(0, -2);
  else if (result.length > 3 && result.endsWith('s') && !result.endsWith('ss')) result = result.slice(0, -1);

  // Only when a vowel survives: "string" must not become "str".
  if (result.length > 5 && result.endsWith('ing') && VOWEL.test(result.slice(0, -3))) {
    return result.slice(0, -3);
  }
  if (result.length > 4 && result.endsWith('ed') && VOWEL.test(result.slice(0, -2))) {
    return result.slice(0, -2);
  }
  return result;
}

const CANONICAL = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    CANONICAL.set(stem(word), stem(group[0]));
  }
}

/** Split identifiers and prose into raw lower-case words. */
export function splitWords(text: string): string[] {
  return (
    text
      // Acronym plurals stay whole: PRs, URLs, IDs.
      .replace(/\b([A-Z]{2,})s\b/g, (_match, acronym: string) => `${acronym.toLowerCase()}s`)
      // camelCase and PascalCase boundaries: getFileContents -> get File Contents
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0)
  );
}

/** Search tokens: split, stop words dropped, expanded, stemmed, canonicalised. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of splitWords(text)) {
    if (STOPWORDS.has(word)) continue;
    for (const expanded of EXPANSIONS[word] ?? [word]) {
      const stemmed = stem(expanded);
      tokens.push(CANONICAL.get(stemmed) ?? stemmed);
    }
  }
  return tokens;
}
