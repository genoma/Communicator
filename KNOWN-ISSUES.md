# Known issues

Open defects for the Communicator CLI, one item per entry under "Open issues" below. This file
lists **open items only**:

- Fixing an item means deleting it here, in the same commit as the fix — never a struck entry,
  a provenance entry or a "fixed in" note. Git history is the record of past items, and the
  behavior a fix establishes goes to `MEMORY.md` (plus `README.md`/`docs/` when user-visible)
  as usual.
- The audit-era references `F1`–`F49` and `O1`–`O46` are retired with the entries that used
  them. New items are titled headings cited by title, so no number outlives the issue it names.
- Defects only. Planned features, flag-surface changes and work with its own plan document do
  not belong here, and an intentional behavior kept after review is documented in
  `MEMORY.md`/`docs/` instead of being kept open here.

## Open issues

### Reasoning-only turns drop the streamed reasoning

A completed turn whose finish reason is `length` (the model spent its whole output budget on
reasoning) but which streamed reasoning and no content falls into the empty-output verdict in
`src/turn-runner.js`: the user message is popped/stashed and the streamed reasoning is not salvaged,
so the transcript loses the only output the turn produced. The Esc/stop and Ctrl+C/interrupt paths
already append a reasoning-only partial (see MEMORY.md §Display consistency contract); this path
needs the same producer plus its own replay-parity tests. Filed separately from the context-overflow
honesty work, which deliberately left it out to avoid adding a new reasoning-partial producer
mid-slice.
