// Minimal, strict ESLint setup (flat config): core JS correctness rules
// everywhere, plus two explicitly requested TypeScript rules for src/ —
// no-unused-vars and no-floating-promises (type-aware, needs tsconfig.json).
// Deliberately NOT using the full typescript-eslint "recommended*" presets:
// the ask was a minimal, targeted rule set, not a broad relint of an
// existing 8800+ line codebase.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'eval/**',
      'design/**',
      'examples/**',
      'docs/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
