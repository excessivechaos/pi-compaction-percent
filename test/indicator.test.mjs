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

// ---- the line itself: what, how much, how long --------------------------------------------
	is(m.indicatorText("soft", 240_000, 12_400), "⧗ compacting soft · 240k · 12s", "tier, size, seconds");
	is(m.indicatorText("bust:expired", undefined, 300), "⧗ compacting bust:expired · 0s", "no size when unknown");
	is(m.indicatorText("resume", 1_200_000, 0), "⧗ compacting resume · 1200k · 0s", "large counts stay in k, as the notices do");

// ---- a resume paints, ticks, and clears ---------------------------------------------------
	const handlers = {};
	const pi = { on: (name, fn) => { handlers[name] = fn; }, appendEntry: () => {}, registerCommand: () => {} };
	m.default(pi);
	const statuses = [];
	let compacted = 0;
	const ctx = {
		ui: { notify: () => {}, setStatus: (key, text) => statuses.push([key, text]) },
		getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000 }),
		sessionManager: { getEntries: () => [] },
		model: { provider: "anthropic", id: "claude-opus-5-5" },
		modelRegistry: { find: () => ({ contextWindow: 1_000_000 }) },
		getSystemPrompt: () => "",
		compact: (options) => { compacted++; setTimeout(() => options?.onComplete?.(), 1200); },
	};
	await handlers.session_start({ type: "session_start", reason: "resume" }, ctx);
	is(compacted, 1, "the resume compacted");
	is(statuses[0][0], "compaction", "it writes its own footer key");
	ok(statuses[1][1].startsWith("⧗ compacting resume · 400k · "), `the first paint reads ${statuses[1][1]}`);
	const ticked = statuses.filter(([, text]) => text !== undefined && !text.endsWith("· 0s"));
	ok(ticked.length >= 1, "the line ticks while the summary runs");
	is(statuses.at(-1)[1], undefined, "and clears when it ends");
	const painted = statuses.length;
	await new Promise((done) => setTimeout(done, 1100));
	is(statuses.length, painted, "no paint after the end: the timer was cleared");

// ---- no compaction, no paint -------------------------------------------------------------
	const quietHandlers = {};
	m.default({ on: (name, fn) => { quietHandlers[name] = fn; }, appendEntry: () => {}, registerCommand: () => {} });
	const quietStatuses = [];
	let quietCompacted = 0;
	const quietCtx = {
		ui: { notify: () => {}, setStatus: (key, text) => quietStatuses.push([key, text]) },
		getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000 }),
		sessionManager: { getEntries: () => [] },
		model: { provider: "anthropic", id: "claude-opus-5-5" },
		modelRegistry: { find: () => ({ contextWindow: 1_000_000 }) },
		getSystemPrompt: () => "",
		compact: () => { quietCompacted++; },
	};
// ---- a boundary compaction paints before it summarises ------------------------------------
	// Its own factory: the resume above left a judge that would floor this boundary out.
	const boundaryHandlers = {};
	m.default({ on: (name, fn) => { boundaryHandlers[name] = fn; }, appendEntry: () => {}, registerCommand: () => {} });
	const boundaryStatuses = [];
	const boundaryCtx = {
		ui: { notify: () => {}, setStatus: (key, text) => boundaryStatuses.push([key, text]) },
		getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000 }),
		sessionManager: { getEntries: () => [] },
		model: { provider: "anthropic", id: "claude-opus-5-5" },
		modelRegistry: { find: () => ({ contextWindow: 1_000_000 }), streamSimple: () => { throw new Error("no summariser in this test"); } },
		getSystemPrompt: () => "",
		compact: () => { throw new Error("a boundary compaction returns entries; it never calls ctx.compact"); },
	};
	await boundaryHandlers.agent_before_settle({ entries: [], toolResults: [], outcome: "completed" }, boundaryCtx);
	ok(
		boundaryStatuses.some(([, text]) => typeof text === "string" && /^⧗ compacting (soft|hard) · 400k · /.test(text)),
		"the boundary paints its tier and size",
	);
	is(boundaryStatuses.at(-1)[1], undefined, "and clears after the summary, success or not");

	// Below the soft line nothing compacts, so nothing is painted either.
	await quietHandlers.session_start({ type: "session_start", reason: "resume" }, quietCtx);
	is(quietStatuses.length === 0, quietCompacted === 0, "the footer is painted exactly when a compaction starts");

console.log(`ok ${checks} checks`);
