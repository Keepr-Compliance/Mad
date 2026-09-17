module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
    jest: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
  ],
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['react'],
  rules: {
    // Code Quality
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-debugger': 'warn',

    // React
    'react/react-in-jsx-scope': 'off', // Not needed in React 17+
    'react/prop-types': 'off', // We're not using PropTypes
    'react/display-name': 'off',

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
  ignorePatterns: [
    'node_modules/',
    'dist/',
    // electron-builder's output directory (BACKLOG-3425). Packaged apps contain
    // thousands of third-party .js files; linting them is meaningless and slow.
    'release/',
    'build/',
    '*.min.js',
  ],
};
