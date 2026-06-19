/* ESLint config (legacy .eslintrc format for ESLint 8). */
module.exports = {
  root: true,
  env: { browser: true, es2021: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2021, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', '*.config.ts', '*.config.js', '*.cjs'],
  rules: {
    // Allow intentional infinite loops (e.g. SSE read loop).
    'no-constant-condition': ['error', { checkLoops: false }],
    // The `any` escape hatch is used deliberately in a few typed-boundary spots.
    '@typescript-eslint/no-explicit-any': 'off',
    // Underscore-prefixed names are intentionally unused.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
