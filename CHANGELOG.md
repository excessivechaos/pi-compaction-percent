# Changelog

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
