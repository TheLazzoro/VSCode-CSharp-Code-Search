import { describe, expect, it } from 'vitest';
import { matchName } from '../../src/shared/matcher';
import { IndexedFile, parseQuery, search } from '../../src/shared/search';
import type { CodeSymbol, SymbolKind } from '../../src/shared/symbols';

function match(query: string, name: string) {
  return matchName(query, query.toLowerCase(), name, name.toLowerCase());
}

function symbol(name: string, kind: SymbolKind, container = '', line = 0): CodeSymbol & { nameLower: string } {
  return { name, nameLower: name.toLowerCase(), kind, line, column: 0, container, detail: '' };
}

const files: IndexedFile[] = [
  {
    path: '/repo/src/UserService.cs',
    relPath: 'src/UserService.cs',
    symbols: [
      symbol('UserService', 'class', 'Acme'),
      symbol('GetUserName', 'method', 'Acme.UserService', 3),
      symbol('userName', 'parameter', 'Acme.UserService.GetUserName', 3),
      symbol('_userName', 'field', 'Acme.UserService', 1),
      symbol('userName', 'local', 'Acme.OrderService.Place', 9),
    ],
  },
  {
    path: '/repo/src/OrderService.cs',
    relPath: 'src/OrderService.cs',
    symbols: [symbol('OrderService', 'class', 'Acme'), symbol('Name', 'property', 'Acme.OrderService', 2)],
  },
];

describe('matchName', () => {
  it('ranks exact over prefix over humps over substring over fuzzy', () => {
    const scores = [
      match('getuser', 'GetUser'),
      match('get', 'GetUser'),
      match('gu', 'GetUser'),
      match('user', 'GetUser'),
      match('etu', 'GetUser'),
      match('gtuse', 'GetUser'),
    ].map((result) => result?.score ?? -1);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[3]);
    expect(scores[3]).toBeGreaterThan(scores[4]);
    expect(scores[4]).toBeGreaterThan(scores[5]);
    expect(scores[5]).toBeGreaterThan(0);
  });

  it('prefers the exact case', () => {
    expect(match('Name', 'Name')?.score).toBeGreaterThan(match('name', 'Name')?.score ?? 0);
  });

  it.each([
    ['gun', 'GetUserName', [0, 3, 7]],
    ['getun', 'GetUserName', [0, 1, 2, 3, 7]],
    ['hp', 'HTMLParser', [0, 4]],
    ['dc', 'default_currency', [0, 8]],
  ])('matches %s against the words of %s', (query, name, positions) => {
    expect(match(query, name)?.positions).toEqual(positions);
  });

  it('looks past leading underscores', () => {
    expect(match('count', '_count')?.positions).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects names that do not contain the query', () => {
    expect(match('xyz', 'GetUserName')).toBeUndefined();
    expect(match('longerthanname', 'Name')).toBeUndefined();
    expect(match('', 'Name')).toBeUndefined();
  });

  it('rejects widely scattered fuzzy matches', () => {
    expect(match('gae', 'gxxxxxxxxxxxxxxxxxxaxxxxxxxxxxxxxxxxxxxxe')).toBeUndefined();
  });
});

describe('parseQuery', () => {
  it('reads filter prefixes', () => {
    expect(parseQuery('t: Foo')).toMatchObject({ filter: 'types', text: 'Foo' });
    expect(parseQuery('M:Foo')).toMatchObject({ filter: 'members' });
    expect(parseQuery('Foo')).toMatchObject({ filter: undefined });
  });

  it('splits qualifiers', () => {
    expect(parseQuery('Svc.Load')).toMatchObject({ term: 'Load', qualifiers: ['svc'] });
    expect(parseQuery('a.b.c')).toMatchObject({ term: 'c', qualifiers: ['a', 'b'] });
  });

  it('removes spaces and trailing signatures', () => {
    expect(parseQuery('get user').text).toBe('getuser');
    expect(parseQuery('Load<T>(int a)').text).toBe('Load');
  });
});

describe('search', () => {
  const options = { filter: 'all', limit: 50 } as const;

  it('returns nothing for an empty query', () => {
    expect(search(files, '   ', options).items).toEqual([]);
  });

  it('ranks shared names by kind, with parameters last', () => {
    const { items } = search(files, 'username', options);
    expect(items.map((item) => item.kind)).toEqual(['local', 'parameter', 'field', 'method']);
  });

  it('counts every tab regardless of the active filter', () => {
    const { counts } = search(files, 'username', { ...options, filter: 'types' });
    expect(counts).toEqual({ all: 4, types: 0, members: 2, variables: 3, files: 0 });
  });

  it.each([
    ['types', ['UserService']],
    ['files', ['UserService.cs']],
    ['members', []],
    ['variables', []],
  ] as const)('filters to %s', (filter, names) => {
    expect(search(files, 'UserService', { ...options, filter }).items.map((item) => item.name)).toEqual(names);
  });

  it('lets a prefix override the selected tab', () => {
    const response = search(files, 't:service', { ...options, filter: 'members' });
    expect(response.filter).toBe('types');
    expect(response.items).toHaveLength(2);
  });

  it('applies qualifiers to the container', () => {
    const { items } = search(files, 'OrderService.username', options);
    expect(items).toHaveLength(1);
    expect(items[0].container).toBe('Acme.OrderService.Place');
  });

  it('searches files by name, extension and path', () => {
    expect(search(files, 'f:OrderService.cs', options).items.map((item) => item.name)).toEqual(['OrderService.cs']);
    expect(search(files, 'src/User', { ...options, filter: 'files' }).items.map((item) => item.name)).toEqual(['UserService.cs']);
    expect(search(files, 'f:src\\Order', options).items).toHaveLength(1);
  });

  it('restricts to one file', () => {
    const { items } = search(files, 'name', { ...options, file: '/repo/src/OrderService.cs' });
    expect(items.map((item) => item.name)).toEqual(['Name']);
  });

  it('truncates items but not counts', () => {
    const { items, counts } = search(files, 'username', { ...options, limit: 1 });
    expect(items).toHaveLength(1);
    expect(counts.all).toBe(4);
  });

  it('keeps the best results when truncating across score tiers', () => {
    const many: IndexedFile[] = [
      {
        path: '/repo/Many.cs',
        relPath: 'Many.cs',
        symbols: [
          ...Array.from({ length: 50 }, (_, line) => symbol(`xxOrder${line}`, 'field', '', line)),
          ...Array.from({ length: 50 }, (_, line) => symbol(`Order${line}`, 'field', '', line)),
          symbol('Order', 'class'),
        ],
      },
    ];
    const names = search(many, 'order', { ...options, limit: 3 }).items.map((item) => item.name);
    expect(names).toEqual(['Order', 'Order0', 'Order1']);
  });

  it('fills the limit from lower tiers when the best tier is short', () => {
    const { items } = search(files, 'name', { ...options, limit: 3 });
    expect(items[0].name).toBe('Name');
    expect(items).toHaveLength(3);
  });

  it('describes a file hit by its folder', () => {
    const [hit] = search(files, 'f:OrderService.cs', options).items;
    expect(hit).toMatchObject({ kind: 'file', name: 'OrderService.cs', container: 'src', line: 0, column: 0 });
  });

  it('gives every hit a unique key', () => {
    const { items } = search(files, 'u', options);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });
});
