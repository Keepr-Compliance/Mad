/**
 * ESLint v9+ Flat Config
 * This configuration file supports ESLint 9+
 * For more information: https://eslint.org/docs/latest/use/configure/configuration-files
 */

const reactPlugin = require('eslint-plugin-react');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

/**
 * BACKLOG-2403 — ban direct `node-sqlite3` handle construction.
 *
 * `new sqlite3.Database(path, mode)` with no open callback does not throw on a
 * failed open: it EMITS an `error` event, and an `error` event with no listener
 * is an uncaught exception, which in the Electron main process is a dead app.
 * A `try`/`catch` around the queries does not help — the open fails before any
 * query runs. That four-line shape looks fine and had spread to SEVEN call
 * sites (BACKLOG-2392 found it, 2403 fixed the rest), so it is now a lint error
 * rather than a convention.
 *
 * Matches the MEMBER form only (`sqlite3.Database`, `sqlite3.verbose().Database`).
 * `better-sqlite3-multiple-ciphers` is used as a bare `new Database(...)`, is
 * synchronous, and THROWS on a failed open — it is unaffected and must not be
 * flagged.
 *
 * The single legitimate construction lives in
 * `electron/services/db/readOnlySqlite.ts` and carries an inline disable.
 */
const NODE_SQLITE3_DATABASE_RULE = {
  selector:
    'NewExpression[callee.type="MemberExpression"][callee.property.name="Database"]',
  message:
    'Do not construct a node-sqlite3 Database directly (BACKLOG-2403): a failed open emits an unhandled `error` event and kills the main process. Use openSqliteReadOnly() from electron/services/db/readOnlySqlite.',
};

module.exports = [
  // Ignore patterns
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      // BACKLOG-2787 finding 3 (folded into this PR because eslint.config.js is
      // already in its diff): the `.js`-only pattern stopped matching the moment
      // the base block started covering `.mjs`/`.cjs`, so a minified ES-module
      // or CJS bundle would be fully linted — thousands of findings from a file
      // no one wrote. No such file exists today; the pattern is the guard.
      '**/*.min.js',
      '**/*.min.mjs',
      '**/*.min.cjs',
    ],
  },

  // Base configuration for all files
  {
    files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
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
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',

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

      // BACKLOG-2403: a bare node-sqlite3 handle kills the main process on a
      // failed open. Applied to .js too (electron/main.js) so the crash cannot
      // come back through a file the TypeScript block does not cover.
      'no-restricted-syntax': ['error', NODE_SQLITE3_DATABASE_RULE],

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
    // packages/** are workspace leaf packages linted by their own co-located
    // config (they are not part of the root tsconfig project, so typed linting
    // here would throw "file not included in project"). See the packages/**
    // boundary block at the end of this file.
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', 'packages/**'],
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
        // BACKLOG-2403 — see below. Duplicated in the JS block so a .js file
        // cannot reintroduce the crash.
        NODE_SQLITE3_DATABASE_RULE,
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

  // BACKLOG-1747: packages/* leaf-boundary guard.
  // Workspace packages (e.g. @keepr/ui) sit at the bottom of the dependency
  // graph and MUST NOT import from the app (src/), Electron (electron/), or the
  // portals — only their own source and published packages. The authoritative,
  // always-invoked guard lives in each package's co-located eslint.config.js
  // (`npm run lint -w @keepr/ui`); this block enforces the same boundary if/when
  // the root flat config governs packages. `project: null` avoids typed-linting
  // (packages files are not in the root tsconfig project).
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        project: null,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react: reactPlugin,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*', '@electron/*', '@types/*'],
              message:
                'packages/* must not import app path-aliases (@/ = src/, @electron/, @types/). Leaf package boundary (BACKLOG-1747).',
            },
            {
              group: ['**/src/**', '**/electron/**'],
              message:
                'packages/* must not reach into the app (src/) or Electron (electron/). Leaf package boundary (BACKLOG-1747).',
            },
            {
              group: ['**/broker-portal/**', '**/admin-portal/**'],
              message:
                'packages/* must not import from the portals. Leaf package boundary (BACKLOG-1747).',
            },
          ],
        },
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  // BACKLOG-2780 (absorbed into BACKLOG-2777) — the CI gate scripts are linted.
  //
  // Two holes made `scripts/**` unlintable before this block existed:
  //   1. `npm run lint` was `eslint electron src` — scripts/ was never passed in.
  //   2. `.mjs` matched NO `files:` block above (the base block listed only
  //      `**/*.js|jsx`), so even `npx eslint scripts/ci/check-test-drift.mjs`
  //      applied zero rules and always exited 0. A deliberately planted unused
  //      variable passed clean — proof the green carried no information.
  // (1) is fixed in package.json; (2) by `**/*.mjs`/`**/*.cjs` in the base block.
  //
  // This block then re-tunes three rules for the tree, because the defaults are
  // wrong for CLI/CI scripts specifically — NOT to quiet findings:
  //
  //   • `no-console: 'off'` — these scripts have no other output channel. Their
  //     console lines ARE the gate's verdict, printed for a human or for the CI
  //     log. 130+ warnings here would bury the real findings.
  //
  //   • `eqeqeq` with `{ null: 'ignore' }` — every one of the 5 pre-existing
  //     errors in this tree was the deliberate `x == null` idiom (one check for
  //     both null and undefined) in QA measurement helpers, e.g.
  //     `subject: (r.subject == null ? '' : String(r.subject))`. Expanding those
  //     to `=== null || === undefined` would be a no-op reformat of files this
  //     PR does not own. `!=`/`==` against anything OTHER than null is still an
  //     error.
  //
  //   • `no-unused-vars` raised from 'warn' to 'ERROR'. This one is load-bearing
  //     and must not be softened: `npm run lint` runs without `--max-warnings`,
  //     so a warning exits 0. Leaving it at 'warn' would reproduce the exact bug
  //     being fixed one layer up — coverage that reports and never fails. The
  //     control for this item (plant an unused variable in a scripts/ci file →
  //     lint must EXIT NON-ZERO) only works because of this line.
  {
    files: [
      'scripts/**/*.js',
      'scripts/**/*.jsx',
      'scripts/**/*.mjs',
      'scripts/**/*.cjs',
      '.claude/scripts/**/*.js',
      '.claude/scripts/**/*.mjs',
      '.claude/scripts/**/*.cjs',
    ],
    rules: {
      'no-console': 'off',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // TypeScript under scripts/**. `project: null` (untyped linting) is required:
  // the root tsconfig.json includes `scripts/qa/harness/**` but NOT the rest of
  // scripts/, so `scripts/qa/drive-pivot.ts` threw a hard parse error ("file was
  // not found in any of the provided project(s)") the moment the tree was linted.
  // Nothing configured here is a type-aware rule, so no check is lost — same
  // reasoning as the packages/** block below.
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.tsx', '.claude/scripts/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: null,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-console': 'off',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
