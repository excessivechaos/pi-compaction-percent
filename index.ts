/**
 * pi-compaction-percent
 *
 * pi triggers automatic compaction on a fixed token reserve: `contextTokens > contextWindow −
 * reserveTokens`. That is a token number, so the same value is a different fraction of every
 * model, and keeping one percentage across models means maintaining a per-model table.
 *
 * This extension owns the trigger instead. Each turn it compares the context this session is
 * actually using with `percent` of the window the serving model declares, and compacts when it
 * crosses. Nothing is computed per model: 40% of 500k and 40% of 1M are the same rule.
 *
 * Run pi with `compaction.enabled: false` so the token trigger stays out of the way. Overflow
 * recovery is unaffected — pi checks `enabled` only in shouldCompact(), not in the overflow path,
 * so a request that blows past the window still compacts and retries.
 *
 * Config: `$PI_CODING_AGENT_DIR/compaction-percent.json`
 *   { "enabled": true, "percent": 40, "statusLine": false, "dryRun": false }
 *
 * Commands: /compaction-percent [status|on|off|<percent>]  (alias /compact-pct)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Agent dir, honouring the same override pi itself uses. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "compaction-percent.json");

export interface CompactionPercentConfig {
	enabled: boolean;
	/** Compact once the context exceeds this percentage of the model's window. */
	percent: number;
	/** Show `40% · 213k/500k` in the footer. */
	statusLine: boolean;
	/** Decide and log, never compact. */
	dryRun: boolean;
}

export const DEFAULT_CONFIG: CompactionPercentConfig = {
	enabled: true,
	percent: 40,
	statusLine: false,
	dryRun: false,
};

/** pi's refusals that mean "nothing to do", not "something broke". */
const BENIGN = /Nothing to compact|Already compacted/i;

/** Shortest interval between compactions, so a turn that does not shrink usage cannot loop. */
const COOLDOWN_MS = 15_000;

export function clampPercent(value: unknown): number | undefined {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
	const rounded = Math.round(n);
	if (rounded < 5 || rounded > 95) return undefined;
	return rounded;
}

export function loadConfig(path = CONFIG_PATH): CompactionPercentConfig {
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			percent: clampPercent(raw.percent) ?? DEFAULT_CONFIG.percent,
			statusLine: typeof raw.statusLine === "boolean" ? raw.statusLine : DEFAULT_CONFIG.statusLine,
			dryRun: typeof raw.dryRun === "boolean" ? raw.dryRun : DEFAULT_CONFIG.dryRun,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: CompactionPercentConfig, path = CONFIG_PATH): void {
	const text = `${JSON.stringify(config, null, 2)}\n`;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

/** The token count at which this config compacts a window, or undefined when it should not. */
export function thresholdTokens(percent: number, contextWindow: number | undefined): number | undefined {
	if (contextWindow === undefined || contextWindow <= 0) return undefined;
	return Math.floor((contextWindow * percent) / 100);
}

export type Decision =
	| { compact: true; tokens: number; threshold: number; window: number }
	| { compact: false; reason: "disabled" | "no-usage" | "no-window" | "below" | "cooling" };

/** Pure decision, so the rule can be tested without a session. */
export function decide(input: {
	config: CompactionPercentConfig;
	tokens: number | undefined;
	contextWindow: number | undefined;
	now: number;
	lastCompactionAt: number | undefined;
}): Decision {
	const { config, tokens, contextWindow, now, lastCompactionAt } = input;
	if (!config.enabled) return { compact: false, reason: "disabled" };
	if (tokens === undefined) return { compact: false, reason: "no-usage" };
	const threshold = thresholdTokens(config.percent, contextWindow);
	if (threshold === undefined) return { compact: false, reason: "no-window" };
	if (tokens < threshold) return { compact: false, reason: "below" };
	if (lastCompactionAt !== undefined && now - lastCompactionAt < COOLDOWN_MS) return { compact: false, reason: "cooling" };
	return { compact: true, tokens, threshold, window: contextWindow as number };
}

const STATUS_KEY = "compaction-percent";
const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

export default function compactionPercent(pi: ExtensionAPI): void {
	let config = loadConfig();
	let lastCompactionAt: number | undefined;
	/** After a benign no-op, wait until usage grows past this before asking again. */
	let skipBelowTokens: number | undefined;
	let inFlight = false;
	let current: { tokens: number; window: number } | undefined;

	/** Footer segment, so the rule is visible without opening a command. */
	const paintStatus = (ctx: ExtensionContext) => {
		if (!config.enabled || !config.statusLine || current === undefined) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const pct = current.window > 0 ? (current.tokens / current.window) * 100 : 0;
		ctx.ui.setStatus(STATUS_KEY, `📉 ${config.percent}% · ${fmt(current.tokens)}/${fmt(current.window)} (${pct.toFixed(0)}%)`);
	};

	/** Read usage from the live context and compact when the rule says so. */
	const evaluate = async (ctx: ExtensionContext, when: string) => {
		if (inFlight) return;
		const usage = ctx.getContextUsage();
		const window = ctx.model?.contextWindow;
		current = usage?.tokens === undefined || window === undefined ? undefined : { tokens: usage.tokens, window };
		paintStatus(ctx);
		const decision = decide({
			config,
			tokens: usage?.tokens,
			contextWindow: window,
			now: Date.now(),
			lastCompactionAt,
		});
		if (!decision.compact) return;
		if (skipBelowTokens !== undefined && decision.tokens < skipBelowTokens) return;
		if (config.dryRun) {
			ctx.ui.notify(`compaction-percent: would compact (${fmt(decision.tokens)} ≥ ${fmt(decision.threshold)} at ${config.percent}%)`, "info");
			return;
		}
		inFlight = true;
		lastCompactionAt = Date.now();
		ctx.ui.notify(`compaction-percent: compacting at ${fmt(decision.tokens)} of ${fmt(decision.window)} (${config.percent}%) · ${when}`, "info");
		ctx.compact({
			onComplete: (result) => {
				inFlight = false;
				skipBelowTokens = undefined;
				current = undefined;
				paintStatus(ctx);
				ctx.ui.notify(`compaction-percent: compacted, ${fmt(result.tokensBefore)} tokens summarized`, "success");
			},
			onError: (error) => {
				inFlight = false;
				// pi refuses in two cases that are not failures: there is nothing to summarize yet,
				// or the newest entry already is a compaction. Back off until usage grows, quietly.
				if (BENIGN.test(error.message)) {
					skipBelowTokens = Math.ceil(decision.tokens * 1.2);
					return;
				}
				ctx.ui.notify(`compaction-percent: compaction failed: ${error.message}`, "error");
			},
		});
	};

	const statusText = (ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const window = ctx.model?.contextWindow;
		const threshold = thresholdTokens(config.percent, window);
		const tokens = usage?.tokens;
		const lines = [
			`compaction-percent ${config.enabled ? "on" : "off"} · ${config.percent}%${config.dryRun ? " · dry-run" : ""}`,
			`model ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "—"} · window ${window === undefined ? "—" : window.toLocaleString()}`,
			`context ${tokens === undefined ? "—" : tokens.toLocaleString()}${threshold === undefined ? "" : ` · compacts at ${threshold.toLocaleString()}`}`,
			`status line ${config.statusLine ? "on" : "off"}${skipBelowTokens === undefined ? "" : ` · retry above ${skipBelowTokens.toLocaleString()}`} · config ${CONFIG_PATH}`,
		];
		return lines.join("\n");
	};

	const command = async (args: string, ctx: ExtensionContext) => {
		const arg = args.trim();
		if (arg === "" || arg === "status") {
			ctx.ui.notify(statusText(ctx), "info");
			return;
		}
		if (arg === "on" || arg === "off") {
			config = { ...config, enabled: arg === "on" };
			saveConfig(config);
			paintStatus(ctx);
			ctx.ui.notify(`compaction-percent ${arg}`, "info");
			return;
		}
		if (arg === "dry-run") {
			config = { ...config, dryRun: !config.dryRun };
			saveConfig(config);
			ctx.ui.notify(`compaction-percent dry-run ${config.dryRun ? "on" : "off"}`, "info");
			return;
		}
		if (arg === "line") {
			config = { ...config, statusLine: !config.statusLine };
			saveConfig(config);
			paintStatus(ctx);
			ctx.ui.notify(`compaction status line ${config.statusLine ? "on" : "off"}`, "info");
			return;
		}
		const percent = clampPercent(arg);
		if (percent === undefined) {
			ctx.ui.notify("usage: /compaction-percent [status|on|off|dry-run|line|<5-95>]", "error");
			return;
		}
		config = { ...config, percent };
		saveConfig(config);
		paintStatus(ctx);
		ctx.ui.notify(`compaction now at ${percent}% of the window`, "info");
	};

	pi.registerCommand("compaction-percent", {
		description: "Compact at a percentage of the model's window: /compaction-percent [status|on|off|line|5-95]",
		handler: command,
	});
	pi.registerCommand("compact-pct", {
		description: "Alias for /compaction-percent",
		handler: command,
	});

	// Compaction aborts whatever run is in flight, so it is only ever triggered from the idle
	// point: the next prompt then starts under the threshold. A long tool loop that grows past it
	// is left to pi's overflow recovery, which still runs.
	pi.on("agent_settled", async (_event, ctx) => {
		await evaluate(ctx, "settled");
	});
	// Between turns: keep the status line honest, never compact (the run is still live).
	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const window = ctx.model?.contextWindow;
		current = usage?.tokens === undefined || window === undefined ? undefined : { tokens: usage.tokens, window };
		paintStatus(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		paintStatus(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		paintStatus(ctx);
	});
}
