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
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
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
  },

  // tests/ is linted against tsconfig.tests-lint.json, which widens
  // tsconfig.tests.json's compiler options to every test file (#919).
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.tests-lint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Relaxation: test output goes to the bun runner's terminal. The src/
      // rule exists because the MCP server speaks JSON-RPC over stdout.
      'no-console': 'off',
      // Relaxation: same reason as scripts/ above. tsconfig.tests.json turns
      // off noUncheckedIndexedAccess, so every index guard reads as redundant.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // Relaxation: bun-types declares the `.rejects` / `.resolves` matchers as
      // returning void, but at runtime they return a promise that MUST be
      // awaited or the assertion never runs. Every hit is that false positive.
      '@typescript-eslint/await-thenable': 'off',
      // Relaxation: `expect(obj.method).toHaveBeenCalled()` and mock objects
      // pass method references that are never invoked with a `this`.
      '@typescript-eslint/unbound-method': 'off',
      // Relaxation: test doubles are `async () => fixture` to satisfy a
      // Promise-returning signature; there is nothing to await inside them.
      '@typescript-eslint/require-await': 'off',
      // Relaxation: a wrong `!` in a test throws and fails the test, which is
      // the outcome the assertion wanted anyway.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Relaxation: error-normalisation tests throw and reject non-Error
      // values (strings, numbers, an abort signal's `reason`) on purpose.
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      // Relaxation: `_`-named locals are deliberate in tests (iterate-to-count
      // loops, rest destructuring that drops fields), as `_` args already are.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Ratchet for the files still built on hand-written `any` (#919). Every
  // unsafe-* hit left in them sits downstream of an `any` the author wrote,
  // and that no-explicit-any already flags at the cast: `(db as any)._x = ...`
  // fixture writes into private CopilotDatabase state, `(vars: any)` GraphQL
  // mock handlers, and `parseToolResult(r) as any`. None is the silent kind
  // the unsafe-* rules exist for (a JSON.parse, passthrough or unresolved
  // import flowing on as `any`); those were fixed in every file, these
  // included. Moving these fixtures onto `_injectDataForTesting` and typed
  // casts is follow-up work. Shrink only: a file leaves this list once it is
  // clean, and a new file never joins it.
  {
    files: [
      'tests/core/database.test.ts',
      'tests/e2e/server.test.ts',
      'tests/integration/tools.test.ts',
      'tests/tools/optimistic-cache.test.ts',
      'tests/tools/tools.test.ts',
      'tests/tools/unit-coverage-gaps.test.ts',
      'tests/tools/update-transactions-batching.test.ts',
      'tests/tools/write-tools.test.ts',
      'tests/unit/delete-split-parent.test.ts',
      'tests/unit/reference-validation.test.ts',
      'tests/unit/resolve-transaction-meta.test.ts',
      'tests/unit/server-protocol.test.ts',
      'tests/unit/split-transaction-resolution.test.ts',
      'tests/unit/update-transaction.test.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  }
);
