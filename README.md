# C# Code Search

Visual Studio's Code Search (`Ctrl+T`) for VS Code. Find types, methods, properties, fields, local variables and parameters across your workspace, with a syntax-highlighted preview of each result.

## Usage

Press `Ctrl+T` (`Cmd+T` on macOS) in a C# file, or run **C#: Code Search** from the Command Palette. The search opens as a dialog over the editor, the same way Settings does, and you can resize, maximize or move it out with the buttons in its title bar. Selected text on a single line becomes the search.

| Key | Action |
| --- | --- |
| `↑` `↓` `PgUp` `PgDn` | Move through the results and update the preview |
| `Enter` or double-click | Go to the declaration and close the dialog |
| `Ctrl+Enter` | Open in the editor behind the dialog and keep searching |
| `Esc` | Close the dialog |

### Searching

| Query | Finds |
| --- | --- |
| `GetUser` | Names that start with or contain the text |
| `GUN` | CamelCase initials: `GetUserName` |
| `srchsvc` | Characters in order: `SearchService` |
| `Service.Load` | `Load` inside anything named like `Service` |
| `t:Order` | Types only |
| `m:Order` | Members only |
| `v:total` | Variables only: fields, constants, locals and parameters |
| `f:Program.cs` | Files only. Include a `/` to match on the path |

The tabs do the same as the prefixes and show how many results each one has. The dropdown limits the search to the current document.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `csharpCodeSearch.exclude` | `bin`, `obj`, `node_modules`, `.git`, `.vs` | Globs to leave out of the index, in addition to `files.exclude` |
| `csharpCodeSearch.maxResults` | `200` | Results listed per search. Tab counts always show the full total |

**C#: Rebuild Code Search Index** rebuilds the index from scratch. This is rarely needed, because saved changes, unsaved edits and new or deleted files are all tracked.

The `Ctrl+T` shortcut replaces VS Code's **Go to Symbol in Workspace** while a C# editor is active. Everywhere else, `Ctrl+T` keeps its usual meaning.

## How it works

The extension needs no C# extension, .NET SDK or solution file. It parses every `.cs` file with [tree-sitter](https://tree-sitter.github.io/) compiled to WebAssembly, in up to four worker threads, so indexing doesn't block the editor. You can search while indexing runs. Indexing starts the first time the panel opens, so the extension costs nothing until you use it.

On a generated workspace of 20,000 files and 1.28 million symbols, indexing took about 33 seconds. A typical search took about 50 ms, and a single letter, the worst case, about 180 ms.

## Limitations

- **It reads syntax, not semantics.** `var` is shown as `var` rather than the inferred type, partial classes appear once per file, and only source code in the workspace is searched, not referenced assemblies.
- **The dialog relies on an internal VS Code command.** The public API can't open an editor in the dialog overlay that Settings uses, so the extension calls `_workbench.openWith`, which could change in any VS Code release. It opens as a normal tab instead in versions without the overlay, or when `workbench.editor.useModal` is `off`. If you reload the window, the dialog closes.
- **There is no full-text tab.** Use VS Code's **Search** view (`Ctrl+Shift+F`) to search text.
- **The index is kept in memory** and rebuilt the first time you search in each window.
- **Some newer syntax isn't recognized yet.** C# 14 `extension` blocks aren't in the grammar, positional `is var (a, b)` patterns aren't reported, and neither are query variables after `group ... into`. The rest of such a file is still indexed.

## Development

```powershell
npm install
npm run build             # Bundle to dist/
npm run watch             # Rebuild on change
npm run typecheck
npm test                  # Unit tests, including the bundled worker
npm run test:integration  # Runs inside VS Code
npm run test:e2e          # Drives the webview in a real VS Code window
npm run package           # Build a .vsix
```

Press `F5` to run the extension against `test/fixtures/sample`. The integration and end-to-end tests download a copy of VS Code to `.vscode-test/` on first use.

`publisher` in `package.json` is the placeholder `local`, which is fine for installing a `.vsix` directly. Set your own publisher before publishing to the Marketplace.

## License

MIT. See the `LICENSE` file. Bundled third-party software is listed in `THIRD_PARTY_NOTICES.md`.
