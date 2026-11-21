# pi-compaction-percent

Compact at a **percentage of the window of the model that will serve the next request**, at the
points where compacting is cheapest, with summaries written by a cheap model you choose.

pi's own trigger is a token reserve, so one number is a different fraction of every model, and a
fallback to a smaller model happens *after* the cold start. This extension owns the trigger and
works at the boundaries instead.

## Indicator

While a compaction runs, the footer carries one line so an idle session does not read as a hang:

```
⧗ compacting soft · 240k · 12s
```

The label is the tier or the up-front reason (`soft`, `hard`, `bust:expired`, `resume`, `switch`,
`aborted-run`), the middle number is the context being summarised, and the last is elapsed time,
ticking once a second. It clears when the summary ends, and a `dryRun` never paints it.

## The two lines

```
soft  250,000 tokens   at run end, before a switch, and when the cache has expired
hard  300,000 tokens   between the turns of a tool loop, so a long task cannot reach the window
```

They are token counts, not percentages. Carrying context costs the same per token on a 500k model as
on a 1M one, so the right threshold is an absolute number: a 1M window and a 500k window both compact
at 250k, and only the ceiling moves. A model that cannot hold the hard line uses
`hardWindowFraction` (90%) of its window instead, and the soft line keeps its gap below it:

```
1M window      soft 250k   hard 300k          (as configured)
500k window    soft 250k   hard 300k          (same numbers; 50%/60% of the window)
272k window    soft 195k   hard 245k          (hard = 90% of the window, 50k gap)
100k window    soft 68k    hard 90k           (gap shrinks to a quarter of the hard line)
```

A third trigger is a **bust we can see coming**: the next request rewrites the whole prefix no matter
what, so the only choice is what gets written. Above `bustTokens` (default 150k) the extension
compacts first — one summary plus a ~50k write instead of a 200k+ one. Two things bust a prefix:

- **`expired`** — the entry's TTL has passed (one hour under `PI_CACHE_RETENTION=long`). This is the
  case an unanswered question or a long blocking tool produces: the run is still open, nothing
  refreshed the cache, and the turn that resolves it would pay for the entire prefix.
- **`drift`** — the system prompt changed under a warm cache. Context files are re-read at session
  start, so an edited `AGENTS.md` (or a pi upgrade changing the docs path) replaces the head of the
  prompt and invalidates every token after it. Measured: a 3.5k-char `AGENTS.md` edit on a 240k
  session cost $1.61 as a full rewrite; compacting at the same moment costs ~$0.43.
  Judged against the prompt **the provider was sent**, taken from the request payload, not against
  `getSystemPrompt()`: pi re-renders the local prompt as the tool loadout changes while the cached
  head stays the one in the transcript, so the two views can diverge by themselves. A record that
  saw the local render inside the payload (`exact` or `contains`) can turn a local change into a
  claim about the cache; a record whose views already disagreed (`differs`, or one from before the
  wire view existed) logs `drift-unconfirmed` and holds, instead of spending a summary on an
  artifact.
- **`switch`** — the user picked a different model. Model caches are per provider and per model, so a
  model that has not served this session holds nothing for this prefix: the next request is a full
  write. Any switch of the *selected* model counts, including to and from a `router/*` virtual model.
  The router's own per-request choice does not: it never changes the selection, so it emits no
  `model_select` and the extension never sees it. A switch is decided when the next run starts, so
  switching back without sending a message costs nothing.

The two share one line because they share one property: the write is already unavoidable and grows
with the context, not with the window. `bustTokens` is therefore independent of `softTokens` — it
sits below it and does not move with it.

The settle and turn boundaries otherwise fire *after* a request, so two other cases reach the next turn
with no compaction at all: resuming a session that is already over the line, and a run the user aborted
(an aborted run skips `agent_before_settle`). Both compact **before the first request**, at `session_start`
and at `agent_settled`, while nothing is running. Without that, a 607k-token resume is billed as a cold
write first (measured: $4.86 at 1-hour retention) and compacted twenty seconds later.

On a **switch** (the router is about to use a different model than the one that just answered) the
soft line drops by `marginTokens` (50k): if the context is already that close to the incoming model's
line, compacting now beats paying the cold start and compacting a few turns later. Every bust is decided before the request that would pay for it; `marginTokens` no longer governs
that band.

```
context 230k, router falls back to another model:   line = 250k - 50k = 200k   -> compact first
context 180k, same fallback:                        under the line             -> just switch
no switch:                                          line = 250k
```

## How it compacts

Not with `ctx.compact()`: that aborts the run, which would also discard the router's pending
continuation. The extension returns a **boundary draft** from `agent_before_settle` / `turn_end`:

```ts
return { entries: [...event.entries, { type: "compaction", summary, firstKeptEntryId, usage }] }
```

pi appends it without an abort and rebuilds the context before the next request, so the request that follows already carries the compacted context. The cut is computed on pi's *projection* (what the
model actually sees), never between a tool call and its result, keeping about `keepRecentTokens` of the
newest messages and carrying a previous summary forward.

The exception is the upfront path: `session_start` and an aborted run's `agent_settled` have no run
to abort, so those two use `ctx.compact()` directly and summarise through the same
`session_before_compact` handler. The first message waits for the result (bounded at 300 s), so the
request it triggers is already on the compacted context.

Summaries are written by `compactionModels`, an ordered list tried until one answers — a quota-blocked
provider or a bad key just moves to the next entry. `"current"` means the model this session is already
using, and an empty list means pi native. `/compact` and overflow recovery use the same list through
`session_before_compact`; if every entry fails there, pi summarises as it always did. On the boundary
path a failed compaction writes nothing and backs off 60 s — pi's overflow recovery still guards the
window.

`compactionThinking` sets the summariser's own thinking level. Measured on a 94.5k prefix with
`deepseek-v4.1-flash`: `off` wrote a 19.9k-char summary in 42 s for $0.0122; `max` spent 1,506
reasoning tokens, wrote 25.7k chars in 65 s for $0.0141, and carried noticeably more of the concrete
numbers (exact costs, versions, window sizes) that the summary exists to preserve. The level must be
one the summariser model supports — `deepseek-v4.1-flash` offers `off`, `low`, `high`, `max`.
`scripts/summariser-thinking.mjs` replays a real session through both levels to re-measure.

## Install

```bash
pi install git:github.com/excessivechaos/pi-subscription-router   # provides the next model
pi install git:github.com/excessivechaos/pi-compaction-percent
```

List the router **before** this package in `settings.json`: a quota fallback is decided at
`agent_before_settle`, and the extension must see the router's decision.

```jsonc
{ "compaction": { "enabled": false, "keepRecentTokens": 20000 } }   // pi's token trigger off
```

Overflow recovery still works with `enabled: false` (pi checks it only in `shouldCompact()`).

To go back to pi's native compaction: `/compact-pct off` and set `compaction.enabled: true`.

Point the list at whatever is cheap today — physical models, a router profile, or `current`:

```jsonc
"compactionModels": [
  "commandcode/reflection/beam:free",            // free 1M model
  "router/compact",                              // or a router profile, if you prefer chains
  "commandcode/deepseek/deepseek-v4.1-flash",    // insurance
  "current"                                      // last resort: the model already serving
]
```

Use only models whose window can hold the whole summarised span: the summary prompt carries the
serialized conversation, so a 256k model cannot summarise a 500k compaction.

## Configuration

`$PI_CODING_AGENT_DIR/compaction-percent.json`:

```json
{ "enabled": true, "percent": 40, "forcedPercent": 60, "marginPercent": 5,
  "compactionModels": ["commandcode/reflection/beam:free", "current"],
  "dryRun": false }
```

| key | default | meaning |
| --- | --- | --- |
| `softTokens` | 250000 | soft line in tokens: run end, before a switch, cold cache |
| `hardTokens` | 300000 | hard line in tokens, mid tool loop |
| `hardWindowFraction` | 0.9 | a model that cannot hold `hardTokens` uses this much of its window |
| `softGapTokens` | 50000 | distance from the hard line down to the soft line (capped at ¼ of hard) |
| `marginTokens` | 50000 | how far a model switch lowers the soft line |
| `bustTokens` | 150000 | compact before a known prefix rewrite (expired cache, changed system prompt) |
| `compactionModels` | `["current"]` | summarisers tried in order; `"current"` = the model already serving; `[]` = pi native |
| `compactionThinking` | `"off"` | thinking level for the summariser: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `dryRun` | false | decide and log, never write |

## Commands

```
/compact-pct                  status: next model, window, soft/hard lines, switching?
/compact-pct 250k             soft line (k/m suffixes, or a plain count)
/compact-pct hard 300k        hard line
/compact-pct margin 50k       switch and cold-cache margin
/compact-pct fraction 0.9     ceiling on the hard line, as a fraction of the window
/compact-pct model beam:free,current   ordered list ("none" = pi native)
/compact-pct on|off|dry-run
```

`/compaction-percent` is the same command. Set `PI_COMPACTION_PERCENT_LOG=/path` to record every
boundary decision.

## Guards

- one compaction at a time; a failed summary backs off 60 s and says so once;
- a compaction that did not shrink the context (still above 80%) holds the next one until it has grown
  by 10% of the window;
- "nothing to compact" holds until usage grows 20%;
- a router model with no published next model warns once and falls back to the current model's window.

## Known limits

- The next model is the router's *prediction* at that moment; a new prompt can re-pick after a quota reset.
- A quota error retried inside pi's own retry loop has no boundary to act at.
- File-operation lists that pi's native summary appends are not added to our summaries.

## Development

```bash
node test/decide.test.mjs
```
