import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
// Resolve jiti next to the pi install that is running the test; PI_PI_DIR overrides.
const PI_DIR = process.env.PI_PI_DIR ?? process.env.PI_AGENT_INSTALL ?? "/home/qualidiv/.pi/agent/install/releases/1.5.0";
const { createJiti } = await import(`${PI_DIR}/node_modules/jiti/lib/jiti.mjs`);
const j = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": `${PI_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
  "@earendil-works/pi-ai": `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  typebox: `${PI_DIR}/node_modules/typebox/build/index.mjs` } });
const m = await j.import("../index.ts");
let checks = 0; const eq = (a, b, l) => { assert.deepEqual(a, b, l); checks++; };
const C = (o = {}) => ({ ...m.DEFAULT_CONFIG, ...o });

// threshold math per window — the whole point: one rule, two windows
eq(m.thresholdTokens(40, 1_000_000), 400_000, "40% of 1M");
eq(m.thresholdTokens(40, 500_000), 200_000, "40% of 500k");
eq(m.thresholdTokens(40, undefined), undefined, "no window -> no threshold");
eq(m.thresholdTokens(40, 0), undefined, "zero window -> no threshold");

const now = 1_000_000;
eq(m.decide({ config: C(), tokens: 399_999, contextWindow: 1_000_000, now }).compact, false, "just below 40% of 1M");
eq(m.decide({ config: C(), tokens: 400_000, contextWindow: 1_000_000, now }).compact, true, "exactly 40% of 1M");
eq(m.decide({ config: C(), tokens: 200_000, contextWindow: 500_000, now }).compact, true, "exactly 40% of 500k");
eq(m.decide({ config: C(), tokens: 199_999, contextWindow: 500_000, now }).compact, false, "just below 40% of 500k");
eq(m.decide({ config: C({ percent: 60 }), tokens: 400_000, contextWindow: 1_000_000, now }).compact, false, "60% moves the line");
eq(m.decide({ config: C({ enabled: false }), tokens: 900_000, contextWindow: 1_000_000, now }).reason, "disabled", "off wins");
eq(m.decide({ config: C(), tokens: undefined, contextWindow: 1_000_000, now }).reason, "no-usage", "no usage");
eq(m.decide({ config: C(), tokens: 500_000, contextWindow: undefined, now }).reason, "no-window", "no window");
eq(m.decide({ config: C(), tokens: 500_000, contextWindow: 1_000_000, now, lastCompactionAt: now - 1000 }).reason, "cooling", "cooldown holds");
eq(m.decide({ config: C(), tokens: 500_000, contextWindow: 1_000_000, now, lastCompactionAt: now - 20_000 }).compact, true, "cooldown expired");

eq(m.clampPercent("40"), 40, "string percent");
eq(m.clampPercent(40.4), 40, "rounds");
eq(m.clampPercent(4), undefined, "below range");
eq(m.clampPercent(96), undefined, "above range");
eq(m.clampPercent("abc"), undefined, "not a number");
eq(m.clampPercent(undefined), undefined, "undefined");

// config round-trip through a file
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "cpct-"));
const path = join(dir, "compaction-percent.json");
eq(m.loadConfig(path), C(), "missing file -> defaults");
m.saveConfig(C({ percent: 55, statusLine: true }), path);
eq(m.loadConfig(path), C({ percent: 55, statusLine: true }), "round-trip");
eq(m.loadConfig(join(dir, "nope.json")).percent, 40, "unreadable -> defaults");

console.log(`${checks} checks passed`);

// resolveWindow: the report of the window must survive router/* virtual models (ctx.model window 0)
{
  const { resolveWindow } = m;
  const router = { model: { contextWindow: 0 } };
  eq(resolveWindow(router, { contextWindow: 500_000 }), 500_000, "usage wins over a 0 virtual window");
  eq(resolveWindow(router, undefined), undefined, "no usage, virtual window 0 -> undefined");
  eq(resolveWindow({ model: { contextWindow: 1_000_000 } }, undefined), 1_000_000, "falls back to ctx.model");
  eq(resolveWindow({}, { contextWindow: 0 }), undefined, "0 window is never a threshold");
  console.log(`${checks} checks passed (with resolveWindow)`);
}
