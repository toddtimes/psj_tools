import js from '@eslint/js';
import globals from 'globals';

/* The site's code must not make network requests or evaluate strings; the CSP blocks both, so catch them here first. */
const siteRules = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-restricted-globals': ['error',
    { name: 'fetch', message: 'The tools make no network requests (CSP connect-src is none).' },
    { name: 'XMLHttpRequest', message: 'The tools make no network requests (CSP connect-src is none).' },
    { name: 'WebSocket', message: 'The tools make no network requests (CSP connect-src is none).' },
    { name: 'EventSource', message: 'The tools make no network requests (CSP connect-src is none).' }
  ],
  'no-restricted-properties': ['error',
    { object: 'navigator', property: 'sendBeacon', message: 'The tools make no network requests.' }
  ],
  'no-restricted-syntax': ['error',
    { selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value=/^(style|on)/i]", message: 'Inline styles and event handlers are blocked by the CSP; use a class or addEventListener.' }
  ]
};

export default [
  { ignores: ['site/vendor/', 'node_modules/'] },
  js.configs.recommended,
  { rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] } },
  {
    /* Shared helpers in site/lib/ and each tool's script in site/js/ are classic scripts sharing the page's globals. */
    files: ['site/lib/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals.browser },
    rules: { ...siteRules, 'no-unused-vars': ['error', { caughtErrors: 'none', varsIgnorePattern: '^(PdfReader|Site)$' }] }
  },
  {
    files: ['site/js/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser, PdfReader: 'readonly', Site: 'readonly', module: 'readonly' } },
    rules: siteRules
  },
  {
    /* The pdf.js worker entry and its fallbacks are ES modules. */
    files: ['site/lib/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser },
    rules: siteRules
  },
  {
    files: ['scripts/**/*.mjs', '*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node }
  }
];
