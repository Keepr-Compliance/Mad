/**
 * ESLint v9+ flat config for the Keepr Android companion (Expo / React Native, TS).
 *
 * PRIMARY PURPOSE (BACKLOG-2198): a STATIC, Hermes-independent guard against the
 * temporal-dead-zone (TDZ) crash class that shipped in BACKLOG-2196 —
 * `permissions.tsx` read a `const` before its own declaration, which throws
 * `ReferenceError: Cannot access '<x>' before initialization` under Hermes the
 * instant that code path runs. Jest/jest-expo cannot reproduce it (Babel's
 * transform does not preserve `const` TDZ — only Hermes throws), so the jest
 * "renders-without-crashing" test on #2050 passes even for TDZ-broken code.
 * `@typescript-eslint/no-use-before-define` catches it statically instead.
 *
 * FLAT CONFIG, on purpose: the root repo uses flat config (`../eslint.config.js`),
 * and ESLint 8.57+ walks up to the nearest ancestor flat config. This
 * co-located flat config makes `npx eslint` run from `android-companion/` (i.e.
 * `npm run lint`) resolve THIS file — not the root's — which lints `electron/src`
 * with rules irrelevant to (and unresolvable for) the companion.
 *
 * Kept intentionally minimal (no style overhaul) so it is a focused regression
 * guard. `no-undef` is off because TypeScript already handles undefined
 * references and the RN/Expo/Jest global surface is large.
 */
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');
const reactHooks = require('eslint-plugin-react-hooks');

/**
 * BACKLOG-2198 — the real fix for the BACKLOG-2196 crash class.
 *
 * `variables: false` is the load-bearing option, and its meaning is subtle: it
 * does NOT disable variable checking. Per the rule's own implementation, it
 * controls whether references from a SEPARATE execution context (a nested
 * function that runs later) are reported. With `false`, the rule:
 *
 *   - STILL reports a SAME-SCOPE synchronous forward reference — the real TDZ,
 *     e.g. BACKLOG-2196's `const hasDenied = ... !allGranted;` sitting one line
 *     ABOVE `const allGranted = ...` in the same component body. That throws a
 *     Hermes `ReferenceError` at render (a launch-blocker). ✅ caught.
 *   - IGNORES a deferred reference from inside a nested function/JSX render,
 *     e.g. the idiomatic React Native `const styles = StyleSheet.create({...})`
 *     declared at the bottom of a file and read inside the component's render.
 *     By the time render runs the module is fully evaluated — no TDZ. ✅ silent.
 *
 * This distinguishes the crash class from the safe idiom via config alone, so
 * we neither weaken the guard (the RN/Expo default is to disable the rule
 * outright) nor churn 200+ safe declarations. `functions: false` because
 * function declarations hoist safely; type-only refs ignored for the same reason.
 *
 * Evidence: node_modules/@typescript-eslint/eslint-plugin `isOuterVariable`
 * (returns `options.variables` only when the reference is in an OUTER scope);
 * base rule `isFromSeparateExecutionContext` + its "don't skip ... because of
 * TDZ" guard. Verified empirically against the pre-BACKLOG-2196 permissions.tsx.
 */
const noUseBeforeDefine = [
  'error',
  {
    functions: false,
    classes: true,
    variables: false,
    enums: true,
    typedefs: true,
    ignoreTypeReferences: true,
    allowNamedExports: false,
  },
];

module.exports = [
  // Ignore build output, native projects, and non-source dirs.
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      'android/**',
      'ios/**',
      'dist/**',
      'web-build/**',
      'coverage/**',
      'patches/**',
      'scripts/**',
      '**/*.config.js',
      'eslint.config.js',
    ],
  },

  // Application + service source (TypeScript / TSX).
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      // TypeScript already resolves references; the base rule cannot see TS
      // types/enums/overloads, so use the TS-aware version only.
      'no-undef': 'off',
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': noUseBeforeDefine,

      // React Hooks. `rules-of-hooks` catches a real bug class (conditional /
      // out-of-order hook calls). `exhaustive-deps` is a warning — it is
      // advisory and the codebase already carries intentional
      // `eslint-disable-next-line react-hooks/exhaustive-deps` directives
      // (registering the plugin also makes those pre-existing directives valid
      // rather than "rule not found" errors).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
