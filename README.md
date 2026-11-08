# pi-compaction-percent

Compact at a **percentage of the model's context window** instead of a fixed token reserve.

pi's automatic compaction triggers on `contextTokens > contextWindow − reserveTokens`. The reserve
is a token count, so the same number is a different fraction of every model: 40% of a 1M window is
400k, 40% of a 272k window is 109k, and one `reserveTokens` cannot express both. This extension
takes over the trigger and compares the session's live context against `percent` of whatever window
the serving model declares.

```
compaction-percent 40   →  1M window compacts at 400k, 500k window at 200k, 272k at 109k
```

## Install

```bash
pi install git:github.com/excessivechaos/pi-compaction-percent
```

Then turn pi's token trigger off, or the two rules race each other:

```jsonc
// ~/.pi/agent/settings.json
{
  "compaction": {
    "enabled": false,          // this extension owns the trigger
    "keepRecentTokens": 20000  // still honoured: how much history survives each compaction
  }
}
```

Overflow recovery keeps working with `enabled: false` — pi checks that flag in `shouldCompact()`
only, not in its overflow path, so a request that blows past the window still compacts and retries.

## Configuration

`$PI_CODING_AGENT_DIR/compaction-percent.json` (default `~/.pi/agent/compaction-percent.json`):

```json
{
  "enabled": true,
  "percent": 40,
  "statusLine": true,
  "dryRun": false,
  "windowStrategy": "floor"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Off leaves pi's own trigger as the only compaction. |
| `percent` | `40` | Compact once context exceeds this percentage of the window. Clamped to 5–95. |
| `statusLine` | `true` | Show `📉 40% · 213k/500k (43%)` in the footer. |
| `dryRun` | `false` | Log the decision, never compact. |
| `windowStrategy` | `floor` | `floor` = smallest window this session can be routed to; `served` = window of the model that answered last. See below. |

## Commands

pi's `/settings` screen is schema-driven from `settings.json`, and extensions cannot add rows to it,
so the setting lives in a command and in a JSON file:

```
/compaction-percent            status: current percent, window, context, threshold, config path
/compaction-percent 40         set the percentage (persists immediately)
/compaction-percent on|off     enable or disable the extension's trigger
/compaction-percent line       toggle the footer segment
/compaction-percent floor      window = smallest rung of the router profile (default)
/compaction-percent served     window = the model that answered last
/compaction-percent dry-run    toggle deciding without compacting
/compact-pct 40                alias for the same command
```

`~/.pi/agent/compaction-percent.json` is the same setting, so a bootstrap script can write it
instead.

## Compact before a fallback, not after it

Compacting at the moment a *smaller* model takes over would be ideal: one cache miss for the
switch, none for a compaction. pi makes that impossible for an extension. `ctx.compact()` starts
with `await this.abort()`, and pi records the consequence in its own source:

```js
// agent-session.js, _handleAgentEvent
// An abort requested while the run was starting, e.g. during before_agent_start, stops it here.
if (event.type === "agent_start" && this._agentRunAbortRequested) this.agent.abort();
```

So a pre-send compaction in `before_agent_start` cancels the prompt it was meant to protect, and one
between turns cancels the tool loop. There is no hook that runs before a provider request and can
still compact.

`windowStrategy: "floor"` sidesteps the timing problem instead of fighting it. The threshold is
`percent` of the **smallest window among the models this session can be routed to**, read from the
router profile's chain:

```
orchestrator: opus 1M · sol 500k · deepseek 1M
floor window: 500k  →  40% = 200,000 tokens
```

Context is therefore already under every rung's budget when a turn begins, so a fallback to a smaller
rung cannot need a compaction afterwards — the switch costs its one unavoidable cache miss and
nothing more. The price: on a 1M window you stop using the 200k–400k range even while the 1M rung is
serving. `windowStrategy: "served"` restores the full window and accepts a compaction after each
fallback.

Mid-turn growth is the one case neither rule can preempt: the request that crosses the line goes to
whatever rung the router picks, and the compaction follows. pi's overflow recovery still covers a
request that exceeds the window outright.

## The window a `router/*` model reports

The rule reads the window from `ctx.getContextUsage().contextWindow`, not from `ctx.model`, because
a virtual model (pi's subscription router and anything else that resolves a model per request)
reports `contextWindow: 0` on `ctx.model` while the usage report carries the window of the model
that actually served the last turn. `ctx.model` is only the fallback. With a 40% rule the footer
then reads `📉 40% · 213k/500k (43%)` even though `ctx.model` is `router/orchestrator`.

## When it compacts

Only from the idle point (`agent_settled`). `ctx.compact()` aborts the active run first, so
triggering it before a prompt would cancel the prompt and triggering it between turns would kill
the tool loop. At settle there is nothing to abort, and the next prompt starts under the threshold.

The consequence: a single long tool loop that grows past the threshold is not compacted mid-run.
pi's overflow recovery still covers the case where it grows past the *window*.

pi's two "nothing to do" refusals — `Nothing to compact (session too small)` and
`Already compacted` — are treated as benign: no error, and no retry until usage grows 20% beyond
the point that produced them.

## Why not generate `compaction.modelOverrides` instead?

An extension (or the bootstrap script) could enumerate the catalogue and write
`reserveTokens = (1 − percent) × window` per model, leaving stock compaction untouched. It works,
right up until a provider adds a model: the new model silently falls back to the global reserve,
which on a small window means compacting on every turn. The percentage rule cannot go stale,
because it is evaluated against the model that is actually serving.

## Notes

- `keepRecentTokens` is untouched and still governs how much history survives.
- Disabling pi's trigger without installing this extension leaves only overflow recovery.
- Requires pi ≥ 1.5.0 (`ctx.getContextUsage()`, `ctx.compact({ onComplete, onError })`,
  `agent_settled`).

## Development

`index.ts` is a single file; `decide()` is pure so the rule is testable without a session.

```bash
node test/decide.test.mjs
```
