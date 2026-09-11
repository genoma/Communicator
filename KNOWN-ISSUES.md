# Known issues

Open defect backlog for the one-shot (exit-mode) CLI surface, found by a full audit of every
exit-mode flag plus two independent review passes over the fix branch. Every entry cites
`file:line` evidence as of the audit; re-check the line before acting on it.

This file tracks **defects**, not planned feature or flag-surface work. The one-shot
surface cleanup (removing `--export-format`, `--variants`, `--resolution`, `--quality`,
`--width`/`--height`, and the bare "set a preference and exit" dispatch) is tracked in
`MEMORY.md` §Pending surface cleanup and is not listed here.

Reference convention: the fixed entries are `F1`–`F14` and the open items `O1`–`O33`. Every
reference carries its prefix, so the two lists cannot be confused — do not renumber an
existing entry, and do not cite a bare number.

When an item is fixed: strike it in the same commit as the fix, and per
`AGENTS.md` §Documentation & memory update `MEMORY.md` when behaviour changes.

## Fixed on `fix/one-shot-bugs` (kept for provenance)

F1. `--scrape` notice went to stdout even when piped → TTY-gated (`src/cli-main.js`).
F2. `Venice safe mode disabled` notice (both the `--image` site and the shared chat/one-shot
   site) polluted piped stdout → TTY-gated (`src/cli-main.js`).
F3. `--resolution` / `--quality` skipped the null-list gate that `--image-format` and
   `--aspect-ratio` enforce, so a model advertising no such list received the value blindly
   while the live `/resolution` refused it → both now hard-error
   (`src/commands/image-gen.js`, documented in `MEMORY.md` and `docs/images.md`).
F4. `test/input.test.js` had no `node:os` mock, so `src/input.js` wrote the developer's real
   `~/.communicator/history.json` (the `/quit`, `/smooth fast`, `original prompt!` triple).
F5. `docs/commands.md` claimed `--budget` refuses turns at 100% without scoping the refusal to
   interactive sessions.
F6. The mandatory-reasoning note (`Note: reasoning is mandatory for <id>; it cannot be
   disabled.`) was printed to stdout unconditionally at **both** `src/model-selection.js` sites
   and was reachable from a piped one-shot (`-m <model> --reasoning-effort none`) → TTY-gated,
   and the test that pinned the old stdout routing was flipped.
F7. The whole suite could read (and previously write) the developer's real home directory.
   `scripts/run-tests.js` now points `HOME`/`USERPROFILE` at a throwaway directory for the
   entire run, and `test/test-runner-wrapper.test.js` pins that the runner resolves it.
   Note: this guarantee holds only for runs through the wrapper — a bare `node --test`
   invocation still resolves the real home, which is why `AGENTS.md` mandates `npm test`.
F8. `--zdr` / `--e2ee` were silently accepted next to a `--list-*` exit mode and changed
   nothing (the exit-mode exclusion tested only `isSessionOnly`, which carried neither flag),
   and `-p venice --e2ee --list-models` even printed the E2EE session-file warning to stderr
   before listing → both are now rejected by a dedicated exit-mode rule that names only the
   flags actually passed (`Error: --zdr cannot be combined with --list-* flags.` /
   `Error: --e2ee cannot be combined with --list-* flags.` — the single-flag form each case
   actually surfaces: `--zdr` on OpenRouter; with both flags the mutual/provider gates push
   first and the rule is not the surfaced error, `src/cli-validation.js:264-266`); validation
   throws (`src/cli-main.js:78-81`) before the warning site (`:160`), so the listing no longer
   starts.
F9. Bare `--config` silently dropped `--zdr`: `hasBareConfigOtherFlags`
   (`src/cli-validation.js:89-123`) listed `opts.e2ee` (`:119`) but not `opts.zdr`, so
   `communicator --config --zdr` printed the config and exited 0 → `opts.zdr` is now in the
   guard (`:119-120`, next to the pre-existing e2ee line) and the bare config view rejects it
   exactly as it already rejected `--e2ee`
   (`Error: bare --config (config view) cannot be combined with other flags.`, exit 1).
F10. The interactive `/scrape` notice (`src/commands/chat/index.js:467-469`) was printed with
    `console.log` unconditionally and was reachable with a TTY stdin and a piped stdout
    (`communicator | cat`, then `/scrape`) → TTY-gated (stdout on a terminal, stderr when stdout
    is piped), and the two tests that pinned the old stdout routing were re-pinned.
F11. `--zdr` / `--e2ee` were silently accepted next to `--export`, `--delete` and
    `--delete-all-sessions` and changed nothing, and `-p venice --export --e2ee` even printed the
    E2EE session-file warning to stderr before dispatch → the dedicated rule F8 introduced now
    covers those three paths too, still naming only the flags actually passed
    (`Error: --zdr cannot be combined with --delete-all-sessions.` etc.), while `--resume` stays
    exempt (`--resume --zdr` / `--resume --e2ee` are intended behavior). The rule sits after the
    three exclusion rules (`src/cli-validation.js:281-289`), so no previously surfaced
    `errors[0]` changes — the provider gate still wins for `-p venice --export --zdr` and the
    session-flags message still wins when a real session flag is also present.
F12. `--web-results` on Venice flipped web search to `auto` — a search Venice bills — while
    dropping the count it cannot read → rejected by a provider gate
    (`Error: --web-results is only available with --provider openrouter.`,
    `src/cli-validation.js:152-158`), matching the flag's documented "OpenRouter only" contract
    and the `--zdr` precedent. Two forms defer, because CLI validation only sees the flag's own
    `--provider`: a resumed session executes on the provider saved in its file, and a
    set-and-exit dispatch issues no request at all — the latter now shares
    `isConfigSetDispatch` (`src/cli-validation.js:73-84`) with `src/cli-main.js`, so the
    validator no longer re-derives the dispatch. Both forms are judged by
    `assertResolvedProviderFlags` against the resolved provider (`src/session-setup.js:43-55`,
    called at `:68` and `:122`), which also made `--zdr` defer on `--resume`
    (`src/cli-validation.js:147`) and thereby closed the same hole for a resumed Venice session.
    `/web-results` still stores a count Venice never reads (it does not change the mode, so it
    cannot bill); `docs/web-search.md` and `MEMORY.md` updated. Two review rounds folded in: the
    first cut keyed on `opts.provider` alone, leaving `--resume <venice-session> --web-results 5`
    still billing and rejecting `-p venice -r <openrouter-session>`; the second added the
    `--zdr` mirror case and the piped pure-setter form.
F13. A plain `--resume` demanded the *flag* provider's API key before the session loaded:
    `-p venice -r <openrouter-session>` died with `Error: VENICE_API_KEY environment variable is
    not set.` even though the run executes on the session's provider and key
    (`src/commands/chat-start.js:35-37`). `src/cli-main.js:296-298` now resolves that key only
    when the run does not resume (an RPG chapter already carried its own), so the lookup happens
    where the provider is known instead of being asked of `-p`; a resumed Venice session without
    `VENICE_API_KEY` still fails loudly, now naming the provider the run actually uses. Verified
    A/B on the real CLI, plus both directions in `test/cli-main-success.test.js`.
F14. `--e2ee` and `--scrape` were still keyed on the flag's own `--provider`, so a resumed run
    executing on a different provider was misjudged: `-p openrouter -r <venice-session> --e2ee`
    was refused, and `-p venice -r <openrouter-session> --e2ee` passed the flag gate and started
    the chat instead of being refused. Both gates now defer on `--resume`
    (`src/cli-validation.js:141`, `:201`); `--e2ee` is judged by `assertResolvedProviderFlags`
    against the resolved provider (`src/session-setup.js:43-55`, called at `:68` and `:122`,
    message unchanged), and `--scrape` needs no new guard — the plain `--resume` form still trips
    the session-flag exclusion and the chapter form reaches `scrapeForSession`
    (`src/cli-main.js:26-27`), which rejects a provider without `scrapePage`. Two review findings
    folded in: the chapter resume was fetching and billing the page without ever injecting it
    (`src/commands/chat-start.js:107-111`, now injected and counted like the fresh path), and an
    OpenRouter resume reported the encryption mismatch instead of the provider limitation
    (`assertResumeFlags`, `src/session-setup.js:114-120`, orders the provider check first; the
    three tests pinning the old order were re-pinned, with the mismatch rule kept covered on a
    Venice fixture).

F15. The resumed image-session `/model` handoff sent an empty API key — the F13 fix stopped
    `src/cli-main.js` from resolving a key for a plain `--resume` (`src/cli-main.js:296-298`),
    but `chatStart`'s image branch handed its own `apiKey` *parameter* (now `''`) to the text
    handoff instead of the key the resume branch had already resolved from the session's
    provider, so `-r <image-session>` → `/model` → text model sent `Authorization: Bearer ` and
    401ed every turn (`src/commands/chat-start.js:286` now passes `ctx.apiKey`). The regression
    was invisible because the only test of that path passed `apiKey: 'k'` explicitly and never
    asserted the handoff's key; it now drives the real cli-main contract (`apiKey: ''`).
F16. A deferred provider gate could be answered only after a **billed** Venice scrape.
    `--zdr` / `--web-results` / `--e2ee` defer on `--resume` (`src/cli-validation.js:141`, `:147`,
    `:156-157`), but `-p venice --rpg <dir> --resume --scrape <url> --zdr` fetched and billed the
    page before `chat-start`/`one-shot` rejected the run against the chapter's provider — a
    regression for the `-p venice` form, which the parent commit refused at validation for free.
    The provider-only flags are now answered against the provider that will serve the run before
    the fetch (`src/cli-main.js:311-325`, scrape at `:326`), via the exported
    `assertResolvedProviderFlags` (`src/session-setup.js:43-55`) for a legacy `history.json`
    resume and `assertResumeFlags` for a chapter (which also answers the `--e2ee`-vs-session
    match before the page is bought). Pinned by a test asserting the refused run performs no
    `/augment/scrape` fetch.
F17. The resolved-provider guard ran *after* the API-key lookup, so
    `-p venice -r <openrouter-session> --e2ee` with `OPENROUTER_API_KEY` unset reported the
    missing key instead of the provider limitation the F14 reorder exists to surface
    (`src/commands/chat-start.js:36-37`, `src/commands/one-shot.js:41-42`). Both lookups now run
    after `assertResumeFlags`, and `test/cli-main-success.test.js` pins the provider message with
    the key absent and the E2EE mismatch also in play.
F18. A one-shot RPG chapter resume reset the chapter's persisted scrape count to this run's own
    while rewriting that same session file, contradicting `docs/web-scrape.md:30` and losing the
    flat $0.01s on the next resume — the unfixed half of the class F14 fixed for the chat path
    (`src/commands/chat-start.js:121`). The count now carries over
    (`src/commands/one-shot.js:302`), pinned by the chapter-resume test.

## Open — piped-output purity

The contract (`MEMORY.md` §Display consistency): a piped one-shot writes **only** the answer
to stdout; artifacts and notices go to stderr. Violations are any notice written with
`console.log` on a path reachable while stdout is piped.

O1. **`src/commands/config-set.js:111-114`** — `Venice safe mode disabled` and `Saved to <path>`
   go to stdout regardless of TTY. Reachable as `echo hi | communicator --no-safe-mode`.
   *Fenced:* this file is the bare set-and-exit dispatch scheduled for removal, so it is fixed
   by that cleanup rather than here.
O2. ~~**`src/commands/chat/index.js:467-469`** — the interactive `/scrape` notice uses `console.log`
   with no TTY gate. Reachable only with a TTY stdin and a piped stdout (e.g. `communicator | cat`
   then `/scrape`; a positional prompt takes the one-shot branch at `src/cli-main.js:342`, so
   `communicator "hi" | cat` never reaches the REPL), so lower impact than the fixed sites.
   *Not fenced; unowned.*~~ **Fixed** — see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
O3. **`src/commands/image-gen.js:317-323`** (`printImageOutcome`) writes `saved to …`, sizing and
   cost lines to stdout when piped. Classified as the image run's own output rather than a
   notice (there is no text answer to keep pure). Changing it would break scripts that parse
   those lines, so treat as by-design unless decided otherwise.

## Open — silent no-ops and ignored flags

O4. **`[zdr]` column in `--list-models` is unreachable dead code.** `src/commands/list-models.js:12`
   prints `m.zdr`, but `:5` calls `fetchModels(apiKey)` with no options and
   `src/providers/openrouter.js:140-142` only attaches `zdr` when called with `{ zdr: true }`.
   `docs/providers.md:21` documents the tag as a working feature.
O5. ~~**`--zdr` and `--e2ee` are silently accepted next to `--list-*`** and change nothing
   (`src/cli-validation.js` exit-mode exclusion list omits them). Worse,
   `-p venice --e2ee --list-models` prints the E2EE session-file warning to stderr before
   listing.~~ **Fixed** — see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
O6. ~~**Bare `--config` silently drops `--zdr`.** `hasBareConfigOtherFlags`
   (`src/cli-validation.js:96-115`) lists `opts.e2ee` but not `opts.zdr`, so
   `communicator --config --zdr` prints the config and exits.~~ **Fixed** — see the matching
   entry in "Fixed on `fix/one-shot-bugs`" above.
O7. **`-m <id> --system-prompt <unreadable path>` exits 0.** The config-set branch
   (`src/cli-main.js:234-258`) returns before `loadSystemPrompt` (`:300`), so the documented
   "typos fail loudly" behaviour does not hold for that combination.
O8. **`-m <model> --no-watermark "hi"` is a silent no-op.** The setter path requires `!promptArg`
   and the chat path persists only safe mode, so nothing applies it and nothing warns.
O9. **`--no-safe-mode` / `--no-watermark` are accepted on OpenRouter with zero request effect**
   (`src/providers/openrouter.js:262` has no `safeMode`/`hideWatermark` parameter) while the
   global pref is still written and the Venice-specific notice is still printed.
   `docs/commands.md:49` omits the Venice-only caveat that `docs/images.md:48` carries.
O10. ~~**`--web-results` on Venice can turn billed search ON.** `src/flags.js:68` returns `'auto'`
    whenever `webResults != null` (the function takes no provider argument and nothing upstream
    filters by one), while Venice never reads the count (`src/providers/venice.js:263` has no
    `webResults` parameter; OpenRouter does consume it, `src/providers/openrouter.js:394-404`).
    Verified by calling the pure resolvers: `resolveWebSearchFlag({ webResults: 5 }) === 'auto'`.
    `docs/web-search.md:24` says the flag has "no effect there" — wrong for the CLI flag; only
    the `/web-results` slash command is inert (`src/commands/chat/index.js:426-433`). A persisted
    `prefs.webSearch[model] = 'off'` does not defend either (`:68` short-circuits before `:69`
    consults `prefValue`); only an explicit `--web-search off` wins (`:67` precedes `:68`). Two
    limits: `--e2ee` is rejected alongside `--web-results` (`src/cli-validation.js:163-164`), and
    billing needs a model with `capabilities.supportsWebSearch`, else `src/session-setup.js:82-83`
    exits. A bare `communicator --web-results 5` no longer bites — it is the config setter
    (`src/cli-main.js:233-257`), which only persists the count. Billing path when it does:
    `src/providers/venice.js:289-296` (`enable_web_search: 'auto'`).~~ **Fixed** — see the
    matching entry in "Fixed on `fix/one-shot-bugs`" above.
O11. **`--list-endpoints` needs an API key on OpenRouter** (unconditional
    `Authorization: Bearer` at `src/providers/openrouter.js:327`) while `--list-models` and
    `--list-image-models` are keyless by design — a keyless script 401s on the endpoint listing
    for the same model.
O12. **`--list-endpoints <id>` resolves against the text catalog only**, so image models cannot
    be inspected and `--image` cannot be combined with it (`src/cli-validation.js`).
O13. **[docs-clarity, not a defect] `--temperature default` / `--top-p default` also resets the
    persisted per-model value** (`src/session-setup.js:59-67`, plus the resume branch at
    `:154-158`). This is the documented, tested contract — `docs/commands.md:12-13` defines
    `default` as clearing the saved per-model value — so the behaviour is intended; the open
    question is only that a one-shot run makes a per-invocation-looking flag write global state
    with no note at the point of use. Do **not** "fix" this by dropping the clear without also
    changing `docs/commands.md`.
O14. **`--budget` is inert on a piped one-shot** (no pre-check, no metrics, not persisted), yet
    `docs/commands.md:93` shows it used with piped stdin and `README.md:20` still describes the
    cap unscoped. `docs/commands.md`'s flag row is now precise; these two examples are not.
O15. **`--width` / `--height` precedence trap.** A saved `imageDefaults.<provider>.aspectRatio`
    is applied whenever `opts.aspectRatio === undefined`, with no width/height guard
    (`src/commands/image-gen.js:191-198`); on aspect-list models the explicit pixels are then
    dropped with no note, and the code comment at `:230-233` claims the opposite. On pixel
    models the explicit pair does win. Moot if those flags are removed by the surface cleanup.

## Open — docs and comment drift

O16. **`src/config.js:116-117`** claims a mid-session `/budget` change is "preserved by the
    end-of-session prefs save". `/budget` never touches the prefs object, and `prefs.budget`
    is the standing cap for later sessions (`src/session-setup.js:17`) with the bare
    `--budget` setter as its only writer. Adding a `savePrefs` call to `/budget` would make
    the two agree and let the CLI setter be dropped.
O17. **`docs/chat.md:11`** says a bare `-m <id>` "goes straight to chat"; the code makes it a
    validate-and-exit config setter (`docs/commands.md` documents it correctly).
O18. **Bare `--config` ignores the path it could be given** (`src/commands/config-view.js:2-9`):
    the view is dispatched only for the boolean form (`src/cli-main.js:163`), which cannot
    coexist with `--config <path>`, and it always prints `DEFAULT_CONFIG_FILE`. The flag's two
    forms therefore disagree about what `--config` means. The surface cleanup makes the path
    required.
O19. **Dead branch at `src/commands/list-endpoints.js:27-28`** — the Venice-specific message is
    unreachable because the model id always comes from the same cached catalog.
O20. **`docs/commands.md`'s Venice web-search example fails as written.** With
    `--web-search [mode]` the optional value swallows the following prompt, which then fails
    validation. Same trap applies to `--config [path]`, `--resume [session-id]`,
    `--list-endpoints [model]`, `--delete [partial-id]`, `--delete-all-sessions [y/N]` — worth
    a positional-order note or an explicit `=` example.

## Open — prefs, sessions and data hygiene

O21. **The real `~/.communicator.json` still contains leaked test keys** — `temperature` and
    `topP` for `test/model-a`. The `scripts/run-tests.js` wrapper change above prevents new
    leaks; these stale keys remain and are harmless but should be purged deliberately, not
    silently.
O22. **Every one-shot run rewrites global state**: it claims a session file and rewrites
    `~/.communicator.json` (`src/commands/one-shot.js`, `src/session-setup.js:176-195`). Writes
    are atomic but unsynchronised, so concurrent agent/CI invocations are read-modify-write on
    the same prefs file and can lose updates. An opt-in no-save switch for headless runs is the
    candidate fix.
O23. **Piped prompts are `.trim()`ed** (`src/cli-utils.js:19`), so a piped diff or code block
    loses its leading indentation and trailing newline before reaching the model.

## Open — non-interactive reachability

O24. **`-x/--export`, `--delete` and any `-r/--resume` with an id are rejected without a TTY in
    every form**, including picker-free single-id paths (`src/cli-validation.js:253-254`), so
    "keep it for scripts/CI/agents" is aspirational for those three. Only `--list-sessions` and
    `--delete-all-sessions y` genuinely work headless today. Either open the gate on the
    picker-free paths or stop citing automation as their rationale.
O25. **Partial-id ambiguity silently opens an interactive picker** instead of failing fast
    (`src/sessions.js:54-67`). For `--delete` that means a scripted caller could block on a
    prompt; a non-interactive mode should prefer an ambiguity error.
O26. **`-m <image-model> "prompt"` and `--image` validate the same flags differently** — the
    `-m` path hard-rejects `--variants`/`--resolution`/`--quality`/`--seed`/`--width`/`--height`
    (`src/cli-validation.js:310-313`) while both route into the identical
    `runImageCommand`. Consolidation candidate.

## Open — test-suite hygiene

O27. **Node 26.8.2 reporter quirk**: 4 tests in `test/one-shot.test.js` execute but their
    pass-result lines are not listed or counted by the spec and TAP reporters (pre-existing;
    23 declared vs 20 reported at the parent commit). Failures are still counted and named, so
    a regression stays loud — but a silent pass count is a trap for future audits.
O28. **Untested paths**: the `--debug` → interactive-chat wiring has no CLI-level test (only the
    one-shot path and the unit-level ctx flag are covered), and `--export <unique-id>` on a
    non-TTY is unverifiable while the blanket gate fires first.
O29. **The multi-select `--delete` confirmation has no test pinning that the printed session
    list matches the confirmed set** (`src/commands/delete-cmd.js:16-22`). `--delete-all-sessions`
    was originally named here too, but it prints no list — it confirms a whole-directory delete
    (`src/commands/delete-all-cmd.js:18`) and reports a count (`:28`) — so only the multi-select
    path is at issue.

## Open — flag combinations (found while fixing F5)

O30. ~~**The gap F5 fixed has the same shape next to the other exit paths.** `--zdr`/`--e2ee`
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
    the same shape F5 closed for `--list-*`.
    The intended exception is real: `--resume <id> --zdr` / `--resume <id> --e2ee` return `[]`
    because the resume rule (`:246-248`) never reads `sessionOnlyFlags` (`--resume id
    --temperature 0.5` also returns `[]`, and `docs/providers.md:24,54` documents the intent).
    **But the reason this entry gives is wrong:** adding both flags to `isSessionOnly` would not
    touch `--resume` at all. It would instead (a) change the surfaced `--list-*` error from the
    purpose-built `Error: --zdr cannot be combined with --list-* flags.` to the generic
    session-flags wording, since `src/cli-main.js:80` throws `errors[0]` and `:226-228` precedes
    `:233-236`, and (b) land the intended new rejections with that generic wording. The fix needs
    a rule that names only the flags actually passed, next to the F8 rule, with the resume
    exception kept explicit.~~ **Fixed** — see the matching entry in "Fixed on
    `fix/one-shot-bugs`" above.
O31. **The config-set exit path still accepts `--zdr`/`--e2ee` with any setter flag.** The F11
    rule covers the list/export/delete exits but not the set-and-exit dispatches
    (`src/cli-main.js:233-257`), so `communicator -p venice -m <model> --e2ee` (or
    `-p venice --e2ee --no-watermark`) still prints the E2EE session-file warning
    (`src/cli-main.js:156-161`) before saving and exiting 0, and `communicator -m <id> --zdr`
    drops the flag the same way. *Fenced:* this is the bare "set a preference and exit" dispatch
    the approved cleanup removes, so the surface goes away rather than getting a rule.
O32. ~~**Two provider gates still ignore a resumed session's provider.** `-p openrouter -r
    <venice-session> --e2ee` and `--scrape <url>` are refused by their provider gates
    (`src/cli-validation.js:139-141`, `:195-196`) although the run would execute on a provider
    that allows them — the mirror of the `--zdr`/`--web-results` deferral, which now follows the
    session (`:145`, `:154-156` plus `src/session-setup.js:43-55`). The key half of this item is
    fixed (F13 above), so what remains is the same deferral for `--e2ee` and `--scrape`.~~
    **Fixed** — see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
O33. **A rejected `--e2ee` resume still prints the at-rest warning first.** `src/cli-main.js:160`
    prints `Warning: --e2ee encrypts messages sent to the API, but the session file stores them
    unencrypted.` before the session loads, so `-p venice -r <openrouter-session> --e2ee` — now
    correctly refused by the resolved-provider guard (`src/session-setup.js:43-55`) — warns and
    then exits 1: the same "notice before a rejected dispatch" shape F8/F11/O30 closed.
    Cosmetic (one stderr line on an error path); fixing it means moving the notice after the
    provider is known, i.e. into the session-start paths.
O34. **A one-shot chapter resume overwrites the chapter's cumulative cost summary.**
    `src/commands/one-shot.js:305` sets `state.costSummary = trackerCostSummary(tracker)` from a
    tracker that was never seeded from the chapter, and the file it writes is the chapter's own
    (the payload keeps `rpgResume.sessionId`, and `:308` persists with `rpgDir: opts.rpg`). The
    interactive path both seeds the tracker from the stored messages and scrape count and prefers
    the persisted `resumeCostSummary` for display (`src/chat.js:165`, `:222-227`), so a one-shot
    chapter resume silently shrinks the per-session totals a later `/resume` reports. Fixing it
    means seeding the tracker from the chapter like the chat path does — which changes displayed
    cost, i.e. a user-visible change that needs its own approval.
