import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
/** PI_PI_DIR wins; otherwise the newest installed release, so an update does not strand the tests. */
function piDir() {
	if (process.env.PI_PI_DIR) return process.env.PI_PI_DIR;
	const base = join(homedir(), ".pi", "agent", "install", "releases");
	const versions = readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
	versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	return join(base, versions.at(-1));
}
const PI_DIR = piDir();
const { createJiti } = await import(`${PI_DIR}/node_modules/jiti/lib/jiti.mjs`);
const j = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": `${PI_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
  "@earendil-works/pi-ai": `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  typebox: `${PI_DIR}/node_modules/typebox/build/index.mjs` } });
const m = await j.import(new URL("../index.ts", import.meta.url).pathname);

let checks = 0;
const eq = (a, b, l) => { assert.deepEqual(a, b, l); checks++; };
const C = (o = {}) => ({ ...m.DEFAULT_CONFIG, ...o });

// ---- lines: absolute tokens, 250k soft / 300k hard, 90% of the window as the ceiling -----------
eq(m.lines(C(), 1_000_000, false), { soft: 250_000, hard: 300_000 }, "1M: absolute lines");
eq(m.lines(C(), 500_000, false), { soft: 250_000, hard: 300_000 }, "500k: the same absolute lines");
eq(m.lines(C(), 500_000, true), { soft: 200_000, hard: 300_000 }, "500k switching: soft drops by the margin");
eq(m.lines(C(), 272_000, false), { soft: 194_800, hard: 244_800 }, "272k: hard = 90% of the window, soft keeps its gap");
eq(m.lines(C(), 100_000, false), { soft: 67_500, hard: 90_000 }, "100k: the gap shrinks to a quarter of the hard line");
eq(m.lines(C({ softTokens: 150_000, hardTokens: 200_000 }), 1_000_000, false), { soft: 150_000, hard: 200_000 }, "configured lines are used as-is");

// ---- decide: settle ---------------------------------------------------------------------------
const base = { config: C(), tokens: 0, window: 500_000, switching: false, now: 1000 };
const d = (o) => m.decide({ ...base, ...o });
eq(d({ boundary: "settle", tokens: 249_999 }).compact, false, "settle just under soft");
eq(d({ boundary: "settle", tokens: 250_000 }), { compact: true, tier: "soft", tokens: 250_000, line: 250_000, window: 500_000 }, "settle at soft");
// a switch lowers the soft line by the margin (50k), not by a percentage of the window
eq(d({ boundary: "settle", tokens: 200_000, switching: true }), { compact: true, tier: "soft", tokens: 200_000, line: 200_000, window: 500_000 }, "200k before a switch compacts");
eq(d({ boundary: "settle", tokens: 199_999, switching: true }).compact, false, "just under the lowered line does not");
eq(d({ boundary: "settle", tokens: 200_000, switching: false }).compact, false, "margin does NOT apply without a switch");

// ---- decide: a known bust (expired cache, changed system prompt) -------------------------------
// 150k bust line, independent of the window and of the soft line
const bust = { boundary: "settle", window: 1_000_000, bust: "expired" };
eq(d({ ...bust, tokens: 149_999 }).compact, false, "bust just under the line does not compact");
eq(d({ ...bust, tokens: 150_000 }), { compact: true, tier: "bust", tokens: 150_000, line: 150_000, window: 1_000_000, bust: "expired" }, "bust at the line compacts before the write");
eq(d({ ...bust, tokens: 150_000, bust: undefined }), { compact: false, reason: "below" }, "a warm cache with a stable prompt keeps the plain soft line");
eq(d({ boundary: "turn", window: 1_000_000, bust: "expired", loopContinues: true, tokens: 150_000 }).tier, "bust", "bust on a turn with a live loop compacts");
eq(d({ boundary: "turn", window: 1_000_000, bust: "expired", loopContinues: false, tokens: 150_000 }).reason, "deferred-to-settle", "bust on a turn without a loop defers to settle");
eq(d({ ...bust, tokens: 150_000, bust: "drift" }).bust, "drift", "a changed system prompt is its own reason");
eq(d({ ...bust, tokens: 250_000 }).tier, "bust", "the bust line wins below soft");
eq(d({ ...bust, tokens: 260_000, bust: undefined }).tier, "soft", "without a bust the soft line applies");
eq(d({ boundary: "settle", window: 200_000, bust: "expired", tokens: 150_000 }).line, 150_000, "the bust line holds inside a small window");
eq(d({ boundary: "settle", window: 100_000, bust: "expired", tokens: 60_000 }).compact, false, "100k window: nothing to do at 60k");
eq(d({ boundary: "settle", window: 100_000, bust: "expired", tokens: 95_000 }).line, 90_000, "the bust line never exceeds the hard line");
eq(d({ ...bust, tokens: 150_000, config: C({ bustTokens: 200_000 }) }).compact, false, "a higher bust line is honoured");
eq(d({ ...bust, tokens: 200_000, config: C({ bustTokens: 200_000 }) }).line, 200_000, "a higher bust line is honoured at the line");

// ---- prompt fingerprints: a change is visible, the same prompt is not ---------------------------
eq(m.promptFingerprint("abc") === m.promptFingerprint("abc"), true, "same text, same fingerprint");
eq(m.promptFingerprint("abc") === m.promptFingerprint("abd"), false, "one character changes it");
eq(m.promptFingerprint("").startsWith("0:"), true, "empty text still fingerprints");
const entries = (hashes) => hashes.map((h) => ({ type: "custom", customType: m.PROMPT_ENTRY, data: { fingerprint: h } }));
eq(m.lastSentPrompt([]), undefined, "no record: unknown baseline, not drift");
eq(m.lastSentPrompt([{ type: "message", message: { role: "system" } }]), undefined, "system messages are not the record");
eq(m.lastSentPrompt(entries(["1:aaaa", "2:bbbb"])), "2:bbbb", "the newest record wins");
eq(m.lastSentPrompt([...entries(["1:aaaa"]), { type: "custom", customType: "other", data: { fingerprint: "3:cccc" } }]), "1:aaaa", "another extension's entries are ignored");

// ---- decide: turn -----------------------------------------------------------------------------
eq(d({ boundary: "turn", tokens: 400_000, loopContinues: false }).reason, "deferred-to-settle", "no tool results defers to settle");
eq(d({ boundary: "turn", tokens: 299_999, loopContinues: true }).compact, false, "tool loop below the hard line");
eq(d({ boundary: "turn", tokens: 300_000, loopContinues: true }), { compact: true, tier: "hard", tokens: 300_000, line: 300_000, window: 500_000 }, "tool loop at the hard line");
eq(d({ boundary: "turn", tokens: 220_000, loopContinues: true, switching: true }).tier, "soft", "switch pending mid-loop uses the lowered soft line");

// ---- guards -----------------------------------------------------------------------------------
eq(d({ boundary: "settle", tokens: 900_000, config: C({ enabled: false }) }).reason, "disabled", "off wins");
eq(d({ boundary: "settle", tokens: undefined }).reason, "no-usage", "no usage");
eq(d({ boundary: "settle", tokens: 900_000, window: undefined }).reason, "no-window", "no window");
eq(d({ boundary: "settle", tokens: 900_000, backoffUntil: 2000 }).reason, "backoff", "failure backoff holds");
eq(d({ boundary: "settle", tokens: 300_000, backoffUntil: 500 }).compact, true, "backoff expired");
eq(d({ boundary: "settle", tokens: 250_000, skipBelow: 300_000 }).reason, "nothing-to-compact", "no-op floor holds");

// ---- config -----------------------------------------------------------------------------------
eq(m.readTokenArg("250k"), 250_000, "k suffix");
eq(m.readTokenArg("1.2m"), 1_200_000, "m suffix");
eq(m.readTokenArg("300000"), 300_000, "plain count");
eq(m.readTokenArg("nope"), undefined, "not a count");
eq(m.readFraction("0.9", 0), 0.9, "fraction string");
eq(m.readFraction(1.5, 0.9), 0.9, "fraction above 1 rejected");
eq(m.normalize(C({ softTokens: 500_000, hardTokens: 300_000 })).softTokens, 299_000, "soft stays below hard");
eq(m.normalize(C({ hardTokens: 0 })).hardTokens, 300_000, "invalid hard falls back");

// ---- loadConfig: our deployed file --------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "cpt-"));
const path = join(dir, "compaction-percent.json");
const { writeFileSync } = await import("node:fs");
writeFileSync(path, JSON.stringify({ softTokens: 250000, hardTokens: 300000, hardWindowFraction: 0.9, softGapTokens: 50000, marginTokens: 50000 }));
eq(m.loadConfig(path).softTokens, 250_000, "loadConfig reads token lines");
eq(m.loadConfig(path).hardWindowFraction, 0.9, "loadConfig reads the ceiling");
eq(m.lines(m.loadConfig(path), 500_000, false), { soft: 250_000, hard: 300_000 }, "loaded config on a 500k window");

console.log(`ok ${checks} checks`);
