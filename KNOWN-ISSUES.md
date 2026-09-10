# Known issues

Open defect backlog for the one-shot (exit-mode) CLI surface, found by a full audit of every
exit-mode flag plus two independent review passes over the fix branch. Every entry cites
`file:line` evidence as of the audit; re-check the line before acting on it.

This file tracks **defects**, not planned feature or flag-surface work. The approved one-shot
surface cleanup (removing `--export-format`, `--variants`, `--resolution`, `--quality`,
`--width`/`--height`, and the bare "set a preference and exit" dispatch) is tracked separately
and is not listed here.

When an item is fixed: strike it in the same commit as the fix, and per
`AGENTS.md` §Documentation & memory update `MEMORY.md` when behaviour changes.

## Fixed on `fix/one-shot-bugs` (kept for provenance)

1. `--scrape` notice went to stdout even when piped → TTY-gated (`src/cli-main.js`).
2. `Venice safe mode disabled` notice (both the `--image` site and the shared chat/one-shot
   site) polluted piped stdout → TTY-gated (`src/cli-main.js`).
3. `--resolution` / `--quality` skipped the null-list gate that `--image-format` and
   `--aspect-ratio` enforce, so a model advertising no such list received the value blindly
   while the live `/resolution` refused it → both now hard-error
   (`src/commands/image-gen.js`, documented in `MEMORY.md` and `docs/images.md`).
4. `test/input.test.js` had no `node:os` mock, so `src/input.js` wrote the developer's real
   `~/.communicator/history.json` (the `/quit`, `/smooth fast`, `original prompt!` triple).
5. `docs/commands.md` claimed `--budget` refuses turns at 100% without scoping the refusal to
   interactive sessions.
6. The mandatory-reasoning note (`Note: reasoning is mandatory for <id>; it cannot be
   disabled.`) was printed to stdout unconditionally at **both** `src/model-selection.js` sites
   and was reachable from a piped one-shot (`-m <model> --reasoning-effort none`) → TTY-gated,
   and the test that pinned the old stdout routing was flipped.
7. The whole suite could read (and previously write) the developer's real home directory.
   `scripts/run-tests.js` now points `HOME`/`USERPROFILE` at a throwaway directory for the
   entire run, and `test/test-runner-wrapper.test.js` pins that the runner resolves it.
   Note: this guarantee holds only for runs through the wrapper — a bare `node --test`
   invocation still resolves the real home, which is why `AGENTS.md` mandates `npm test`.
8. `--zdr` / `--e2ee` were silently accepted next to a `--list-*` exit mode and changed
   nothing (the exit-mode exclusion tested only `isSessionOnly`, which carried neither flag),
   and `-p venice --e2ee --list-models` even printed the E2EE session-file warning to stderr
   before listing → both are now rejected by a dedicated exit-mode rule that names only the
   flags actually passed (`Error: --zdr cannot be combined with --list-* flags.` /
   `Error: --e2ee cannot be combined with --list-* flags.` — the single-flag form each case
   actually surfaces: `--zdr` on OpenRouter; with both flags the mutual/provider gates push
   first and the rule is not the surfaced error, `src/cli-validation.js:233-236`); validation
   throws (`src/cli-main.js:78-81`) before the warning site (`:160`), so the listing no longer
   starts.
9. Bare `--config` silently dropped `--zdr`: `hasBareConfigOtherFlags`
   (`src/cli-validation.js:76-111`) listed `opts.e2ee` (`:106`) but not `opts.zdr`, so
   `communicator --config --zdr` printed the config and exited 0 → `opts.zdr` is now in the
   guard (`:106-107`, next to the pre-existing e2ee line) and the bare config view rejects it
   exactly as it already rejected `--e2ee`
   (`Error: bare --config (config view) cannot be combined with other flags.`, exit 1).
10. The interactive `/scrape` notice (`src/commands/chat/index.js:466`) was printed with
    `console.log` unconditionally and was reachable with a TTY stdin and a piped stdout
    (`communicator | cat`, then `/scrape`) → TTY-gated (stdout on a terminal, stderr when stdout
    is piped), and the two tests that pinned the old stdout routing were re-pinned.
11. `--zdr` / `--e2ee` were silently accepted next to `--export`, `--delete` and
    `--delete-all-sessions` and changed nothing, and `-p venice --export --e2ee` even printed the
    E2EE session-file warning to stderr before dispatch → the dedicated rule the item 8 fix
    introduced now covers those three paths too, still naming only the flags actually passed
    (`Error: --zdr cannot be combined with --delete-all-sessions.` etc.), while `--resume` stays
    exempt (`--resume --zdr` / `--resume --e2ee` are intended behavior). The rule sits after the
    three exclusion rules (`src/cli-validation.js:246-258`), so no previously surfaced
    `errors[0]` changes — the provider gate still wins for `-p venice --export --zdr` and the
    session-flags message still wins when a real session flag is also present.
12. `--web-results` on Venice flipped web search to `auto` — a search Venice bills — while
    dropping the count it cannot read → a provider gate now rejects the flag
    (`Error: --web-results is only available with --provider openrouter.`,
    `src/cli-validation.js:134-138`), matching the flag's documented "OpenRouter only" contract
    and the `--zdr` precedent. `/web-results` still stores a count that Venice never reads (it
    does not change the mode, so it cannot bill); `docs/web-search.md` and `MEMORY.md` updated.

## Open — piped-output purity

The contract (`MEMORY.md` §Display consistency): a piped one-shot writes **only** the answer
to stdout; artifacts and notices go to stderr. Violations are any notice written with
`console.log` on a path reachable while stdout is piped.

1. **`src/commands/config-set.js:111-114`** — `Venice safe mode disabled` and `Saved to <path>`
   go to stdout regardless of TTY. Reachable as `echo hi | communicator --no-safe-mode`.
   *Fenced:* this file is the bare set-and-exit dispatch scheduled for removal, so it is fixed
   by that cleanup rather than here.
2. ~~**`src/commands/chat/index.js:466`** — the interactive `/scrape` notice uses `console.log`
   with no TTY gate. Reachable only with a TTY stdin and a piped stdout (e.g. `communicator | cat`
   then `/scrape`; a positional prompt takes the one-shot branch at `src/cli-main.js:320`, so
   `communicator "hi" | cat` never reaches the REPL), so lower impact than the fixed sites.
   *Not fenced; unowned.*~~ **Fixed** — see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
3. **`src/commands/image-gen.js:317-323`** (`printImageOutcome`) writes `saved to …`, sizing and
   cost lines to stdout when piped. Classified as the image run's own output rather than a
   notice (there is no text answer to keep pure). Changing it would break scripts that parse
   those lines, so treat as by-design unless decided otherwise.

## Open — silent no-ops and ignored flags

4. **`[zdr]` column in `--list-models` is unreachable dead code.** `src/commands/list-models.js:12`
   prints `m.zdr`, but `:5` calls `fetchModels(apiKey)` with no options and
   `src/providers/openrouter.js:140-142` only attaches `zdr` when called with `{ zdr: true }`.
   `docs/providers.md:21` documents the tag as a working feature.
5. ~~**`--zdr` and `--e2ee` are silently accepted next to `--list-*`** and change nothing
   (`src/cli-validation.js` exit-mode exclusion list omits them). Worse,
   `-p venice --e2ee --list-models` prints the E2EE session-file warning to stderr before
   listing.~~ **Fixed** — see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
6. ~~**Bare `--config` silently drops `--zdr`.** `hasBareConfigOtherFlags`
   (`src/cli-validation.js:96-115`) lists `opts.e2ee` but not `opts.zdr`, so
   `communicator --config --zdr` prints the config and exits.~~ **Fixed** — see the matching
   entry in "Fixed on `fix/one-shot-bugs`" above.
7. **`-m <id> --system-prompt <unreadable path>` exits 0.** The config-set branch
   (`src/cli-main.js:230-235`) returns before `loadSystemPrompt` (`:291`), so the documented
   "typos fail loudly" behaviour does not hold for that combination.
8. **`-m <model> --no-watermark "hi"` is a silent no-op.** The setter path requires `!promptArg`
   and the chat path persists only safe mode, so nothing applies it and nothing warns.
9. **`--no-safe-mode` / `--no-watermark` are accepted on OpenRouter with zero request effect**
   (`src/providers/openrouter.js:262` has no `safeMode`/`hideWatermark` parameter) while the
   global pref is still written and the Venice-specific notice is still printed.
   `docs/commands.md:49` omits the Venice-only caveat that `docs/images.md:48` carries.
10. ~~**`--web-results` on Venice can turn billed search ON.** `src/flags.js:68` returns `'auto'`
    whenever `webResults != null` (the function takes no provider argument and nothing upstream
    filters by one), while Venice never reads the count (`src/providers/venice.js:263` has no
    `webResults` parameter; OpenRouter does consume it, `src/providers/openrouter.js:394-404`).
    Verified by calling the pure resolvers: `resolveWebSearchFlag({ webResults: 5 }) === 'auto'`.
    `docs/web-search.md:24` says the flag has "no effect there" — wrong for the CLI flag; only
    the `/web-results` slash command is inert (`src/commands/chat/index.js:426-433`). A persisted
    `prefs.webSearch[model] = 'off'` does not defend either (`:68` short-circuits before `:69`
    consults `prefValue`); only an explicit `--web-search off` wins (`:67` precedes `:68`). Two
    limits: `--e2ee` is rejected alongside `--web-results` (`src/cli-validation.js:138-139`), and
    billing needs a model with `capabilities.supportsWebSearch`, else `src/session-setup.js:62-63`
    exits. A bare `communicator --web-results 5` no longer bites — it is the config setter
    (`src/cli-main.js:233-247`), which only persists the count. Billing path when it does:
    `src/providers/venice.js:289-296` (`enable_web_search: 'auto'`).~~ **Fixed** — see the
    matching entry in "Fixed on `fix/one-shot-bugs`" above.
11. **`--list-endpoints` needs an API key on OpenRouter** (unconditional
    `Authorization: Bearer` at `src/providers/openrouter.js:327`) while `--list-models` and
    `--list-image-models` are keyless by design — a keyless script 401s on the endpoint listing
    for the same model.
12. **`--list-endpoints <id>` resolves against the text catalog only**, so image models cannot
    be inspected and `--image` cannot be combined with it (`src/cli-validation.js`).
13. **`--temperature default` / `--top-p default` inside a one-shot clears the persisted
    per-model preference** (`src/session-setup.js:73-80`). A flag that reads as per-run has a
    permanent side effect.
14. **`--budget` is inert on a piped one-shot** (no pre-check, no metrics, not persisted), yet
    `docs/commands.md:93` shows it used with piped stdin and `README.md:20` still describes the
    cap unscoped. `docs/commands.md`'s flag row is now precise; these two examples are not.
15. **`--width` / `--height` precedence trap.** A saved `imageDefaults.<provider>.aspectRatio`
    is applied whenever `opts.aspectRatio === undefined`, with no width/height guard
    (`src/commands/image-gen.js:185-196`); on aspect-list models the explicit pixels are then
    dropped with no note, and the code comment at `:230-233` claims the opposite. On pixel
    models the explicit pair does win. Moot if those flags are removed by the surface cleanup.

## Open — docs and comment drift

16. **`src/chat.js:116`** claims a mid-session `/budget` change is "preserved by the
    end-of-session prefs save". `/budget` never touches the prefs object, and `prefs.budget`
    is the standing cap for later sessions (`src/session-setup.js:16`) with the bare
    `--budget` setter as its only writer. Adding a `savePrefs` call to `/budget` would make
    the two agree and let the CLI setter be dropped.
17. **`docs/chat.md:11`** says a bare `-m <id>` "goes straight to chat"; the code makes it a
    validate-and-exit config setter (`docs/commands.md` documents it correctly).
18. **Bare `--config` prints the default path even when `--config <path>` points elsewhere**
    (`src/commands/config-view.js:2-9`), which makes the flag actively misleading. The approved
    cleanup makes the path required.
19. **Dead branch at `src/commands/list-endpoints.js:27-28`** — the Venice-specific message is
    unreachable because the model id always comes from the same cached catalog.
20. **`docs/commands.md`'s Venice web-search example fails as written.** With
    `--web-search [mode]` the optional value swallows the following prompt, which then fails
    validation. Same trap applies to `--config [path]`, `--resume [session-id]`,
    `--list-endpoints [model]`, `--delete [partial-id]`, `--delete-all-sessions [y/N]` — worth
    a positional-order note or an explicit `=` example.

## Open — prefs, sessions and data hygiene

21. **The real `~/.communicator.json` still contains leaked test keys** — `temperature` and
    `topP` for `test/model-a`. The `scripts/run-tests.js` wrapper change above prevents new
    leaks; these stale keys remain and are harmless but should be purged deliberately, not
    silently.
22. **Every one-shot run rewrites global state**: it claims a session file and rewrites
    `~/.communicator.json` (`src/commands/one-shot.js`, `src/session-setup.js:147-176`). Writes
    are atomic but unsynchronised, so concurrent agent/CI invocations are read-modify-write on
    the same prefs file and can lose updates. An opt-in no-save switch for headless runs is the
    candidate fix.
23. **Piped prompts are `.trim()`ed** (`src/cli-utils.js:20`), so a piped diff or code block
    loses its leading indentation and trailing newline before reaching the model.

## Open — non-interactive reachability

24. **`-x/--export`, `--delete` and any `-r/--resume` with an id are rejected without a TTY in
    every form**, including picker-free single-id paths (`src/cli-validation.js:220-222`), so
    "keep it for scripts/CI/agents" is aspirational for those three. Only `--list-sessions` and
    `--delete-all-sessions y` genuinely work headless today. Either open the gate on the
    picker-free paths or stop citing automation as their rationale.
25. **Partial-id ambiguity silently opens an interactive picker** instead of failing fast
    (`src/sessions.js:54-67`). For `--delete` that means a scripted caller could block on a
    prompt; a non-interactive mode should prefer an ambiguity error.
26. **`-m <image-model> "prompt"` and `--image` validate the same flags differently** — the
    `-m` path hard-rejects `--variants`/`--resolution`/`--quality`/`--seed`/`--width`/`--height`
    (`src/cli-validation.js:252-260`) while both route into the identical
    `runImageCommand`. Consolidation candidate.

## Open — test-suite hygiene

27. **Node 26.8.2 reporter quirk**: 4 tests in `test/one-shot.test.js` execute but their
    pass-result lines are not listed or counted by the spec and TAP reporters (pre-existing;
    23 declared vs 20 reported at the parent commit). Failures are still counted and named, so
    a regression stays loud — but a silent pass count is a trap for future audits.
28. **Untested paths**: the `--debug` → interactive-chat wiring has no CLI-level test (only the
    one-shot path and the unit-level ctx flag are covered), and `--export <unique-id>` on a
    non-TTY is unverifiable while the blanket gate fires first.
29. **`--delete-all-sessions` and the multi-select confirmation have no test pinning that the
    printed session list matches the confirmed set** (`src/commands/delete-cmd.js:18-22`).

## Open — flag combinations (found while fixing item 5)

30. ~~**The gap item 5 fixed has the same shape next to the other exit paths.** `--zdr`/`--e2ee`
    are absent from `isSessionOnly` (`src/cli-validation.js:21-37`, read only at `:119`), so the
    exclusions built on it — `--delete-all-sessions` (`:202`), `--export` (`:238`) and
    `--delete` (`:242`) — never see them. Verified by calling `validateCliFlags` directly:
    `--export --zdr`, `--delete --zdr`, `--delete-all-sessions y --zdr` and
    `--export --zdr --output-dir out` all return `[]` on OpenRouter, as do
    `--export --e2ee -p venice`, `--delete --e2ee -p venice` and
    `--delete-all-sessions y --e2ee -p venice` on Venice, while `--export --temperature 0.5`
    errors. `-p venice --export --zdr` is refused only by the provider gate (`:130-132` for zdr,
    `:126-128` for e2ee), not by the exclusion.
    The `--e2ee` variants are not fully inert: `src/cli-main.js:156-161` still prints
    `Warning: --e2ee encrypts messages sent to the API, but the session file stores them
    unencrypted.` to stderr before the export/delete/delete-all dispatch (`:200`/`:217`/`:224`) —
    the same shape item 5 closed for `--list-*`.
    The intended exception is real: `--resume <id> --zdr` / `--resume <id> --e2ee` return `[]`
    because the resume rule (`:246-248`) never reads `sessionOnlyFlags` (`--resume id
    --temperature 0.5` also returns `[]`, and `docs/providers.md:24,54` documents the intent).
    **But the reason this entry gives is wrong:** adding both flags to `isSessionOnly` would not
    touch `--resume` at all. It would instead (a) change the surfaced `--list-*` error from the
    purpose-built `Error: --zdr cannot be combined with --list-* flags.` to the generic
    session-flags wording, since `src/cli-main.js:80` throws `errors[0]` and `:226-228` precedes
    `:233-236`, and (b) land the intended new rejections with that generic wording. The fix needs
    a rule that names only the flags actually passed, next to the item 8 rule, with the resume
    exception kept explicit.~~ **Fixed** — see the matching entry in "Fixed on
    `fix/one-shot-bugs`" above.
