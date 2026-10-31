import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import { CodeSymbol, HighlightedSource, TOKEN_CLASSES, TokenClass } from '../shared/symbols';
import { extractSymbols } from './symbolExtractor';

const CAPTURE_CLASSES: Readonly<Record<string, TokenClass>> = {
  attribute: 'type',
  comment: 'comment',
  constant: 'constant',
  'constant.builtin': 'constant',
  constructor: 'type' as const,
  function: 'function',
  keyword: 'keyword',
  'keyword.control': 'control',
  'keyword.declaration': 'declaration',
  module: 'namespace',
  namespace: 'namespace',
  number: 'number',
  operator: 'operator',
  preprocessor: 'preprocessor',
  property: 'property',
  'property.definition': 'constant',
  'punctuation.bracket': 'punctuation',
  'punctuation.delimiter': 'punctuation',
  string: 'string',
  'string.escape': 'escape',
  type: 'type',
  'type.builtin': 'builtin',
  variable: 'variable',
  'variable.parameter': 'parameter',
};

const LINE_BREAK = /\r\n|\r|\n/g;

/** Parses C# on the calling thread. Instances are confined to one worker. */
export class CSharpEngine {
  private constructor(
    private readonly parser: Parser,
    private readonly highlights: Query,
  ) {}

  /** Loads the parser and grammar from a directory laid out like `dist/`. */
  static async create(assetDir: string): Promise<CSharpEngine> {
    await Parser.init({ locateFile: () => path.join(assetDir, 'web-tree-sitter.wasm') });
    const [grammar, highlights] = await Promise.all([
      readFile(path.join(assetDir, 'tree-sitter-c_sharp.wasm')),
      readFile(path.join(assetDir, 'highlights.scm'), 'utf8'),
    ]);
    const language = await Language.load(grammar);
    const parser = new Parser();
    parser.setLanguage(language);
    return new CSharpEngine(parser, new Query(language, highlights));
  }

  private withTree<T>(text: string, use: (tree: NonNullable<ReturnType<Parser['parse']>>) => T): T {
    const tree = this.parser.parse(text);
    if (!tree) {
      throw new Error('Parsing was cancelled.');
    }
    try {
      return use(tree);
    } finally {
      tree.delete();
    }
  }

  extractSymbols(text: string): CodeSymbol[] {
    return this.withTree(text, extractSymbols);
  }

  highlight(text: string): HighlightedSource {
    return this.withTree(text, (tree) => {
      // Captures arrive outermost first and in pattern order, so painting each over the
      // last leaves the innermost, most specific class on every character.
      const classes = new Uint8Array(text.length);
      for (const { name, node } of this.highlights.captures(tree.rootNode)) {
        const tokenClass = CAPTURE_CLASSES[name];
        if (tokenClass) {
          classes.fill(TOKEN_CLASSES.indexOf(tokenClass), node.startIndex, node.endIndex);
        }
      }
      return toLines(text, classes);
    });
  }
}

function lineSpans(classes: Uint8Array, start: number, end: number): number[] {
  const spans: number[] = [];
  let runStart = start;
  for (let index = start + 1; index <= end; index++) {
    if (index === end || classes[index] !== classes[runStart]) {
      if (classes[runStart] !== 0) {
        spans.push(runStart - start, index - runStart, classes[runStart]);
      }
      runStart = index;
    }
  }
  return spans;
}

function toLines(text: string, classes: Uint8Array): HighlightedSource {
  const lines: string[] = [];
  const spans: number[][] = [];
  let start = 0;
  for (const lineBreak of text.matchAll(LINE_BREAK)) {
    lines.push(text.slice(start, lineBreak.index));
    spans.push(lineSpans(classes, start, lineBreak.index));
    start = lineBreak.index + lineBreak[0].length;
  }
  lines.push(text.slice(start));
  spans.push(lineSpans(classes, start, text.length));
  return { lines, spans };
}
