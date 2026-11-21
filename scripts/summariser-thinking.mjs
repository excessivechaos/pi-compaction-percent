/**
 * Summariser thinking-level experiment.
 *
 * Replays a real session's conversation through the same summarisation call the extension makes
 * (`generateSummaryWithUsage`), once with thinking off and once at max, and reports wall time,
 * usage (including reasoning tokens), cost and the summary text so the two can be compared.
 *
 *   node ~/pi-compaction-percent/scripts/summariser-thinking.mjs [--session <file>] [--target 100000]
 *                                                                 [--arms off,max] [--out /tmp/sum]
 *
 * Costs money: two summarisation requests over the chosen prefix (~$0.03 for a 100k prefix).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const PI_DIR = process.env.PI_PI_DIR ?? (() => {
	const base = join(homedir(), ".pi", "agent", "install", "releases");
	const versions = readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
	versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	return join(base, versions.at(-1));
})();

const { createJiti } = await import(`${PI_DIR}/node_modules/jiti/lib/jiti.mjs`);
const j = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": `${PI_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
		"@earendil-works/pi-ai": `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist/index.js`,
		typebox: `${PI_DIR}/node_modules/typebox/build/index.mjs`,
	},
});
const pi = await j.import(`${PI_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`);

const PROVIDER = arg("provider", "commandcode");
const MODEL_ID = arg("model", "deepseek/deepseek-v4.1-flash");
const TARGET = Number(arg("target", "100000"));
const ARMS = arg("arms", "off,max").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = arg("out", "/tmp/summariser-thinking");

/** Newest session file under ~/.pi/agent/sessions, unless one is named. */
function defaultSession() {
	const base = join(homedir(), ".pi", "agent", "sessions");
	const files = [];
	for (const dir of readdirSync(base)) {
		let names;
		try {
			names = readdirSync(join(base, dir));
		} catch {
			continue;
		}
		for (const name of names) if (name.endsWith(".jsonl")) files.push(join(base, dir, name));
	}
	files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return files[0];
}

const sessionPath = arg("session", defaultSession());

/** Messages as the projection hands them to the summariser: role-carrying, system dropped. */
function loadMessages(path) {
	const rows = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
	const messages = [];
	let previousSummary;
	for (const line of rows) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "compaction" && typeof entry.summary === "string") previousSummary = entry.summary;
		if (entry.type !== "message" || entry.message === undefined) continue;
		if (entry.message.role === "system") continue;
		messages.push(entry.message);
	}
	return { messages, previousSummary };
}

/** Oldest-first trim to roughly `target` tokens, keeping whole messages. */
function trim(messages, target) {
	let total = 0;
	let start = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const tokens = pi.estimateTokens(messages[i]);
		if (total + tokens > target) break;
		total += tokens;
		start = i;
	}
	// Never start on a tool result with no call before it.
	while (start < messages.length && messages[start].role === "toolResult") start++;
	return { messages: messages.slice(start), tokens: total };
}

/**
 * The runtime only knows providers that loaded in-process; a provider extension (commandcode)
 * registers its catalog at session start, so fall back to the shape its cache describes.
 */
const FALLBACK_BASE_URL = arg("base-url", "https://api.commandcode.ai/provider/v1");
function fallbackModel() {
	const cache = join(homedir(), ".pi", "agent", `${PROVIDER}-models.json`);
	const entry = JSON.parse(readFileSync(cache, "utf8")).models.find((m) => m.id === MODEL_ID) ?? {};
	return {
		id: MODEL_ID,
		name: entry.name ?? MODEL_ID,
		provider: PROVIDER,
		api: entry.api ?? "openai-responses",
		baseUrl: FALLBACK_BASE_URL,
		reasoning: entry.reasoning ?? true,
		input: ["text", "image"],
		contextWindow: entry.contextWindow ?? 1_000_000,
		maxTokens: entry.maxTokens ?? 65_536,
		// Measured from compaction usage: $0.15/M in, $0.60/M out.
		cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.15 },
	};
}

const runtime = await pi.ModelRuntime.create();
const model = runtime.getModel(PROVIDER, MODEL_ID) ?? fallbackModel();
console.log(`session  ${sessionPath}`);
console.log(`model    ${PROVIDER}/${MODEL_ID}  ctx ${model.contextWindow}  maxTokens ${model.maxTokens}`);

const loaded = loadMessages(sessionPath);
const cut = trim(loaded.messages, TARGET);
console.log(`prefix   ${cut.messages.length} messages, ~${cut.tokens} tokens`);
if (loaded.previousSummary) console.log(`previous summary carried (${loaded.previousSummary.length} chars)`);

mkdirSync(OUT, { recursive: true });
const results = [];
for (const arm of ARMS) {
	process.stdout.write(`\n=== thinking=${arm} ... `);
	const started = Date.now();
	let result;
	try {
		result = await pi.generateSummaryWithUsage(
			cut.messages,
			model,
			undefined, // _reserveTokens: unused, summaries use the model's output limit
			undefined, // apiKey: the runtime resolves credentials
			undefined, // headers
			undefined, // signal: let it finish
			undefined, // customInstructions
			loaded.previousSummary,
			arm,
			runtime.streamSimple.bind(runtime),
		);
	} catch (error) {
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`FAILED after ${seconds}s: ${error instanceof Error ? error.message : String(error)}`);
		results.push({ arm, failed: true, seconds: Number(seconds), error: String(error) });
		continue;
	}
	const seconds = (Date.now() - started) / 1000;
	const usage = result.usage ?? {};
	const file = join(OUT, `${arm}.md`);
	writeFileSync(file, result.text);
	const chars = result.text.length;
	const cost = usage.cost?.total ?? 0;
	console.log(`done in ${seconds.toFixed(1)}s`);
	console.log(
		`    summary ${chars} chars | out ${usage.output ?? 0} (reasoning ${usage.reasoning ?? 0}) | in ${usage.input ?? 0} | cost $${cost.toFixed(4)}`,
	);
	console.log(`    written ${file}`);
	results.push({
		arm,
		seconds,
		chars,
		words: result.text.trim().split(/\s+/).length,
		output: usage.output ?? 0,
		reasoning: usage.reasoning ?? 0,
		input: usage.input ?? 0,
		cost,
		file,
	});
}

writeFileSync(join(OUT, "results.json"), `${JSON.stringify(results, null, 1)}\n`);
console.log("\n--- comparison ---");
for (const r of results) {
	if (r.failed) {
		console.log(`${r.arm.padEnd(6)} FAILED in ${r.seconds}s`);
		continue;
	}
	console.log(
		`${r.arm.padEnd(6)} ${String(r.seconds).padStart(6)}s  ${String(r.words).padStart(6)} words  ` +
			`reasoning ${String(r.reasoning).padStart(6)}  $${r.cost.toFixed(4)}  ${r.file}`,
	);
}
const ok = results.filter((r) => !r.failed);
if (ok.length === 2) {
	const [a, b] = ok;
	console.log(`\nthinking cost ${(b.cost - a.cost >= 0 ? "+" : "")}$${(b.cost - a.cost).toFixed(4)} (${(((b.cost - a.cost) / Math.max(a.cost, 1e-9)) * 100).toFixed(0)}%)`);
	console.log(`thinking time ${(b.seconds - a.seconds >= 0 ? "+" : "")}${(b.seconds - a.seconds).toFixed(1)}s (${(b.seconds / Math.max(a.seconds, 1)).toFixed(1)}x)`);
}
