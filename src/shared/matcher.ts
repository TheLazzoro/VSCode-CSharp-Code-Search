export interface NameMatch {
  score: number;
  /** Indices of the matched characters in the name. */
  positions: number[];
}

const SCORE_EXACT = 1000;
const SCORE_PREFIX = 900;
const SCORE_PREFIX_AFTER_UNDERSCORE = 850;
const SCORE_HUMPS = 800;
const SCORE_HUMPS_INNER = 760;
const SCORE_WORD_START = 700;
const SCORE_SUBSTRING = 600;
const SCORE_FUZZY = 500;
const CASE_BONUS = 10;
const MIN_FUZZY_QUERY = 3;
const MAX_FUZZY_GAP_PER_CHAR = 3;

function range(start: number, length: number): number[] {
  const positions: number[] = [];
  for (let offset = 0; offset < length; offset++) {
    positions.push(start + offset);
  }
  return positions;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isUnderscore(code: number): boolean {
  return code === 95;
}

/** True where a new word starts: `getUserName`, `get_user`, `Item2`. */
function isWordStart(name: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const code = name.charCodeAt(index);
  const previous = name.charCodeAt(index - 1);
  if (isUnderscore(code)) {
    return false;
  }
  if (isUnderscore(previous)) {
    return true;
  }
  if (isUpper(code)) {
    if (!isUpper(previous)) {
      return true;
    }
    // The last capital of an acronym starts the next word: `HTMLParser`.
    return index + 1 < name.length && name[index + 1] !== name[index + 1].toUpperCase();
  }
  return isDigit(code) !== isDigit(previous);
}

/** Matches the query against word starts, allowing each word to consume several query characters. */
function matchHumps(queryLower: string, name: string, nameLower: string): number[] | undefined {
  const positions: number[] = [];
  let queryIndex = 0;
  for (let index = 0; index < name.length && queryIndex < queryLower.length; index++) {
    if (!isWordStart(name, index)) {
      continue;
    }
    let cursor = index;
    while (
      queryIndex < queryLower.length &&
      cursor < name.length &&
      nameLower[cursor] === queryLower[queryIndex] &&
      (cursor === index || !isWordStart(name, cursor))
    ) {
      positions.push(cursor);
      cursor++;
      queryIndex++;
    }
  }
  return queryIndex === queryLower.length ? positions : undefined;
}

function subsequencePositions(queryLower: string, nameLower: string): number[] | undefined {
  const positions: number[] = [];
  let from = 0;
  for (let queryIndex = 0; queryIndex < queryLower.length; queryIndex++) {
    const found = nameLower.indexOf(queryLower[queryIndex], from);
    if (found < 0) {
      return undefined;
    }
    positions.push(found);
    from = found + 1;
  }
  return positions;
}

function findWordStartSubstring(name: string, nameLower: string, queryLower: string): number {
  let found = nameLower.indexOf(queryLower);
  while (found >= 0) {
    if (isWordStart(name, found)) {
      return found;
    }
    found = nameLower.indexOf(queryLower, found + 1);
  }
  return -1;
}

export function matchName(query: string, queryLower: string, name: string, nameLower: string): NameMatch | undefined {
  if (queryLower.length === 0 || queryLower.length > nameLower.length) {
    return undefined;
  }
  // Every tier below is a subsequence, so this rejects most names cheaply.
  const fuzzy = subsequencePositions(queryLower, nameLower);
  if (!fuzzy) {
    return undefined;
  }

  const contiguous = range(0, queryLower.length);
  if (nameLower === queryLower) {
    return { score: SCORE_EXACT + (name === query ? CASE_BONUS : 0), positions: contiguous };
  }
  if (nameLower.startsWith(queryLower)) {
    return { score: SCORE_PREFIX + (name.startsWith(query) ? CASE_BONUS : 0), positions: contiguous };
  }
  const underscores = /^_+/.exec(name)?.[0].length ?? 0;
  if (underscores > 0 && nameLower.startsWith(queryLower, underscores)) {
    return { score: SCORE_PREFIX_AFTER_UNDERSCORE, positions: range(underscores, queryLower.length) };
  }
  const humps = matchHumps(queryLower, name, nameLower);
  if (humps) {
    return { score: humps[0] === underscores ? SCORE_HUMPS : SCORE_HUMPS_INNER, positions: humps };
  }
  const wordStart = findWordStartSubstring(name, nameLower, queryLower);
  if (wordStart >= 0) {
    return { score: SCORE_WORD_START, positions: range(wordStart, queryLower.length) };
  }
  const substring = nameLower.indexOf(queryLower);
  if (substring >= 0) {
    return { score: SCORE_SUBSTRING, positions: range(substring, queryLower.length) };
  }

  const gaps = fuzzy[fuzzy.length - 1] - fuzzy[0] + 1 - queryLower.length;
  if (queryLower.length < MIN_FUZZY_QUERY || gaps > queryLower.length * MAX_FUZZY_GAP_PER_CHAR) {
    return undefined;
  }
  return { score: SCORE_FUZZY - gaps, positions: fuzzy };
}
