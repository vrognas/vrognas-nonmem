import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(here, 'test/__mocks__/vscode.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/__mocks__/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/extension.ts'],
      reporter: ['text', 'html'],
    },
  },
});
