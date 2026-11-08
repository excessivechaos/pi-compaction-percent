# Changelog

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
