import type { Node, Tree } from 'web-tree-sitter';
import type { CodeSymbol, SymbolKind } from '../shared/symbols';

const MAX_DETAIL_LENGTH = 160;

const SCOPED_TYPES: Readonly<Record<string, SymbolKind>> = {
  class_declaration: 'class',
  struct_declaration: 'struct',
  record_declaration: 'record',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
};

const SCOPED_FUNCTIONS: Readonly<Record<string, SymbolKind>> = {
  method_declaration: 'method',
  local_function_statement: 'function',
  constructor_declaration: 'constructor',
};

function compact(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_DETAIL_LENGTH ? `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…` : collapsed;
}

function join(container: string, name: string): string {
  return container ? `${container}.${name}` : name;
}

function typeAnnotation(type: Node | null): string {
  return type ? `: ${compact(type.text)}` : '';
}

function signature(node: Node): string {
  const typeParameters = node.childForFieldName('type_parameters')?.text ?? '';
  const parameters = node.childForFieldName('parameters')?.text ?? '';
  const returns = node.childForFieldName('returns') ?? node.childForFieldName('type');
  return compact(`${typeParameters}${parameters} ${typeAnnotation(returns)}`);
}

function hasModifier(node: Node, modifier: string): boolean {
  return node.namedChildren.some((child) => child?.type === 'modifier' && child.text === modifier);
}

/** Identifiers bound by a pattern such as `(a, (b, _))`. */
function patternNames(pattern: Node): Node[] {
  if (pattern.type === 'identifier') {
    return [pattern];
  }
  if (pattern.type === 'tuple_pattern' || pattern.type === 'parenthesized_variable_designation') {
    return pattern.namedChildren.flatMap((child) => (child ? patternNames(child) : []));
  }
  // Anything else, such as `foreach ((int a, int b) in pairs)`, declares through its own nodes.
  return [];
}

/** The name of a clause, which some clauses only give by position after an optional type. */
function boundName(node: Node): Node | null {
  const type = node.childForFieldName('type');
  return (
    node.childForFieldName('name') ??
    node.namedChildren.find((child) => child?.type === 'identifier' && child.id !== type?.id) ??
    null
  );
}

class SymbolCollector {
  readonly symbols: CodeSymbol[] = [];

  add(nameNode: Node | null, kind: SymbolKind, container: string, detail = '', name = nameNode?.text): void {
    if (!nameNode || !name || nameNode.isMissing) {
      return;
    }
    const { row, column } = nameNode.startPosition;
    this.symbols.push({ name, kind, line: row, column, container, detail });
  }

  private variableDeclaration(node: Node, container: string): void {
    const parent = node.parent;
    let kind: SymbolKind = 'local';
    if (parent?.type === 'field_declaration') {
      kind = hasModifier(parent, 'const') ? 'constant' : 'field';
    } else if (parent?.type === 'event_field_declaration') {
      kind = 'event';
    }
    const detail = typeAnnotation(node.childForFieldName('type'));
    for (const declarator of node.namedChildren) {
      if (declarator?.type === 'variable_declarator') {
        // `var (a, b) = pair` gives its tuple by position.
        const name =
          declarator.childForFieldName('name') ??
          declarator.namedChildren.find((child) => child?.type === 'tuple_pattern') ??
          null;
        this.addBinding(name, kind, container, detail);
      }
    }
  }

  private addBinding(name: Node | null, kind: SymbolKind, container: string, detail: string): void {
    if (name) {
      for (const identifier of patternNames(name)) {
        this.add(identifier, kind, container, detail);
      }
    }
  }

  private typedBinding(node: Node, name: Node | null, container: string): void {
    this.addBinding(name, 'local', container, typeAnnotation(node.childForFieldName('type')));
  }

  private parameter(node: Node, container: string): void {
    // Positional record parameters declare public properties.
    const kind = node.parent?.parent?.type === 'record_declaration' ? 'property' : 'parameter';
    this.add(node.childForFieldName('name'), kind, container, typeAnnotation(node.childForFieldName('type')));
  }

  /** `params` parameters are direct children of the list rather than `parameter` nodes. */
  private paramsParameter(node: Node, container: string): void {
    const name = node.childForFieldName('name');
    this.add(name, 'parameter', container, typeAnnotation(node.childForFieldName('type')));
  }

  /** Records the node's symbols and returns the container for its children, if that changes. */
  visit(node: Node, container: string): string | undefined {
    const typeKind = SCOPED_TYPES[node.type];
    if (typeKind) {
      const name = node.childForFieldName('name');
      const header = node.children.filter((child) => child?.type === 'type_parameter_list' || child?.type === 'parameter_list');
      this.add(name, typeKind, container, compact(header.map((child) => child?.text).join('')));
      return name ? join(container, name.text) : undefined;
    }

    const functionKind = SCOPED_FUNCTIONS[node.type];
    if (functionKind) {
      const name = node.childForFieldName('name');
      this.add(name, functionKind, container, signature(node));
      return name ? join(container, name.text) : undefined;
    }

    switch (node.type) {
      case 'namespace_declaration':
      case 'file_scoped_namespace_declaration': {
        const name = node.childForFieldName('name');
        return name ? join(container, name.text) : undefined;
      }
      case 'delegate_declaration':
        this.add(node.childForFieldName('name'), 'delegate', container, signature(node));
        return undefined;
      case 'destructor_declaration': {
        const name = node.childForFieldName('name');
        this.add(name, 'destructor', container, signature(node), name ? `~${name.text}` : undefined);
        return undefined;
      }
      case 'operator_declaration':
      case 'conversion_operator_declaration': {
        const keyword = node.children.find((child) => child?.type === 'operator') ?? null;
        const symbol = node.childForFieldName('operator')?.text ?? node.childForFieldName('type')?.text;
        this.add(keyword, 'operator', container, signature(node), `operator ${symbol}`);
        return undefined;
      }
      case 'property_declaration': {
        const name = node.childForFieldName('name');
        this.add(name, 'property', container, typeAnnotation(node.childForFieldName('type')));
        return name ? join(container, name.text) : undefined;
      }
      case 'indexer_declaration': {
        const keyword = node.children.find((child) => child?.type === 'this') ?? null;
        const parameters = node.childForFieldName('parameters')?.text ?? '[]';
        this.add(keyword, 'indexer', container, typeAnnotation(node.childForFieldName('type')), `this${compact(parameters)}`);
        return join(container, 'this');
      }
      case 'event_declaration':
        this.add(node.childForFieldName('name'), 'event', container, typeAnnotation(node.childForFieldName('type')));
        return undefined;
      case 'enum_member_declaration':
        this.add(node.childForFieldName('name'), 'enumMember', container);
        return undefined;
      case 'variable_declaration':
        this.variableDeclaration(node, container);
        return undefined;
      case 'parameter':
        this.parameter(node, container);
        return undefined;
      case 'parameter_list':
      case 'bracketed_parameter_list':
        this.paramsParameter(node, container);
        return undefined;
      case 'implicit_parameter':
        this.add(node, 'parameter', container);
        return undefined;
      case 'foreach_statement':
        this.typedBinding(node, node.childForFieldName('left'), container);
        return undefined;
      case 'var_pattern':
        for (const designation of node.namedChildren) {
          this.addBinding(designation, 'local', container, '');
        }
        return undefined;
      case 'catch_declaration':
      case 'declaration_expression':
      case 'declaration_pattern':
      case 'recursive_pattern':
      case 'from_clause':
      case 'join_clause':
      case 'join_into_clause':
      case 'let_clause':
        this.typedBinding(node, boundName(node), container);
        return undefined;
      default:
        return undefined;
    }
  }
}

const INTERESTING_NODES: ReadonlySet<string> = new Set([
  ...Object.keys(SCOPED_TYPES),
  ...Object.keys(SCOPED_FUNCTIONS),
  'namespace_declaration',
  'file_scoped_namespace_declaration',
  'delegate_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'property_declaration',
  'indexer_declaration',
  'event_declaration',
  'enum_member_declaration',
  'variable_declaration',
  'parameter',
  'parameter_list',
  'bracketed_parameter_list',
  'implicit_parameter',
  'foreach_statement',
  'catch_declaration',
  'declaration_expression',
  'declaration_pattern',
  'recursive_pattern',
  'var_pattern',
  'from_clause',
  'join_clause',
  'join_into_clause',
  'let_clause',
]);

/**
 * Walks the tree iteratively with a cursor: generated code can nest deeply enough to overflow
 * the stack of a recursive walk, and only the nodes of interest are materialised as objects.
 */
export function extractSymbols(tree: Tree): CodeSymbol[] {
  const collector = new SymbolCollector();
  const cursor = tree.walk();
  const containers: string[] = [];
  let container = '';

  try {
    for (;;) {
      let childContainer = container;
      const type = cursor.nodeType;
      if (INTERESTING_NODES.has(type)) {
        childContainer = collector.visit(cursor.currentNode, container) ?? container;
        // A file-scoped namespace encloses its following siblings, not its children.
        if (type === 'file_scoped_namespace_declaration') {
          container = childContainer;
        }
      }

      if (cursor.gotoFirstChild()) {
        containers.push(container);
        container = childContainer;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          return collector.symbols;
        }
        container = containers.pop() ?? '';
      }
    }
  } finally {
    cursor.delete();
  }
}
