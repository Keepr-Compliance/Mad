/**
 * Co-located ESLint flat config for @keepr/ui.
 *
 * Runs decoupled from the repo root (whose `npm run lint` only targets
 * `electron src` and whose ESLint 8.57 flat-config activation is not
 * guaranteed). Invoke via `npm run lint -w @keepr/ui` or
 * `npx eslint packages/ui/src --config packages/ui/eslint.config.js`.
 *
 * Enforces the 1747-epic boundary: packages/* is a leaf of the dependency
 * graph and MUST NOT import from the app (`src/`), Electron (`electron/`), or
 * the portals. It may only depend on its own source and published packages.
 */
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');
const reactPlugin = require('eslint-plugin-react');

const BOUNDARY_GUARD = [
  'error',
  {
    patterns: [
      {
        group: ['@/*', '@electron/*', '@types/*'],
        message:
          'packages/@keepr/ui must not import app path-aliases (@/ = src/, @electron/, @types/). It is a leaf package (1747 epic).',
      },
      {
        group: ['**/src/**', '**/electron/**'],
        message:
          'packages/@keepr/ui must not reach into the app (src/) or Electron (electron/). Leaf package boundary (1747 epic).',
      },
      {
        group: ['**/broker-portal/**', '**/admin-portal/**'],
        message:
          'packages/@keepr/ui must not import from the portals. Leaf package boundary (1747 epic).',
      },
    ],
  },
];

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        // No typed-linting: packages/ui files are not part of a root tsconfig
        // project, so a `project` reference would throw "file not included".
        project: null,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react: reactPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-imports': BOUNDARY_GUARD,
    },
    settings: { react: { version: 'detect' } },
  },
];
