import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_DIR = process.env.PI_PI_DIR ?? "/home/qualidiv/.pi/agent/install/releases/1.5.0";
const { createJiti } = await import(`${PI_DIR}/node_modules/jiti/lib/jiti.mjs`);
const j = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": `${PI_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
  "@earendil-works/pi-ai": `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  typebox: `${PI_DIR}/node_modules/typebox/build/index.mjs` } });
const m = await j.import(new URL("../index.ts", import.meta.url).pathname);

let checks = 0;
const eq = (a, b, l) => { assert.deepEqual(a, b, l); checks++; };
const C = (o = {}) => ({ ...m.DEFAULT_CONFIG, ...o });

// ---- lines: 40/60, margin 5 only on a switch --------------------------------------------------
eq(m.lines(C(), 1_000_000, false), { soft: 400_000, hard: 600_000 }, "1M no switch");
eq(m.lines(C(), 500_000, false), { soft: 200_000, hard: 300_000 }, "500k no switch");
eq(m.lines(C(), 500_000, true), { soft: 175_000, hard: 300_000 }, "500k switching: soft lowered, hard not");
eq(m.lines(C(), 256_000, true), { soft: 89_600, hard: 153_600 }, "256k switching");

// ---- decide: settle ---------------------------------------------------------------------------
const base = { config: C(), tokens: 0, window: 500_000, switching: false, now: 1000 };
const d = (o) => m.decide({ ...base, ...o });
eq(d({ boundary: "settle", tokens: 199_999 }).compact, false, "settle just under soft");
eq(d({ boundary: "settle", tokens: 200_000 }).compact, true, "settle at soft");
// the user's scenario: opus 300k, next sol 500k
eq(d({ boundary: "settle", tokens: 300_000, switching: true }), { compact: true, tier: "soft", tokens: 300_000, line: 175_000, window: 500_000 }, "300k before a switch to a 500k model compacts");
eq(d({ boundary: "settle", tokens: 150_000, switching: true }).compact, false, "150k before the same switch does not");
eq(d({ boundary: "settle", tokens: 180_000, switching: false }).compact, false, "margin does NOT apply without a switch (180k < 200k)");
eq(d({ boundary: "settle", tokens: 180_000, switching: true }).compact, true, "margin applies on a switch (180k >= 175k)");
// ---- decide: turn -----------------------------------------------------------------------------
eq(d({ boundary: "turn", tokens: 400_000, loopContinues: false }).reason, "deferred-to-settle", "no tool results defers to settle");
eq(d({ boundary: "turn", tokens: 250_000, loopContinues: true }).compact, false, "tool loop below hard line (300k)");
eq(d({ boundary: "turn", tokens: 300_000, loopContinues: true }), { compact: true, tier: "hard", tokens: 300_000, line: 300_000, window: 500_000 }, "tool loop at hard line");
eq(d({ boundary: "turn", tokens: 180_000, loopContinues: true, switching: true }).tier, "soft", "switch pending mid-loop uses the soft line");
// ---- guards -----------------------------------------------------------------------------------
eq(d({ boundary: "settle", tokens: 900_000, config: C({ enabled: false }) }).reason, "disabled", "off wins");
eq(d({ boundary: "settle", tokens: undefined }).reason, "no-usage", "no usage");
eq(d({ boundary: "settle", tokens: 900_000, window: undefined }).reason, "no-window", "no window");
eq(d({ boundary: "settle", tokens: 900_000, backoffUntil: 2000 }).reason, "backoff", "failure backoff holds");
eq(d({ boundary: "settle", tokens: 900_000, backoffUntil: 500 }).compact, true, "backoff expired");
eq(d({ boundary: "settle", tokens: 250_000, skipBelow: 300_000 }).reason, "nothing-to-compact", "no-op floor holds");

// ---- config -----------------------------------------------------------------------------------
eq(m.clampPercent("40"), 40, "string"); eq(m.clampPercent(4), undefined, "low"); eq(m.clampPercent(96), undefined, "high");
eq(m.clampPercent(0, 0, 20), 0, "margin 0 allowed"); eq(m.clampPercent(21, 0, 20), undefined, "margin cap");
eq(m.normalize(C({ percent: 50, forcedPercent: 40 })).forcedPercent, 50, "hard line never below soft");
const dir = mkdtempSync(join(tmpdir(), "cpct-")); const path = join(dir, "c.json");
eq(m.loadConfig(path), C(), "missing file -> defaults");
m.saveConfig(C({ percent: 35, forcedPercent: 55, marginPercent: 3, compactionModel: "x/y" }), path);
eq(m.loadConfig(path), C({ percent: 35, forcedPercent: 55, marginPercent: 3, compactionModel: "x/y" }), "round-trip");
eq(m.splitModelKey("commandcode/deepseek/deepseek-v4.1-flash"), { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" }, "first slash");
eq(m.splitModelKey("nope"), undefined, "no slash");

// ---- session reading: router:next freshness ----------------------------------------------------
const msg = (role, provider, model) => ({ type: "message", message: { role, provider, model } });
const nxt = (model, source = "turn_end") => ({ type: "custom", customType: "router:next", data: { model, source } });
eq(m.lastResponse([msg("user"), msg("assistant", "anthropic", "opus")]), { key: "anthropic/opus", index: 1 }, "last response");
eq(m.nextModel([msg("assistant", "a", "m"), nxt("b/n")]), { model: "b/n", source: "turn_end" }, "fresh next");
eq(m.nextModel([nxt("b/n"), msg("assistant", "a", "m")]), undefined, "next older than the latest response is stale");
eq(m.nextModel([msg("assistant", "a", "m"), nxt("b/n"), nxt("c/o", "recovery")]).model, "c/o", "newest wins (recovery after turn_end)");
eq(m.nextModel([msg("user")]), undefined, "none published");

// ---- cut: on the projection --------------------------------------------------------------------
const text = (n) => "x".repeat(n * 4); // estimateTokens ~ chars/4
let id = 0;
const pe = (type, messages, extra = {}) => ({ sourceEntry: { id: `e${id++}`, type, ...extra }, messages });
const u = (n) => ({ role: "user", content: text(n), timestamp: 0 });
const a = (n, calls = false) => ({ role: "assistant", content: [{ type: "text", text: text(n) }, ...(calls ? [{ type: "toolCall", id: "t", name: "x", arguments: {} }] : [])], timestamp: 0 });
const tr = (n) => ({ role: "toolResult", toolCallId: "t", toolName: "x", content: [{ type: "text", text: text(n) }], isError: false, timestamp: 0 });

// a tool loop: user, (assistant+call, result) x N, all one turn
id = 0;
const loop = [pe("message", [u(2000)])];
for (let i = 0; i < 10; i++) { loop.push(pe("message", [a(1000, true)]), pe("message", [tr(1000)])); }
let cut = m.chooseCut(loop, 3000);
assert.ok(cut, "cut found in a long single-turn tool loop"); checks++;
const keptFirst = loop[cut.index].messages[0].role;
assert.notEqual(keptFirst, "toolResult", "the kept tail never starts on a tool result"); checks++;
assert.ok(cut.messages.some((x) => x.role === "user"), "the user's task is inside the summarised part"); checks++;
eq(cut.firstKeptEntryId, loop[cut.index].sourceEntry.id, "firstKeptEntryId points at the kept entry");

// nothing to summarise when everything fits in the kept window
id = 0;
eq(m.chooseCut([pe("message", [u(100)]), pe("message", [a(100)])], 20_000), undefined, "small session: nothing to compact");

// previous compaction: its summary is passed on, and only the entries after it are summarised
id = 0;
const withPrev = [pe("compaction", [{ role: "compactionSummary", summary: "OLD SUMMARY", tokensBefore: 1, timestamp: 0 }], { summary: "OLD SUMMARY" }),
  pe("message", [u(3000)]), pe("message", [a(3000)]), pe("message", [u(3000)]), pe("message", [a(3000)])];
cut = m.chooseCut(withPrev, 4000);
eq(cut.previousSummary, "OLD SUMMARY", "previous summary carried forward");
assert.ok(cut.index >= 2, "cut is after the previous compaction"); checks++;
assert.ok(cut.messages.every((x) => x.role !== "compactionSummary"), "the old summary is not re-summarised as a message"); checks++;

// a context-edited (blanked) entry contributes no messages and cannot be the cut or break it
id = 0;
const edited = [pe("message", [u(3000)]), pe("message", []), pe("message", [a(3000)]), pe("message", [u(3000)]), pe("message", [a(3000)])];
cut = m.chooseCut(edited, 4000);
assert.ok(cut && edited[cut.index].messages.length > 0, "cut lands on an entry the model actually sees"); checks++;

// ---- effectiveness guard ------------------------------------------------------------------------
eq(m.floorAfter(24_000, 11_000, 40_000), undefined, "a compaction that halved the context is fine");
eq(m.floorAfter(24_000, 20_000, 40_000), 24_000, "refilled to 83%: hold until it grows by 10% of the window");
eq(m.floorAfter(600_000, 580_000, 1_000_000), 680_000, "1M window: 10% = 100k");

console.log(`${checks} checks passed`);
