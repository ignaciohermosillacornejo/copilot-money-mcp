import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.js',
      'tests/**/*.ts',
      'src/**/*.generated.ts',
      // Gitignored local-only scripts; tsconfig.scripts.json excludes them too.
      'scripts/local/**',
    ],
  },

  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript recommended rules with type checking
  ...tseslint.configs.recommendedTypeChecked,

  // Prettier config (disables conflicting rules)
  eslintConfigPrettier,

  // Custom configuration for TypeScript files
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // A braceless body is house style only when it sits on the `if` line.
      // Once the condition or body spans lines, braces are required (#813).
      curly: ['error', 'multi-line'],
    },
  },

  // scripts/ holds the check:* gates, smokes, and build helpers. They are
  // typechecked against tsconfig.scripts.json rather than tsconfig.json, so
  // point the type-aware rules at that project.
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.scripts.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Relaxation: these are CLIs whose output IS console.log (gate verdicts,
      // smoke reports, generated listings). The src/ rule exists because the
      // MCP server speaks JSON-RPC over stdout, which scripts do not.
      'no-console': 'off',
      // Relaxation: tsconfig.scripts.json turns off noUncheckedIndexedAccess,
      // so this rule flags every `m[1]!` / `parts[0] as string` index guard in
      // scripts as redundant even though the same code would need it under the
      // src/ config. It also misfires on widenings like
      // `r.error as NodeJS.ErrnoException` (all-optional extra fields): its
      // autofix removed four of those and broke `tsc -p tsconfig.scripts.json`.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  }
);
