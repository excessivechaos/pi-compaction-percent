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

// resolveWindow: served vs floor, and router/* virtual models (ctx.model window 0)
{
  const { resolveWindow } = m;
  const registry = {
    "anthropic/claude-opus-5-5": 1_000_000,
    "openai-codex/gpt-6.1-sol": 500_000,
    "commandcode/deepseek/deepseek-v4.1-flash": 1_000_000,
  };
  const lookup = (p, id) => {
    const w = registry[`${p}/${id}`];
    return w === undefined ? undefined : { contextWindow: w };
  };
  const profiles = { orchestrator: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol", "commandcode/deepseek/deepseek-v4.1-flash"] };
  const router = { provider: "router", id: "orchestrator", contextWindow: 0 };

  // served: the window pi reports for the rung that answered
  let r = resolveWindow({ strategy: "served", usage: { contextWindow: 1_000_000 }, model: router, profiles, lookup });
  eq([r.window, r.source], [1_000_000, "served"], "served uses the answering model");

  // floor: smallest window in the chain, so a fallback to sol is always affordable
  r = resolveWindow({ strategy: "floor", usage: { contextWindow: 1_000_000 }, model: router, profiles, lookup });
  eq([r.window, r.source], [500_000, "floor"], "floor picks the smallest rung");
  eq(r.rungs.map((x) => x.window), [1_000_000, 500_000, 1_000_000], "candidates are the chain");

  // the floor does not depend on which rung answered — that is the point
  const underSol = resolveWindow({ strategy: "floor", usage: { contextWindow: 500_000 }, model: router, profiles, lookup });
  eq(underSol.window, 500_000, "floor is stable when the rung changes");

  // an unresolvable rung is skipped rather than poisoning the floor
  r = resolveWindow({ strategy: "floor", usage: { contextWindow: 1_000_000 }, model: router,
    profiles: { orchestrator: ["anthropic/claude-opus-5-5", "nope/gone"] }, lookup });
  eq(r.window, 1_000_000, "unknown rung ignored");

  // plain (non-router) model: nothing to route to, the declared window is the answer
  r = resolveWindow({ strategy: "floor", usage: undefined, model: { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 }, profiles, lookup });
  eq([r.window, r.source], [1_000_000, "floor"], "explicit model is its own floor");

  // no chain, no served window: no rule
  r = resolveWindow({ strategy: "floor", usage: undefined, model: router, profiles: {}, lookup });
  eq(r.window, undefined, "nothing known -> no threshold");
}

// helpers
{
  const { splitModelKey, floorWindow } = m;
  eq(splitModelKey("commandcode/deepseek/deepseek-v4.1-flash"), { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" }, "splits at the first slash");
  eq(splitModelKey("nope"), undefined, "no slash -> undefined");
  eq(floorWindow([1_000_000, 500_000, undefined]), 500_000, "floor ignores unknowns");
  eq(floorWindow([undefined, 0]), undefined, "zero is not a window");
}
console.log(`${checks} checks passed (window resolution)`);
