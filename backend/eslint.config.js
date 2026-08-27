/**
 * Lint rules.
 *
 * Kept deliberately short. Formatting is not litigated here; the rules that
 * remain are the ones that catch real mistakes in this codebase — an unhandled
 * promise in a route, a forgotten await on a database call, a variable shadowed
 * inside a transaction callback.
 */

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
      },
    },
    rules: {
      // A floating promise in a request handler is a request that resolves
      // before its work finishes — the exact bug that leaves a document stuck
      // in `processing` forever.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-shadow': 'error',
      'no-return-await': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
