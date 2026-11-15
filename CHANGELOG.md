# Changelog

## 2.5.0

- **A user model switch is a bust of its own.** `model_select` with source `set` or `cycle` marks the
  next decision as `bust: "switch"`: the model the user just picked has never seen this prefix, so the
  next request writes all of it. Works for any pair of selected models — `opus -> router/*`,
  `router/* -> opus`, or two concrete models — because the comparison is on the *selected* model.
- **The router's internal choices are not switches.** It registers virtual models and resolves per
  request; it never calls `setModel`, so it emits no `model_select`. The extension sees no event and
  does nothing, which is the point: routing is not a user decision.
- A switch is decided when the next run starts (`before_agent_start`), not when it happens: switching
  and switching back without sending a message costs nothing. A switch followed by a reload is picked
  up at `session_start` by comparing the recorded selected model with the current one.
- Consumed once per switch, whether or not it fires: below the line there is nothing to compact, and a
  flag left over would later look like a bust on a warm cache.

# Changelog

## 2.4.0

- **One "known bust" trigger.** `cacheCold` becomes `bust: "expired" | "drift"`, decided by a single
  `bustTokens` line (default 150k) instead of a band under the soft line. A bust is expensive in
  proportion to the context, not to the window, so the line is its own setting: above it, compact
  before the next request and pay one summary plus a small write instead of a full-prefix rewrite.
- **Drift detection.** The system prompt is fingerprinted on every request and recorded in a
  `compaction-percent:prompt` entry (once per changed prompt, not per request). At `session_start`
  the current fingerprint is compared with the recorded one: a re-read `AGENTS.md` — or a pi upgrade
  changing the docs path — under a warm cache used to cost a whole-prefix write (measured $1.61 on a
  240k session); it now compacts first at 150k+.
- No baseline (a session written before this version) is never treated as drift: the first start
  records one, the next compares against it.

## 2.3.0

- **The lines are token counts, not percentages of the window.** `softTokens` (250k) and `hardTokens`
  (300k) apply to every model that can hold them: a 500k window now compacts at 250k instead of at 25%
  of its window (125k). Only the ceiling moves — a model that cannot hold the hard line uses
  `hardWindowFraction` (90%) of its window, and the soft line keeps `softGapTokens` below it (capped at
  a quarter of the hard line for very small windows).
- `marginPercent` became `marginTokens` (50k): the switch margin and the cold-cache band are now
  absolute too, so they do not shrink to 25k on a 500k model.
- Commands take counts with `k`/`m` suffixes: `/compact-pct 250k`, `/compact-pct hard 300k`,
  `/compact-pct margin 50k`, plus `/compact-pct fraction 0.9` for the ceiling.
- `percent` / `forcedPercent` / `marginPercent` are no longer read. An old config file is ignored and
  the defaults apply, so a session that edits the file by hand should be updated once.

## 2.2.2

- Compact before a request that would write the whole prefix anyway. When the provider's cache entry
  has expired (the model's `promptCache` tier — one hour under `PI_CACHE_RETENTION=long`) and the
  context is within `marginPercent` (5 points) of the soft line, the boundary compacts even though it
  is below the line. Observed: an unanswered question sat for 62 minutes, then the turn that answered
  it paid a full write of the whole context.
- The age is measured from the last assistant message, not the last session entry: a long-running
  tool does not refresh a provider cache entry, so a tool result two hours later still means cold.

## 2.2.1

- Compact **before the first request** after a resume, and after an aborted run. Both reach the next
  turn with no boundary in between: a resumed session never ran `agent_before_settle`, and pi skips
  that hook entirely for an aborted run. A 607k-token resume was therefore billed as a full cold
  write ($4.86 at 1-hour retention) and hard-compacted twenty seconds later.
- The upfront path uses `ctx.compact()`: nothing is running at `session_start` or `agent_settled`, so
  there is no continuation to abort. It summarises through the same `session_before_compact` handler,
  blocks the first message until it finishes, and gives up after 180 s rather than hanging.

## 2.2.0

- Removed the footer segment and the `statusLine` key: pi's own footer already shows the context
  window, and a second number next to it was noise. `/compact-pct status` still reports the next
  model, the window, both lines and the summarisers.

## 2.1.0

- `compactionModels`: an ordered list of summarisers instead of one hard-coded model. Tried until one
  answers, so a quota-blocked provider or a stale key moves to the next entry.
- `"current"` stands for the model the session is already using (the router's next model when it is
  known), so a list can always end in something that works. `[]` means pi native.
- `/compact-pct model a,b,current` edits the list; `/compact-pct model none` hands summarising back to pi.
- A single `compactionModel` from 2.0 is still read as a one-item list.

## 2.0.0

- Two thresholds: soft (`percent`, 40) at run end / before a switch, hard (`forcedPercent`, 60) between
  turns of a tool loop. `marginPercent` lowers the soft line on a switch only.
- Windows come from the model that will serve the **next** request (live accessor / `router:next`
  from pi-subscription-router), so a fallback to a smaller model is compacted *before* it, not after.
- Compaction is a boundary draft (`agent_before_settle`, `turn_end`), never `ctx.compact()`, so it
  neither aborts the run nor drops the router's continuation.
- Summaries by `compactionModel` (default `router/compact`); `/compact` and overflow use it via
  `session_before_compact`, falling back to pi's model if it is unavailable.
- Cut computed on pi's projection; previous summary carried forward; never splits a tool call/result.
- Effectiveness guard, failure backoff, `PI_COMPACTION_PERCENT_LOG`.
- Removed: `agent_settled` + `ctx.compact()`, `windowStrategy` experiment.

## 1.0.0

Percentage trigger with `/compaction-percent`.
