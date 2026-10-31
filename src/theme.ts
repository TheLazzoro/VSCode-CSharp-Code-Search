import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import * as vscode from 'vscode';
import type { TokenColors } from './shared/protocol';
import type { TokenClass } from './shared/symbols';

interface ThemeRule {
  scope?: string | string[];
  settings?: { foreground?: string };
}

interface ThemeFile {
  include?: string;
  tokenColors?: ThemeRule[] | string;
}

interface ThemeContribution {
  id?: string;
  label?: string;
  path?: string;
}

/** The TextMate scope the C# grammar gives each token class. */
const TOKEN_SCOPES: Readonly<Partial<Record<TokenClass, string>>> = {
  keyword: 'storage.modifier.cs',
  declaration: 'storage.type.class.cs',
  control: 'keyword.control.flow.cs',
  type: 'entity.name.type.class.cs',
  builtin: 'keyword.type.cs',
  function: 'entity.name.function.cs',
  variable: 'variable.other.readwrite.cs',
  parameter: 'variable.parameter.cs',
  property: 'variable.other.object.property.cs',
  namespace: 'entity.name.type.namespace.cs',
  string: 'string.quoted.double.cs',
  escape: 'constant.character.escape.cs',
  number: 'constant.numeric.decimal.cs',
  constant: 'constant.language.boolean.true.cs',
  comment: 'comment.line.double-slash.cs',
  operator: 'keyword.operator.cs',
  preprocessor: 'meta.preprocessor.cs',
};

const DARK_FALLBACK: TokenColors = {
  keyword: '#569CD6',
  declaration: '#569CD6',
  control: '#C586C0',
  type: '#4EC9B0',
  builtin: '#569CD6',
  function: '#DCDCAA',
  variable: '#9CDCFE',
  parameter: '#9CDCFE',
  property: '#9CDCFE',
  namespace: '#4EC9B0',
  string: '#CE9178',
  escape: '#D7BA7D',
  number: '#B5CEA8',
  constant: '#569CD6',
  comment: '#6A9955',
  preprocessor: '#569CD6',
};

const LIGHT_FALLBACK: TokenColors = {
  keyword: '#0000FF',
  declaration: '#0000FF',
  control: '#AF00DB',
  type: '#267F99',
  builtin: '#0000FF',
  function: '#795E26',
  variable: '#001080',
  parameter: '#001080',
  property: '#001080',
  namespace: '#267F99',
  string: '#A31515',
  escape: '#EE0000',
  number: '#098658',
  constant: '#0000FF',
  comment: '#008000',
  preprocessor: '#0000FF',
};

function findActiveThemeFile(): string | undefined {
  const active = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  for (const extension of vscode.extensions.all) {
    const themes = (extension.packageJSON?.contributes?.themes ?? []) as ThemeContribution[];
    const theme = themes.find((candidate) => candidate.id === active || candidate.label === active);
    if (theme?.path) {
      return path.join(extension.extensionPath, theme.path);
    }
  }
  return undefined;
}

async function loadRules(file: string): Promise<ThemeRule[]> {
  const theme = parse(await readFile(file, 'utf8')) as ThemeFile;
  const inherited = theme.include ? await loadRules(path.join(path.dirname(file), theme.include)) : [];
  return Array.isArray(theme.tokenColors) ? [...inherited, ...theme.tokenColors] : inherited;
}

function selectors(rule: ThemeRule): string[] {
  const scope = rule.scope ?? [];
  return (typeof scope === 'string' ? scope.split(',') : scope).map((selector) => selector.trim());
}

/** TextMate matching reduced to what a single scope needs: the longest dotted prefix wins. */
function colorFor(rules: ThemeRule[], scope: string): string | undefined {
  let color: string | undefined;
  let bestLength = -1;
  for (const rule of rules) {
    const foreground = rule.settings?.foreground;
    if (!foreground) {
      continue;
    }
    for (const selector of selectors(rule)) {
      const leaf = selector.split(/\s+/).pop() ?? '';
      if (leaf.length >= bestLength && leaf.length > 0 && (scope === leaf || scope.startsWith(`${leaf}.`))) {
        color = foreground;
        bestLength = leaf.length;
      }
    }
  }
  return color;
}

/** Webviews see the theme's UI colors but not its syntax colors, so those come from its file. */
export async function resolveTokenColors(): Promise<TokenColors> {
  const light =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
  const fallback = light ? LIGHT_FALLBACK : DARK_FALLBACK;

  const file = findActiveThemeFile();
  if (!file) {
    return fallback;
  }
  try {
    const rules = await loadRules(file);
    const colors: TokenColors = { ...fallback };
    for (const [tokenClass, scope] of Object.entries(TOKEN_SCOPES)) {
      const color = colorFor(rules, scope);
      if (color) {
        colors[tokenClass as TokenClass] = color;
      }
    }
    return colors;
  } catch {
    return fallback;
  }
}
