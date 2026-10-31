import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  // Inherited when run from inside VS Code, where it would start Code.exe as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [path.join(root, 'test/fixtures/sample'), '--disable-extensions'],
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
