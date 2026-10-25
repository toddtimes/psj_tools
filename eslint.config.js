import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/', 'node_modules/'] },
  js.configs.recommended,
  { rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] } },
  {
    /* Shared helpers in lib/ and each tool's script in js/ are classic scripts sharing the page's globals. */
    files: ['lib/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals.browser },
    rules: { 'no-unused-vars': ['error', { caughtErrors: 'none', varsIgnorePattern: '^PdfReader$' }] }
  },
  {
    files: ['js/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser, PdfReader: 'readonly', module: 'readonly' } }
  },
  {
    files: ['scripts/**/*.mjs', '*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node }
  }
];
