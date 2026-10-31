import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeSymbol, SymbolKind } from '../../src/shared/symbols';
import { CSharpEngine } from '../../src/worker/engine';

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/sample/Billing/InvoiceService.cs');

let engine: CSharpEngine;
let symbols: CodeSymbol[];

function find(name: string, kind?: SymbolKind): CodeSymbol {
  const match = symbols.find((symbol) => symbol.name === name && (!kind || symbol.kind === kind));
  if (!match) {
    throw new Error(`No symbol named ${name}`);
  }
  return match;
}

beforeAll(async () => {
  engine = await CSharpEngine.create(path.join(root, 'dist'));
  symbols = engine.extractSymbols(readFileSync(fixture, 'utf8'));
});

describe('extractSymbols', () => {
  it.each<[string, SymbolKind]>([
    ['Invoice', 'record'],
    ['IInvoiceStore', 'interface'],
    ['InvoiceState', 'enum'],
    ['InvoiceHandler', 'delegate'],
    ['InvoiceService', 'class'],
    ['Money', 'struct'],
    ['FindAsync', 'method'],
    ['GetUserTotalAsync', 'method'],
    ['Dispose', 'method'],
    ['InvoiceService', 'constructor'],
    ['~InvoiceService', 'destructor'],
    ['operator +', 'operator'],
    ['operator bool', 'operator'],
    ['Square', 'function'],
    ['Title', 'property'],
    ['Count', 'property'],
    ['this[int index]', 'indexer'],
    ['Changed', 'event'],
    ['Value', 'field'],
    ['_pending', 'field'],
    ['_archived', 'field'],
    ['DefaultCurrency', 'constant'],
    ['Draft', 'enumMember'],
    ['Sent', 'enumMember'],
  ])('finds the declaration of %s as %s', (name, kind) => {
    expect(find(name, kind)).toBeDefined();
  });

  it.each([
    'total', // var
    'seen', // multiple declarators
    'ignored',
    'attempt', // for initializer
    'invoice', // foreach
    'key', // foreach deconstruction
    'value',
    'scope', // using declaration
    'nested', // using statement
    'failure', // catch
    'found', // declaration pattern
    'foundAmount', // property pattern
    'parsed', // out var
    'first', // deconstruction
    'second',
    'doubled',
    'entry', // query from
    'amount', // query let
    'increment',
  ])('finds the local variable %s', (name) => {
    expect(find(name, 'local')).toBeDefined();
  });

  it.each(['userName', 'top', 'skipped', 'store', 'sender', 'delta', 'augend', 'addend', 'operand', 'index'])(
    'finds the parameter %s',
    (name) => {
      expect(find(name, 'parameter')).toBeDefined();
    },
  );

  it('finds variables declared by less common syntax', () => {
    const names = engine
      .extractSymbols(`class C { void M(object p, System.Tuple<int, int> t) {
        var (u, (v, _)) = t;
        foreach ((Foo a, var b) in pairs) { }
        var q = from Row r in rows join Row j in rows on r equals j into g let w = r select w;
        switch (p) {
          case Foo { } rec: break;
          case int[] arr: break;
          case var x when x != null: break;
        }
        System.Func<int, int, int> f = async (l1, l2) => 1;
      } }`)
      .filter((symbol) => symbol.kind === 'local' || symbol.kind === 'parameter')
      .map((symbol) => symbol.name);
    expect(names.sort()).toEqual(
      ['a', 'arr', 'b', 'f', 'g', 'j', 'l1', 'l2', 'p', 'q', 'r', 'rec', 't', 'u', 'v', 'w', 'x'].sort(),
    );
  });

  it('treats positional record parameters as properties', () => {
    expect(find('Amount', 'property').container).toBe('Acme.Billing.Invoice');
  });

  it('does not report uses as declarations', () => {
    expect(symbols.filter((symbol) => symbol.name === 'Clear')).toEqual([]);
    expect(symbols.filter((symbol) => symbol.name === 'operand')).toHaveLength(1);
  });

  it('scopes everything after a file-scoped namespace to it', () => {
    expect(find('Money').container).toBe('Acme.Billing');
    expect(find('Value').container).toBe('Acme.Billing.Money');
    expect(find('total').container).toBe('Acme.Billing.InvoiceService.GetUserTotalAsync');
    expect(find('operand').container).toBe('Acme.Billing.InvoiceService.GetUserTotalAsync.Square');
  });

  it('nests block-scoped namespaces', () => {
    const nested = engine.extractSymbols(
      'namespace A { namespace B.C { class D { void E() { } } } class F { } }',
    );
    expect(nested.find((symbol) => symbol.name === 'E')?.container).toBe('A.B.C.D');
    expect(nested.find((symbol) => symbol.name === 'F')?.container).toBe('A');
  });

  it('describes signatures and types', () => {
    expect(find('GetUserTotalAsync').detail).toBe('<TKey>(string userName, int top = 3, params int[] skipped) : Task<decimal>');
    expect(find('Title').detail).toBe(': string');
    expect(find('userName').detail).toBe(': string');
    expect(find('skipped').detail).toBe(': int[]');
    expect(find('InvoiceService', 'class').detail).toBe('<TStore>(TStore store)');
    expect(find('attempt').detail).toBe(': int');
  });

  it('reports UTF-16 columns after non-ASCII text', () => {
    const line = readFileSync(fixture, 'utf8').split(/\r?\n/)[find('rødgrød').line];
    const symbol = find('rødgrød');
    expect(line.slice(symbol.column, symbol.column + symbol.name.length)).toBe('rødgrød');
  });

  it('keeps declarations around syntax errors', () => {
    const broken = engine.extractSymbols('class A { void Good() { } int ??? ; void AlsoGood() { } }');
    expect(broken.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(['A', 'Good', 'AlsoGood']));
  });

  it('survives very deep expressions', () => {
    const sum = Array.from({ length: 20_000 }, () => 'a').join(' + ');
    const deep = engine.extractSymbols(`class A { int b = ${sum}; void After() { } }`);
    expect(deep.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(['b', 'After']));
  });
});

describe('highlight', () => {
  function tokens(source: string): Record<string, string> {
    const { lines, spans } = engine.highlight(source);
    const classes: Record<string, string> = {};
    lines.forEach((line, lineIndex) => {
      const lineSpans = spans[lineIndex];
      for (let i = 0; i < lineSpans.length; i += 3) {
        classes[line.slice(lineSpans[i], lineSpans[i] + lineSpans[i + 1])] = String(lineSpans[i + 2]);
      }
    });
    return classes;
  }

  it('splits lines on every line ending', () => {
    expect(engine.highlight('a\r\nb\nc').lines).toEqual(['a', 'b', 'c']);
    expect(engine.highlight('').lines).toEqual(['']);
  });

  it('gives distinct classes to distinct syntax', () => {
    const classes = tokens('class Foo { int Bar() { return 1; } } // done');
    expect(classes['class']).toBeDefined();
    expect(classes['return']).toBeDefined();
    expect(classes['class']).not.toBe(classes['return']);
    expect(classes['Foo']).not.toBe(classes['Bar']);
    expect(classes['// done']).toBeDefined();
    expect(classes['1']).toBeDefined();
  });

  it('leaves code inside preprocessor branches its normal colors', () => {
    const classes = tokens('#if DEBUG\nclass Foo { }\n#endif');
    expect(classes['#if']).toBeDefined();
    expect(classes['class']).toBeDefined();
    expect(classes['class']).not.toBe(classes['#if']);
  });

  it('keeps every span within its line', () => {
    const { lines, spans } = engine.highlight(readFileSync(fixture, 'utf8'));
    expect(lines).toHaveLength(spans.length);
    lines.forEach((line, index) => {
      for (let i = 0; i < spans[index].length; i += 3) {
        expect(spans[index][i] + spans[index][i + 1]).toBeLessThanOrEqual(line.length);
      }
    });
  });
});
