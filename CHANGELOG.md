# Changelog

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
