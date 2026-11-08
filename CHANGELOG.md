# Changelog

## 1.1.0

- `windowStrategy` (`floor` by default): the rule applies to the **smallest window among the models
  the session can be routed to**, read from the router profile's chain, instead of the window of the
  model that answered last. A fallback to a smaller rung no longer triggers a compaction after the
  switch, which removes the second cache miss. `/compaction-percent floor|served` switches at
  runtime; `served` restores the previous behaviour and the full big-model window.
- Status reports the strategy and every candidate window:
  `candidates claude-opus-5-5 1000k, gpt-6.1-sol 500k, deepseek-v4.1-flash 1000k`.
- Router profiles are re-read only when `subscription-router.json` changes.
- Documented why compaction cannot run before a request: `ctx.compact()` aborts, and pi stops a run
  whose abort was requested during `before_agent_start`.

## 1.0.0

- Percentage-based compaction: the trigger is `percent` of the serving model's `contextWindow`,
  evaluated at `agent_settled` so `ctx.compact()` never aborts a live run.
- `/compaction-percent` and `/compact-pct`: `status`, a percentage (5–95), `on`/`off`, `line`,
  `dry-run`. Values persist to `$PI_CODING_AGENT_DIR/compaction-percent.json` immediately.
- Optional footer segment `📉 40% · 213k/500k (43%)`.
- `Nothing to compact` and `Already compacted` are treated as benign no-ops with a 20% backoff, so
  a short session does not retry every turn or flash an error.
- `dryRun` for checking the rule without writing compactions.
- `decide()` and `thresholdTokens()` are pure and covered by `test/decide.test.mjs`.
