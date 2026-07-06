/**
 * ESLint v9+ Flat Config
 * This configuration file supports ESLint 9+
 * For more information: https://eslint.org/docs/latest/use/configure/configuration-files
 */

const reactPlugin = require('eslint-plugin-react');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  // Ignore patterns
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '**/*.min.js',
    ],
  },

  // Base configuration for all files
  {
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',

        // Node globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        setImmediate: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        clearImmediate: 'readonly',
        Intl: 'readonly',

        // Jest globals
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      react: reactPlugin,
    },
    rules: {
      // Core ESLint recommended rules (manually specified to avoid @eslint/js dependency)
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'warn',
      'no-constant-condition': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'warn',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'warn',
      'no-func-assign': 'error',
      'no-inner-declarations': 'warn',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // React rules
      'react/react-in-jsx-scope': 'off', // Not needed in React 17+
      'react/prop-types': 'off', // We're not using PropTypes
      'react/display-name': 'off',
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',

      // Best Practices
      'eqeqeq': ['error', 'always'], // Require === instead of ==
      'no-eval': 'error', // No eval() for security
      'no-implied-eval': 'error',
      'no-new-func': 'error', // No new Function() for security

      // ES6
      'prefer-const': 'warn',
      'no-var': 'warn',

      // Allow async without await (common in event handlers)
      'require-await': 'off',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },

  // TypeScript-specific configuration
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react: reactPlugin,
    },
    rules: {
      // Disable JS rules that conflict with TS
      'no-undef': 'off', // TypeScript handles this
      'no-unused-vars': 'off', // Use TS version instead

      // TypeScript-specific rules
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',

      // React rules (same as JS)
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',

      // Best Practices
      'eqeqeq': ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'prefer-const': 'warn',
      'no-var': 'warn',

      // BACKLOG-1729: prevent regression to deleted phone-helper modules.
      // phoneUtils.ts was deleted; phoneLookupKey.ts is a 1-line shim kept
      // only for migration v40 (`require()` at runtime, not affected by
      // this rule). All new code must import from phoneNormalization.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*phoneUtils', '*/phoneUtils'],
              message:
                'phoneUtils was consolidated into phoneNormalization (BACKLOG-1729). Import { toE164, formatPhoneNumber, extractDigits, phoneNumbersMatch } from "electron/utils/phoneNormalization" instead.',
            },
            {
              group: ['*phoneLookupKey', '*/phoneLookupKey'],
              message:
                'phoneLookupKey was consolidated into phoneNormalization (BACKLOG-1729). Import { toLookupKey } from "electron/utils/phoneNormalization" instead. The remaining shim exists ONLY for migration v40 require() compatibility.',
            },
          ],
        },
      ],

      // Block re-introducing the legacy symbol names anywhere.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportSpecifier[imported.name="normalizePhoneLookupKey"]',
          message:
            'normalizePhoneLookupKey was renamed to toLookupKey (BACKLOG-1729). Import { toLookupKey } from "electron/utils/phoneNormalization".',
        },
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },

  // TypeScript test files (without project reference)
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react: reactPlugin,
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
];
