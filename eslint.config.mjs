import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'release/',
      'out/',
      'node_modules/',
      'pytapo/',
      '.venv/',
      'coverage/',
      'test-results/',
      'playwright-report/',
      // Static browser assets shipped as-is; not part of the TS project.
      'public/system/*.js',
      '*.config.js',
      '*.config.ts',
      '*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware linting so type-checked rules (e.g. no-floating-promises)
    // have type information. tsconfig.eslint.json covers src/electron/tests.
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off',
      // New ESLint 10 "recommended" rules that flag pre-existing patterns and
      // would require behavioural changes (error-cause chaining, refactoring
      // assignments) to satisfy. Keep them as warnings rather than rewriting
      // working code in this change.
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      // One intentional `let` is self-referenced inside the IIFE it is
      // assigned from (cameras.ts), so it cannot become `const`.
      'prefer-const': 'warn',
    },
  },
  {
    files: ['electron/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'warn',
      // The v7 react-hooks "recommended" set ships several new error-level
      // rules (set-state-in-effect, purity, ...) that flag pre-existing code.
      // Keep them surfaced as warnings rather than changing behaviour here.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  prettier,
);
