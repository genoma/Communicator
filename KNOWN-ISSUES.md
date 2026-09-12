# Known issues

Open defect backlog for the one-shot (exit-mode) CLI surface, found by a full audit of every
exit-mode flag plus two independent review passes over the fix branch. Every entry cites
`file:line` evidence as of the audit; re-check the line before acting on it.

This file tracks **defects**, not planned feature or flag-surface work. The one-shot
surface cleanup (removing `--export-format`, `--variants`, `--resolution`, `--quality`,
`--width`/`--height`, and the bare "set a preference and exit" dispatch) is tracked in
`MEMORY.md` §Pending surface cleanup and is not listed here.

Reference convention: the fixed entries are `F1`–`F28` and the open-list items `O1`–`O38`
(struck items stay in place, so both ranges keep growing). Every
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
    called at `:70` and `:124`), which also made `--zdr` defer on `--resume`
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
    against the resolved provider (`src/session-setup.js:43-55`, called at `:70` and `:124`,
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
    The provider-only flags are now answered against the provider that will serve the run
    *before* the key lookup, the fetch and the `--no-safe-mode` persist (`src/cli-main.js:298-310`,
    scrape at `:323`), via the exported `assertResolvedProviderFlags`
    (`src/session-setup.js:43-55`) when there is no chapter to resume (a legacy `history.json`
    story runs on the flag's provider like a fresh run) and `assertResumeFlags` for a chapter,
    which also answers the `--e2ee`-vs-session match before the page is bought. Both routes are
    pinned by a test asserting the refused run performs no `/augment/scrape` fetch; a refused run
    no longer persists `--no-safe-mode` either.
F17. The resolved-provider guard ran *after* the API-key lookup, so
    `-p venice -r <openrouter-session> --e2ee` with `OPENROUTER_API_KEY` unset reported the
    missing key instead of the provider limitation the F14 reorder exists to surface. Both
    lookups now follow the guard: the plain resume's in `chat-start`
    (`src/commands/chat-start.js:36-37`), a chapter's via the pre-fetch guard above
    (`src/cli-main.js:298-310`, ahead of the chapter key at `:312-314`). Pinned with the key
    absent on both routes (the one-shot half needed the same key deletion to discriminate).
F18. A one-shot RPG chapter resume reset the chapter's persisted scrape count to this run's own
    while rewriting that same session file, contradicting `docs/web-scrape.md:30-31` and losing the
    flat $0.01s on the next resume — the unfixed half of the class F14 fixed for the chat path
    (`src/commands/chat-start.js:121`). The count now carries over
    (`src/commands/one-shot.js:302`), pinned by the chapter-resume test.

F19. A one-shot RPG chapter resume overwrote the chapter's cumulative cost summary:
    `state.costSummary = trackerCostSummary(tracker)` ran off a tracker that was never seeded
    from the chapter while the file written is the chapter's own, so the per-session totals a
    later `/resume` reports shrank to this run alone, and `costSummary.scrapes` disagreed with
    the `scrapes` count persisted beside it. The tracker is now seeded from the stored turns and
    flat scrape count before the turn (`src/commands/one-shot.js:75`) exactly like the
    interactive resume path (`src/chat.js:165`), with the new scrape added on top
    (`src/commands/one-shot.js:113`). Pinned by a test asserting the persisted summary carries
    the chapter's usage, scrape count and cost.

F20. `--list-models` never printed the documented `[zdr]` tag: `listModelsCmd` called
    `provider.fetchModels(apiKey)` with no options while the OpenRouter mapper only attaches `zdr`
    for `{ zdr: true }` (`src/providers/openrouter.js:140-142`), so the column (then
    `src/commands/list-models.js:12`) was unreachable (`docs/providers.md:21` documented it as
    working). The listing now asks for the ZDR index when the provider advertises one
    (`provider.meta?.supportsZdr === true`); verified live at 445 rows — 0 tagged before, 262
    after — and the index fetch is keyless and cached. An unavailable/degraded index stays silent
    (no tags), matching the listing's non-fatal style; the picker's `zdrGate` warning is unchanged.
F21. A session-shaping flag sitting next to a config setter was silently dropped by the
    set-and-exit dispatch: `isConfigSetDispatch` (`src/cli-validation.js:76-87`) treated any
    config-setter run as set-and-exit on a TTY, so `-m <id> --system-prompt <unreadable>` fetched
    the catalog, rewrote `~/.communicator.json` and exited 0 without reading the path (verified on
    the real CLI: `Model: … / Saved to …`, exit 0), and `-p venice -m <model> --scrape <url>`
    dropped the page the same way. The dispatch now returns false before either input branch when
    `--system-prompt` or `--scrape` is present (the first cut guarded only the TTY branch; the
    review pass caught that piped stdin with a pure setter still swallowed them, so the guard sits
    above the `isTTY` split), so those runs take the chat/one-shot path: the missing prompt file
    fails loudly (exit 1, no fetch, no config write), a valid one reaches `startChat`, and
    `--scrape` bills and injects the page into the chat. `--zdr`/`--e2ee` keep the old behavior until the
    surface cleanup (O31). Pinned by an `isConfigSetDispatch` unit test plus CLI tests for the
    missing prompt, the valid prompt, the scrape, and a `-m <id> --temperature 0.5` setter run
    that must still persist.
F22. `--no-watermark` was documented as a persisted global pref (`index.js` help,
    `docs/commands.md`, `docs/images.md`) but only the config-set and image paths wrote it: a text
    chat or piped one-shot dropped it silently (verified A/B — the pre-fix text run persisted no
    `hideWatermark` key while `--no-safe-mode` persisted `safeMode: false`). `src/cli-main.js` now mirrors
    the `--no-safe-mode` block — persists `hideWatermark: true` and prints the TTY-gated
    `Venice watermark disabled` notice (stdout on a terminal, stderr when stdout is piped) — on
    every text launch path; the image paths keep their own writer. Per the O9 decision the pref is
    persisted on OpenRouter runs too, exactly like safe mode. Pinned by stdout-routing,
    stderr-routing and persistence tests.
F23. `--list-endpoints <id>` resolved only against the text catalog, so the 43 OpenRouter image
    models that live solely in `/images/models` reported `Model "…" not found` even though
    `/models/<id>/endpoints` answers 200 for them (verified live; `--image` is rejected alongside
    `--list-*`, so no route existed). The explicit-id path now resolves against the text catalog
    plus the image catalog (deduped, text-first, a failed image fetch falls back to text-only); a
    Venice image id prints the existing `… is directly available on Venice (no multi-provider
    routing)` line, which this makes reachable. The interactive picker stays text-only and
    `--image --list-endpoints` stays rejected. Same commit: `fetchEndpoints` sends `Authorization`
    only when a key is present, like its sibling fetchers (O11's evidence line is updated; the
    O11's evidence line is updated; the
    item itself stays open for its disposition). Pinned by seven new `listEndpointsCmd` tests;
    the review pass also proved the Venice-direct branch reachable, which closes O19.
F24. `--aspect-ratio`/`--image-format` — documented as persisted per-provider defaults — were
    dropped by the F21 routing change whenever the same run carried `--system-prompt`/`--scrape`:
    the set-and-exit dispatch was their only text-path writer and the run no longer reaches it, so
    `communicator --system-prompt p.md --aspect-ratio 16:9` persisted (and validated) nothing. The
    shared chat/one-shot path now persists them like the other prefs — value validated through
    `resolveAspectRatio`/`resolveImageFormat`, merged with `mergeImageDefaults`, TTY-gated
    `Aspect ratio set to … (<provider> image defaults)` / `Image format set to …` notices — so the
    flags keep their documented setter meaning next to a chat run. Pinned by persist/notice and
    bad-value tests.
F25. `--image --no-watermark` was the one persisting path without the notice its safe-mode twin
    prints (`Venice safe mode disabled`), and its writer (`finalizeImageSession`) ran only after a
    successful generation, so a failed image run kept silent and saved nothing. The image branch
    now mirrors the safe-mode block: persist `hideWatermark: true` and print the TTY-gated
    `Venice watermark disabled` notice before the run. Pinned by an image-path stdout/stderr test
    whose run fails after the write.
F26. The pure prefs (`--no-watermark`, `--no-safe-mode`, `--aspect-ratio`, `--image-format`) were
    silently accepted next to `--list-*`, `--export`, `--delete` and `--delete-all-sessions` and
    changed nothing (every exit path returns before the persist blocks) — the O5/O6 shape. The
    dedicated rule introduced for `--zdr`/`--e2ee` now names them too, keeping the
    name-only-the-flags-passed form and its position after the session-flags exclusion so no
    previously surfaced `errors[0]` changes (`Error: --no-watermark cannot be combined with
    --list-* flags.` etc.). Pinned by validation tests including the ordering case.
F27. The `--list-endpoints` not-found hint pointed only at `--list-models`, which cannot list the
    image models F23 made resolvable, and a failed image-catalog fetch was swallowed, so an image
    id reported a plain "not found" with no sign the catalog had failed. The hint now names both
    catalog commands (`Use --list-models for text models or --list-image-models for image models.`)
    and the fetch failure warns like the picker (`Warning: could not load image models; showing
    text models only. (<error>)`). The config-set twin (`src/commands/config-set.js:46`) keeps the
    text-only hint on purpose: that path cannot accept an image model at all. Pinned by hint and
    warning tests.
F28. A rejected `--e2ee` resume still printed the at-rest warning first — and for an RPG chapter
    also the `Resumed RPG conversation from …` notice — before the resolved-provider guard refused
    the run (`-p venice -r <openrouter-session> --e2ee` warned, then exited 1). `src/cli-main.js`
    now holds a resumed RPG run's `--e2ee` warning and its resume notices until after that guard
    (fresh runs print theirs inline as before, and the RPG setup exit no longer warns at all,
    since it never starts a session); a plain resume's warning moved out of `main()` into
    `src/commands/chat-start.js` right after `assertResumeFlags`, sharing the literal
    `E2EE_AT_REST_WARNING` (`src/constants.js`). Verified live: both refused forms print only the
    error; an accepted Venice e2ee resume still warns, and an accepted RPG resume still prints its
    notice (both pinned in tests).

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

O4. ~~**`[zdr]` column in `--list-models` is unreachable dead code.** `src/commands/list-models.js:12`
   prints `m.zdr`, but `:5` calls `fetchModels(apiKey)` with no options and
   `src/providers/openrouter.js:140-142` only attaches `zdr` when called with `{ zdr: true }`.
   `docs/providers.md:21` documents the tag as a working feature.~~ **Fixed** — see the matching
   entry in "Fixed on `fix/one-shot-bugs`" above.
O5. ~~**`--zdr` and `--e2ee` are silently accepted next to `--list-*`** and change nothing
   (`src/cli-validation.js` exit-mode exclusion list omits them). Worse,
   `-p venice --e2ee --list-models` prints the E2EE session-file warning to stderr before
   listing.~~ **Fixed** — see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
O6. ~~**Bare `--config` silently drops `--zdr`.** `hasBareConfigOtherFlags`
   (`src/cli-validation.js:96-115`) lists `opts.e2ee` but not `opts.zdr`, so
   `communicator --config --zdr` prints the config and exits.~~ **Fixed** — see the matching
   entry in "Fixed on `fix/one-shot-bugs`" above.
O7. ~~**`-m <id> --system-prompt <unreadable path>` exits 0.** The config-set branch
   (`src/cli-main.js:234-258`) returns before `loadSystemPrompt` (`:300`), so the documented
   "typos fail loudly" behaviour does not hold for that combination.~~ **Fixed** — see the matching
   entry in "Fixed on `fix/one-shot-bugs`" above.
O8. ~~**`-m <model> --no-watermark "hi"` is a silent no-op.** The setter path requires `!promptArg`
   and the chat path persists only safe mode, so nothing applies it and nothing warns.~~ **Fixed**
   — see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
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
O11. **`--list-endpoints` needed an API key on OpenRouter** (`fetchEndpoints` sent
    `Authorization: Bearer` unconditionally at `src/providers/openrouter.js:327`) while `--list-models` and
    `--list-image-models` were keyless by design — the audit claimed a keyless script 401s on the
    endpoint listing for the same model. *Re-verified in the O12 commit: that 401 does not
    reproduce — a keyless `--list-endpoints` lists three providers and an empty `Bearer` returns
    200 — and `fetchEndpoints` now sends the header only when a key is present, like its sibling
    fetchers. The entry stays open only for its disposition decision (strike vs. hardening note).*
O12. ~~**`--list-endpoints <id>` resolves against the text catalog only**, so image models cannot
    be inspected and `--image` cannot be combined with it (`src/cli-validation.js`).~~ **Fixed** —
    see the matching entry in "Fixed on `fix/one-shot-bugs`" above.
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
    dropped with no note, and the code comment at `:235-238` claims the opposite. On pixel
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
O19. ~~**Dead branch at `src/commands/list-endpoints.js:27-28`** — the Venice-specific message is
    unreachable because the model id always comes from the same cached catalog.~~ **Fixed** by F23:
    an explicit image id now resolves from the image catalog and `venice.fetchEndpoints` re-resolves
    against the text catalog, so the Venice-direct line prints (pinned by a test).
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
    pass-result lines are not listed or counted by the spec and TAP reporters (pre-existing:
    25 declared vs 21 reported at HEAD; re-count with `grep -c '^test(' test/one-shot.test.js`).
    Failures are still counted and named, so a regression stays loud — but a silent pass count is
    a trap for future audits.
O28. **Untested paths**: the `--debug` → interactive-chat wiring has no CLI-level test (only the
    one-shot path and the unit-level ctx flag are covered), and `--export <unique-id>` on a
    non-TTY is unverifiable while the blanket gate fires first.
O29. **The multi-select `--delete` confirmation has no test pinning that the printed session
    list matches the confirmed set** (`src/commands/delete-cmd.js:16-22`). `--delete-all-sessions`
    was originally named here too, but it prints no list — it confirms a whole-directory delete
    (`src/commands/delete-all-cmd.js:18`) and reports a count (`:28`) — so only the multi-select
    path is at issue.

## Open — flag combinations (found while fixing F8)

O30. ~~**The gap F8 fixed has the same shape next to the other exit paths.** `--zdr`/`--e2ee`
    are absent from `isSessionOnly` (`src/cli-validation.js:21-37`, read only at `:132` and
    `:320`), so the exclusions built on it — `--delete-all-sessions` (`:233`), `--export` (`:269`)
    and `--delete` (`:273`) — never see them. Verified by calling `validateCliFlags` directly:
    `--export --zdr`, `--delete --zdr`, `--delete-all-sessions y --zdr` and
    `--export --zdr --output-dir out` all return `[]` on OpenRouter, as do
    `--export --e2ee -p venice`, `--delete --e2ee -p venice` and
    `--delete-all-sessions y --e2ee -p venice` on Venice, while `--export --temperature 0.5`
    errors. `-p venice --export --zdr` is refused only by the provider gate (`:130-132` for zdr,
    `:126-128` for e2ee), not by the exclusion.
    The `--e2ee` variants are not fully inert: `src/cli-main.js:156-161` still prints
    `Warning: --e2ee encrypts messages sent to the API, but the session file stores them
    unencrypted.` to stderr before the export/delete/delete-all dispatch (`:200`/`:217`/`:224`) —
    the same shape F8 closed for `--list-*`.
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
O33. ~~**A rejected `--e2ee` resume still prints the at-rest warning first.** `src/cli-main.js:160`
    prints `Warning: --e2ee encrypts messages sent to the API, but the session file stores them
    unencrypted.` before the session loads, so `-p venice -r <openrouter-session> --e2ee` — now
    correctly refused by the resolved-provider guard (`src/session-setup.js:43-55`) — warns and
    then exits 1: the same "notice before a rejected dispatch" shape F8/F11/O30 closed.
    Cosmetic (one stderr line on an error path); fixing it means moving the notice after the
    provider is known, i.e. into the session-start paths.~~ **Fixed** — see F28 above.
O34. ~~**A one-shot chapter resume overwrites the chapter's cumulative cost summary.**
    `src/commands/one-shot.js:305` sets `state.costSummary = trackerCostSummary(tracker)` from a
    tracker that was never seeded from the chapter, and the file it writes is the chapter's own
    (the payload keeps `rpgResume.sessionId`, and `:308` persists with `rpgDir: opts.rpg`). The
    interactive path both seeds the tracker from the stored messages and scrape count and prefers
    the persisted `resumeCostSummary` for display (`src/chat.js:165`, `:222-227`), so a one-shot
    chapter resume silently shrinks the per-session totals a later `/resume` reports. Fixing it
    means seeding the tracker from the chapter like the chat path does — which changes displayed
    cost, i.e. a user-visible change that needs its own approval.~~ **Fixed** — the tracker is now
    seeded from the chapter and the displayed cost change was approved; see F19 above.

## Open — found in the post-fix review pass (O4/O7/O8/O12 changes)

O35. ~~**A session flag next to an image-default setter now drops the setter.** `--aspect-ratio` and
    `--image-format` are read only by the set-and-exit dispatch (`src/commands/config-set.js:21-22`)
    and image runs (`src/commands/image-gen.js:151-153`); nothing on the chat/one-shot path reads
    them. F21's routing change therefore turns `communicator --system-prompt p.md --aspect-ratio
    16:9` (or `--scrape <url> --image-format png`) into a silent no-op — no `imageDefaults` write,
    no `Aspect ratio set to …` line, exit 0 — where it previously persisted the default (and
    validated it). Validation cannot catch it: both flags are deliberately excluded from
    `imageOnlyFlags` (`src/cli-validation.js:319-326`). Fixing it either persists `imageDefaults` on
    the text paths (a new notice, so UX approval) or rejects the pairing loudly; both belong to the
    surface-cleanup decision, since the dispatch this rides on is fenced for removal.~~ **Fixed** —
    the text paths now persist and announce them; see F24 above.
O36. ~~**Pure setters are silently ignored next to `--list-*`.** `--no-watermark`, `--no-safe-mode`,
    `--aspect-ratio` and `--image-format` are neither session flags nor `--model`/`--output-dir`, so
    the exit-mode exclusion (`src/cli-validation.js:238-240`) never sees them and the listing exits
    before the persist blocks: `--list-models --no-watermark` prints the listing and exits 0 having
    stored nothing. Pre-existing (the O5/O6 shape, for the pure setters); either extend the
    exit-mode rule with a message naming only the flags passed, or leave it to the surface cleanup.~~
    **Fixed** — the rule now names them for every exit path; see F26 above.
O37. ~~**`--image --no-watermark` persists silently and only after a successful generation.** The
    image branch finishes at `src/cli-main.js:279-280`, before the shared watermark block, so
    `--image --no-watermark` gets neither the `Venice watermark disabled` notice its safe-mode twin
    prints there (`:275-276`) nor persistence when the generation fails; its writer is
    `src/commands/image-gen.js:350`, reached only on success. Restoring parity means mirroring the
    safe-mode block in the image branch — a new visible notice, so it needs approval until then
    `docs/commands.md` documents the actual behavior.~~ **Fixed** — the image branch mirrors the
    safe-mode block; see F25 above.
O38. ~~**`--list-endpoints`' not-found hint names only `--list-models`.** Now that explicit ids may be
    image models (F23), `Error: Model "…" not found. Use --list-models to list available models.`
    (`src/commands/list-endpoints.js:77`) points at the text catalog only; the image catalog is
    `--list-image-models`. The image-fetch failure is also swallowed silently (`:54-57`), unlike the
    picker's `Warning: could not load image models; showing text models only.`. Any wording change
    is user-visible, so it needs approval.~~ **Fixed** — the hint names both catalogs and the fetch
    failure warns; see F27 above.
