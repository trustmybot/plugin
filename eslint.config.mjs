import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/node_modules/', '**/*.{js,mjs,cjs}', '.claude/', 'tests/', 'scripts/']),
  {
    files: ['mcp/trajectory-server/src/**/*.ts', 'dashboard/server/**/*.ts', 'dashboard/web/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
