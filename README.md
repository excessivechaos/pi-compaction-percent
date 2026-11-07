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
  "dryRun": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Off leaves pi's own trigger as the only compaction. |
| `percent` | `40` | Compact once context exceeds this percentage of the window. Clamped to 5–95. |
| `statusLine` | `true` | Show `📉 40% · 213k/500k (43%)` in the footer. |
| `dryRun` | `false` | Log the decision, never compact. |

## Commands

pi's `/settings` screen is schema-driven from `settings.json`, and extensions cannot add rows to it,
so the setting lives in a command and in a JSON file:

```
/compaction-percent            status: current percent, window, context, threshold, config path
/compaction-percent 40         set the percentage (persists immediately)
/compaction-percent on|off     enable or disable the extension's trigger
/compaction-percent line       toggle the footer segment
/compaction-percent dry-run    toggle deciding without compacting
/compact-pct 40                alias for the same command
```

`~/.pi/agent/compaction-percent.json` is the same setting, so a bootstrap script can write it
instead.

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
