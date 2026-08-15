import js from '@eslint/js'

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  globalThis: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  DOMException: 'readonly',
  EventTarget: 'readonly',
  Headers: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  ReadableStream: 'readonly',
  Response: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Buffer: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
  setImmediate: 'readonly',
}

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      semi: ['error', 'never'],
      quotes: ['error', 'single', { avoidEscape: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    ignores: ['node_modules/**', 'coverage/**', 'src/vendor/**'],
  },
]
