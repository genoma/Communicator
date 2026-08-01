# read-multiline (vendored)

This directory is a vendored copy of [`@toiroakr/read-multiline`](https://github.com/toiroakr/read-multiline)
version **0.4.1** (MIT license, zero runtime dependencies).

- Copied from `node_modules/@toiroakr/read-multiline/dist/` (the package's `dist` build output).
- Files are kept byte-close to upstream except for the `suggest` patch (see below) so
  future upstream diffs are easy to apply.
- The npm dependency was removed from `package.json`; `src/input.js` imports
  `../vendor/read-multiline/index.js` instead.

## Patch: `suggest` option

The upstream library has no suggestion/autocomplete support. A minimal patch adds a
`suggest` option to `readMultiline`:

- `index.js` — reads `suggest` from options and stores it on `state`; stores the initial
  styled footer as `state.baseFooterText`.
- `input.js` — binds Tab (`\t`) and Shift+Tab (`\x1b[Z`) to cycle through the suggestion
  list when one is active.
- `editing.js` — calls `refreshSuggestions` at the end of `onContentChanged`; adds
  `cycleSuggestion`.
- `rendering.js` — adds `refreshSuggestions`, which renders matching suggestions into the
  footer slot (reusing `setFooter`/`drawBelowEditor`).

Diff with upstream:

```
diff -r node_modules/@toiroakr/read-multiline/dist src/vendor/read-multiline
```
