import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const tests = args.has('--tests');

if (production) {
  // Leaves no source maps from earlier development builds to be packaged.
  rmSync('dist', { recursive: true, force: true });
}

/** Runtime files the bundles load from `dist/` by path. */
function copyAssets() {
  mkdirSync('dist', { recursive: true });
  copyFileSync('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'dist/web-tree-sitter.wasm');
  copyFileSync('node_modules/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm', 'dist/tree-sitter-c_sharp.wasm');
  copyFileSync('node_modules/@vscode/codicons/dist/codicon.css', 'dist/codicon.css');
  copyFileSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/codicon.ttf');
  copyFileSync('src/webview/style.css', 'dist/webview.css');

  // Later patterns win, so the extensions refine the upstream captures.
  const upstream = readFileSync('node_modules/tree-sitter-c-sharp/queries/highlights.scm', 'utf8');
  const extensions = readFileSync('src/worker/highlights.scm', 'utf8');
  writeFileSync('dist/highlights.scm', `${upstream}\n${extensions}`);
}

const copyAssetsPlugin = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(copyAssets);
  },
};

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const contexts = [
  await esbuild.context({
    ...shared,
    entryPoints: { extension: 'src/extension.ts', parseWorker: 'src/worker/parseWorker.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    // The UMD main of jsonc-parser uses a dynamic require that cannot be bundled.
    mainFields: ['module', 'main'],
    // web-tree-sitter needs import.meta.url, which esbuild leaves empty in CommonJS.
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    plugins: [copyAssetsPlugin],
  }),
  await esbuild.context({
    ...shared,
    entryPoints: { webview: 'src/webview/main.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
];

if (tests) {
  contexts.push(
    await esbuild.context({
      ...shared,
      entryPoints: globSync('test/integration/*.ts'),
      outbase: 'test/integration',
      outdir: 'out/test',
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode', 'mocha', '@vscode/test-electron'],
    }),
  );
}

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
