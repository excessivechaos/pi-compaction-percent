import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
const ok = (value, label) => { assert.ok(value, label); checks++; };
const is = (a, b, label) => { assert.equal(a, b, label); checks++; };

// ---- the prompt the provider actually receives -------------------------------------------
	is(m.wireSystemPrompt({ system: "SYSTEM" }), "SYSTEM", "a string system field");
	is(m.wireSystemPrompt({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb", "text blocks joined");
	is(m.wireSystemPrompt({ system: [{ type: "text", text: "claude code" }, { type: "text", text: "PROMPT" }] }), "claude code\nPROMPT", "oauth preamble kept");
	is(m.wireSystemPrompt({ instructions: "RESPONSES" }), "RESPONSES", "responses-style instructions");
	is(m.wireSystemPrompt({ instructions: "" }), "", "empty instructions are a prompt, not a miss");
	is(m.wireSystemPrompt({ messages: [{ role: "system", content: "HEAD" }, { role: "user", content: "hi" }] }), "HEAD", "system message head");
	is(m.wireSystemPrompt({ messages: [{ role: "developer", content: "DEV" }] }), "DEV", "reasoning models use the developer role");
	is(m.wireSystemPrompt({ messages: [{ role: "user", content: "hi" }] }), undefined, "no system message");
	is(
		m.wireSystemPrompt({
			input: [
				{ type: "additional_tools", role: "developer", tools: [] },
				{ type: "message", role: "developer", content: [{ type: "text", text: "CODEX" }] },
				{ type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
			],
		}),
		"CODEX",
		"responses-style input, past a developer tool marker",
	);
	is(
		m.wireSystemPrompt({ input: [{ type: "message", role: "system", content: [{ type: "text", text: "IN" }] }] }),
		"IN",
		"responses-style input with a system item",
	);
	is(m.wireSystemPrompt({ system: [] }), undefined, "empty block list");
	is(m.wireSystemPrompt(undefined), undefined, "no payload");
	is(m.wireSystemPrompt("RAW"), "RAW", "a payload that is already the text");

// ---- how the local render relates to what was sent ----------------------------------------
	is(m.promptView("P", "P"), "exact", "byte for byte");
	is(m.promptView("P", "PREAMBLE\nP"), "contains", "wrapped by the provider");
	is(m.promptView("P", "P\nEXTRA"), "contains", "a trailing section on the wire still carries the render");
	is(m.promptView("P\nEXTRA", "P"), "differs", "the render has text the payload never saw");
	is(m.promptView("P", "Q"), "differs", "a substitution");
	is(m.promptView("P", undefined), "none", "nothing to compare");

// ---- a change is only drift when the record could see the cached head ---------------------
	const fp = m.promptFingerprint;
	is(m.driftVerdict({ local: fp("A"), wire: fp("A"), sees: "exact" }, fp("A")), "none", "unchanged");
	is(m.driftVerdict({ local: fp("A"), wire: fp("PREAMBLE\nA"), sees: "contains" }, fp("B")), "drift", "wrapped render, changed");
	is(m.driftVerdict({ local: fp("A"), wire: fp("A"), sees: "exact" }, fp("B")), "drift", "exact render, changed");
	is(m.driftVerdict({ local: fp("A"), wire: fp("X"), sees: "differs" }, fp("B")), "unconfirmed", "views already disagreed");
	is(m.driftVerdict({ fingerprint: fp("A") }, fp("B")), "unconfirmed", "a record from before the wire view");
	is(m.driftVerdict({ fingerprint: fp("A") }, fp("A")), "none", "a legacy record that still matches");
	is(m.driftVerdict({}, fp("B")), "none", "no baseline at all");
	is(m.driftVerdict({ local: fp("A"), wire: fp("A"), sees: "exact" }, undefined), "none", "no local render to judge");

// ---- records round-trip through the transcript --------------------------------------------
	const entries = [
		{ type: "custom", customType: m.PROMPT_ENTRY, data: { fingerprint: fp("OLD") } },
		{ type: "custom", customType: "something-else", data: { local: fp("NO") } },
		{ type: "custom", customType: m.PROMPT_ENTRY, data: { fingerprint: fp("A"), local: fp("A"), wire: fp("P\nA"), sees: "contains" } },
	];
	const record = m.lastSentPromptRecord(entries);
	is(record.local, fp("A"), "newest record wins");
	is(record.wire, fp("P\nA"), "the wire view is kept");
	is(record.sees, "contains", "how the views related");
	is(record.fingerprint, fp("A"), "legacy field still written");
	is(m.lastSentPromptRecord([entries[0]]).sees, undefined, "a legacy record has no view");
	is(m.lastSentPromptRecord([{ type: "message" }]).fingerprint, undefined, "no record at all");

// ---- the log line has to point at the first difference ------------------------------------
	is(m.firstDifference("abc", "abd"), 2, "first differing byte");
	is(m.firstDifference("abc", "abc"), -1, "identical");
	is(m.firstDifference("abc", "abcd"), 3, "one is a prefix");

// ---- the summariser's thinking level ------------------------------------------------------
	is(m.readThinking("max"), "max", "a known level passes through");
	is(m.readThinking(" off "), "off", "whitespace is trimmed");
	is(m.readThinking("nonsense"), "off", "an unknown level falls back to off");
	is(m.readThinking(undefined), "off", "an absent level is off");
	is(m.DEFAULT_CONFIG.compactionThinking, "off", "the default stays off");
	ok(m.THINKING_LEVELS.includes("xhigh") && m.THINKING_LEVELS.includes("max"), "every pi level is offered");

console.log(`ok ${checks} checks`);
