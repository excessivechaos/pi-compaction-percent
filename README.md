# pi-compaction-percent

Compact at a **percentage of the window of the model that will serve the next request**, at the
points where compacting is cheapest, with summaries written by a cheap model you choose.

pi's own trigger is a token reserve, so one number is a different fraction of every model, and a
fallback to a smaller model happens *after* the cold start. This extension owns the trigger and
works at the boundaries instead.

## The two lines

```
soft  40%   at run end, and before a switch to another model
hard  60%   between the turns of a tool loop, so a long task cannot reach the window
```

On a **switch** (the router is about to use a different model than the one that just answered) the
soft line drops by `marginPercent` (5): if the context is already within a few points of the incoming
model's line, compacting now beats paying the cold start and compacting a few turns later. The margin
applies *only* on a switch.

```
opus at 300k, router falls back to sol (500k):    line = 35% × 500k = 175k   -> compact first
opus at 150k, same fallback:                      under the line             -> just switch
no switch, 500k window:                           line = 40% × 500k = 200k
```

`percent` and `forcedPercent` are of the *next* model's window, so the same rule works on a 1M, a
500k and a 256k rung without a per-model table.

## How it compacts

Not with `ctx.compact()`: that aborts the run, which would also discard the router's pending
continuation. The extension returns a **boundary draft** from `agent_before_settle` / `turn_end`:

```ts
return { entries: [...event.entries, { type: "compaction", summary, firstKeptEntryId, usage }] }
```

pi appends it without an abort and rebuilds the context before the next request, so the request
that follows already carries the compacted context. The cut is computed on pi's *projection* (what the
model actually sees), never between a tool call and its result, keeping about `keepRecentTokens` of the
newest messages and carrying a previous summary forward.

Summaries are written by `compactionModel` (default `router/compact`), not by whichever expensive
model served the turn. `/compact` and overflow recovery use the same model through
`session_before_compact`. If that model is unavailable the boundary path writes nothing and retries
after 60 s; the pi-initiated path falls back to pi's own summariser.

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

Add a profile for the summariser to `subscription-router.json`, e.g. free 1M models first, then a paid
one as insurance:

```json
"compact": { "chain": [ { "model": "commandcode/reflection/beam:free" },
                        { "model": "commandcode/deepseek/deepseek-v4.1-flash" } ] }
```

Use only models whose window can hold the whole summarised span.

## Configuration

`$PI_CODING_AGENT_DIR/compaction-percent.json`:

```json
{ "enabled": true, "percent": 40, "forcedPercent": 60, "marginPercent": 5,
  "compactionModel": "router/compact", "statusLine": true, "dryRun": false }
```

| key | default | meaning |
| --- | --- | --- |
| `percent` | 40 | soft line, % of the next model's window (5–95) |
| `forcedPercent` | 60 | hard line, mid tool loop; never below `percent` |
| `marginPercent` | 5 | soft line is lowered by this on a switch (0–20) |
| `compactionModel` | `router/compact` | `provider/id` that writes summaries; empty = pi's model |
| `statusLine` | true | footer `📉 40/60% · 213k/500k (43%)` |
| `dryRun` | false | decide and log, never write |

## Commands

```
/compact-pct                  status: next model, window, soft/hard lines, switching?
/compact-pct 40               soft line
/compact-pct forced 60        hard line
/compact-pct margin 5         switch margin
/compact-pct model router/compact
/compact-pct on|off|line|dry-run
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
