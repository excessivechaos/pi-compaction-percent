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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
	/**
	 * Which window the percentage applies to. `floor` (default) uses the smallest window among the
	 * models this session can be routed to, so a fallback to a smaller rung never has to compact
	 * after the fact; `served` uses the window of the model that answered last.
	 */
	windowStrategy: "floor" | "served";
}

export const DEFAULT_CONFIG: CompactionPercentConfig = {
	enabled: true,
	percent: 40,
	statusLine: true,
	dryRun: false,
	windowStrategy: "floor",
};

/** Parse `provider/modelId`, splitting at the first slash — ids may contain more. */
export function splitModelKey(key: string): { provider: string; id: string } | undefined {
	const i = key.indexOf("/");
	if (i <= 0 || i === key.length - 1) return undefined;
	return { provider: key.slice(0, i), id: key.slice(i + 1) };
}

/** The smallest declared window in a set, or undefined when none is known. */
export function floorWindow(windows: readonly (number | undefined)[]): number | undefined {
	const known = windows.filter((w): w is number => typeof w === "number" && w > 0);
	return known.length === 0 ? undefined : Math.min(...known);
}

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
			windowStrategy: raw.windowStrategy === "served" || raw.windowStrategy === "floor" ? raw.windowStrategy : DEFAULT_CONFIG.windowStrategy,
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

/** Router profile chains from `subscription-router.json`, cached by file mtime. */
export const ROUTER_CONFIG_PATH = join(AGENT_DIR, "subscription-router.json");

export function readRouterProfiles(path = ROUTER_CONFIG_PATH): Record<string, string[]> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as { profiles?: Record<string, { chain?: unknown }> };
		const out: Record<string, string[]> = {};
		for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
			const chain = profile?.chain;
			if (!Array.isArray(chain)) continue;
			out[name] = chain
				.map((rung) => (typeof rung === "string" ? rung : typeof rung?.model === "string" ? rung.model : undefined))
				.filter((rung): rung is string => typeof rung === "string");
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * The window the rule applies to.
 *
 * `served` uses the window of the model that answered last — the only window pi reports, and for a
 * `router/*` selection it is the physical rung that actually served the turn, not the router's
 * intent. Its flaw is timing: a fallback from a 1M model to a 500k model is only visible *after*
 * that rung has answered, so the compaction it justifies happens a turn later and the turn itself
 * pays a cache miss on the switch.
 *
 * `floor` uses the smallest window among every model this session can be routed to, read from the
 * router profile's chain. The threshold is then low enough that no rung can be over budget when a
 * turn starts, so a fallback never triggers a post-switch compaction.
 *
 * Resolution order: the router chain of the session's virtual model, then the served window as a
 * candidate (never larger than the floor's guarantee), then the served window alone.
 */
export interface WindowResolution {
	window: number | undefined;
	/** Which rule produced it. */
	source: "floor" | "served" | "none";
	/** Every model considered, for the status command. */
	rungs: { key: string; window: number | undefined }[];
}

export function resolveWindow(input: {
	strategy: "floor" | "served";
	usage?: { contextWindow?: number };
	model?: { provider?: string; id?: string; contextWindow?: number };
	profiles: Record<string, string[]>;
	lookup?: (provider: string, id: string) => { contextWindow?: number } | undefined;
}): WindowResolution {
	const { strategy, usage, model, profiles, lookup } = input;
	const served = usage?.contextWindow ?? (typeof model?.contextWindow === "number" ? model.contextWindow : undefined);
	const servedKnown = typeof served === "number" && served > 0 ? served : undefined;
	if (strategy === "served") {
		return { window: servedKnown, source: servedKnown === undefined ? "none" : "served", rungs: [] };
	}
	const profile = model?.provider === "router" && typeof model.id === "string" ? profiles[model.id] : undefined;
	const rungs = (profile ?? []).flatMap((key) => {
		const parts = splitModelKey(key);
		const found = parts && lookup ? lookup(parts.provider, parts.id) : undefined;
		const window = typeof found?.contextWindow === "number" && found.contextWindow > 0 ? found.contextWindow : undefined;
		return [{ key, window }];
	});
	const window = floorWindow([...rungs.map((rung) => rung.window), servedKnown]);
	if (window === undefined) return { window: undefined, source: "none", rungs };
	return { window, source: "floor", rungs };
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
	/** Router profiles, re-read only when the file changes. */
	let profilesCache: { mtime: number; profiles: Record<string, string[]> } | undefined;
	const profiles = (): Record<string, string[]> => {
		try {
			const mtime = statSync(ROUTER_CONFIG_PATH).mtimeMs;
			if (profilesCache?.mtime === mtime) return profilesCache.profiles;
			const read = readRouterProfiles();
			profilesCache = { mtime, profiles: read };
			return read;
		} catch {
			return profilesCache?.profiles ?? {};
		}
	};

	const windowFor = (ctx: ExtensionContext, usage: { contextWindow?: number } | undefined) =>
		resolveWindow({
			strategy: config.windowStrategy,
			usage,
			model: ctx.model,
			profiles: profiles(),
			lookup: (provider, id) => ctx.modelRegistry?.find(provider, id),
		});

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
		const { window } = windowFor(ctx, usage);
		const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
		current = tokens === undefined || window === undefined ? undefined : { tokens, window };
		paintStatus(ctx);
		const decision = decide({
			config,
			tokens,
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
		const resolved = windowFor(ctx, usage);
		const window = resolved.window;
		const threshold = thresholdTokens(config.percent, window);
		const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
		const rungLine = resolved.rungs.length === 0
			? undefined
			: `candidates ${resolved.rungs.map((rung) => `${rung.key.split("/").slice(1).join("/")} ${rung.window === undefined ? "?" : fmt(rung.window)}`).join(", ")}`;
		const lines = [
			`compaction-percent ${config.enabled ? "on" : "off"} · ${config.percent}% · ${config.windowStrategy} window${config.dryRun ? " · dry-run" : ""}`,
			`model ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "—"} · window ${window === undefined ? "—" : window.toLocaleString()}${resolved.source === "floor" ? " (floor)" : ""}`,
			...(rungLine ? [rungLine] : []),
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
		if (arg === "floor" || arg === "served") {
			config = { ...config, windowStrategy: arg };
			saveConfig(config);
			paintStatus(ctx);
			ctx.ui.notify(`compaction window: ${arg}`, "info");
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
			ctx.ui.notify("usage: /compaction-percent [status|on|off|floor|served|dry-run|line|<5-95>]", "error");
			return;
		}
		config = { ...config, percent };
		saveConfig(config);
		paintStatus(ctx);
		ctx.ui.notify(`compaction now at ${percent}% of the window`, "info");
	};

	pi.registerCommand("compaction-percent", {
		description: "Compact at a percentage of the window: /compaction-percent [status|on|off|floor|served|line|dry-run|5-95]",
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
		const { window } = windowFor(ctx, usage);
		const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
		current = tokens === undefined || window === undefined ? undefined : { tokens, window };
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
