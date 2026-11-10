/**
 * pi-compaction-percent
 *
 * pi triggers automatic compaction on a fixed token reserve, so one number means a different
 * fraction of every model. This extension owns the trigger instead, as percentages of the window of
 * the model that will serve the NEXT request, and does the work at the boundaries where compacting
 * is cheapest:
 *
 *   soft   (`percent`, 40)        at run end, and before a switch to another model
 *   hard   (`forcedPercent`, 60)  at turn end, mid tool loop, so a long task cannot reach the window
 *
 * Both boundaries run *after* a request. Three situations reach a request with no boundary in between:
 * resuming a session above the line, and a run the user aborted (an aborted run skips
 * `agent_before_settle`). Those compact before the first request instead, while nothing is running,
 * so a restart does not pay a cold start on the whole old context just to compact it a turn later.
 *
 * On a switch to another model the soft line is lowered by `marginPercent` (5): when the context is
 * already within a few points of the incoming model's line it is cheaper to compact now than to pay
 * the cold start and then compact a few turns later.
 *
 * Mechanism. Compaction is written as a boundary DRAFT (`agent_before_settle` / `turn_end`
 * returning `{ entries: [{ type: "compaction", ... }] }`), never `ctx.compact()`, which aborts the
 * run and would discard the router's pending continuation. The summary is written by
 * The first entry of `compactionModels` that answers, not whichever expensive model served the turn.
 * The list is ordinary config; `"current"` stands for the model the session is already using, so a
 * list ending in `"current"` always has a working summariser, and an empty list means "pi native".
 * Pi-initiated compactions (`/compact`, overflow recovery) use the same summariser through
 * `session_before_compact`; if that model is unavailable pi summarises as it always did.
 *
 * The next model comes from the `router:next` entry published by pi-subscription-router. Without
 * it the window of the current model applies and the rules are identical, minus the switch rule.
 *
 * Run pi with `compaction.enabled: false` so pi's token trigger stays out of the way. Overflow
 * recovery is unaffected: pi consults that flag only in shouldCompact().
 *
 * Config: `$PI_CODING_AGENT_DIR/compaction-percent.json`. Commands: /compact-pct, /compaction-percent.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { compact, estimateTokens, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "compaction-percent.json");

/** Session entry published by pi-subscription-router: the model the next request will use. */
export const NEXT_ENTRY = "router:next";
/** Live accessor the router registers on globalThis: `(ctx) => "provider/id" | undefined`. */
export const PEEK_NEXT = Symbol.for("pi-subscription-router:peek-next");

/** Ask the router for the next model right now; no dependency on handler order. */
function peekNext(ctx: ExtensionContext): string | undefined {
	const peek = (globalThis as Record<symbol, unknown>)[PEEK_NEXT];
	if (typeof peek !== "function") return undefined;
	try {
		const key = (peek as (c: ExtensionContext) => unknown)(ctx);
		return typeof key === "string" ? key : undefined;
	} catch {
		return undefined;
	}
}

export interface CompactionPercentConfig {
	enabled: boolean;
	/** Soft line: compact at run end / before a switch once context passes this % of the window. */
	percent: number;
	/** Hard line: compact between turns of a tool loop once context passes this % of the window. */
	forcedPercent: number;
	/** On a switch, the soft line drops by this many points. */
	marginPercent: number;
	/**
	 * Summarisers, tried in order. Each entry is a `provider/id` (a router virtual model is fine) or
	 * `"current"` for the model this session is already using. Empty: pi summarises itself.
	 */
	compactionModels: string[];
	/** Decide and log, never compact. */
	dryRun: boolean;
}

export const DEFAULT_CONFIG: CompactionPercentConfig = {
	enabled: true,
	percent: 40,
	forcedPercent: 60,
	marginPercent: 5,
	compactionModels: ["current"],
	dryRun: false,
};

export function clampPercent(value: unknown, min = 5, max = 95): number | undefined {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
	const rounded = Math.round(n);
	return rounded < min || rounded > max ? undefined : rounded;
}

/** Accept `compactionModels: [...]`, and the single `compactionModel` of 2.0 as a one-item list. */
export function readModels(raw: Record<string, unknown>): string[] {
	const list = Array.isArray(raw.compactionModels)
		? raw.compactionModels
		: typeof raw.compactionModel === "string"
			? [raw.compactionModel]
			: undefined;
	if (list === undefined) return [...DEFAULT_CONFIG.compactionModels];
	const seen = new Set<string>();
	return list
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "" && !seen.has(entry) && seen.add(entry) !== undefined);
}

/**
 * The ordered keys to try, with `"current"` expanded to the model that would serve the next request.
 * `current` is dropped when it is already listed, and a list that is only `["current"]` with no known
 * current model yields nothing — the caller then leaves the compaction to pi.
 */
export function summariserKeys(models: readonly string[], currentKey: string | undefined): string[] {
	const out: string[] = [];
	for (const entry of models) {
		const key = entry === "current" ? currentKey : entry;
		if (!key || out.includes(key)) continue;
		out.push(key);
	}
	return out;
}

/** Keep the hard line at or above the soft line, whatever the file says. */
export function normalize(config: CompactionPercentConfig): CompactionPercentConfig {
	return config.forcedPercent < config.percent ? { ...config, forcedPercent: config.percent } : config;
}

export function loadConfig(path = CONFIG_PATH): CompactionPercentConfig {
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		return normalize({
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			percent: clampPercent(raw.percent) ?? DEFAULT_CONFIG.percent,
			forcedPercent: clampPercent(raw.forcedPercent) ?? DEFAULT_CONFIG.forcedPercent,
			marginPercent: clampPercent(raw.marginPercent, 0, 20) ?? DEFAULT_CONFIG.marginPercent,
			compactionModels: readModels(raw),
			dryRun: typeof raw.dryRun === "boolean" ? raw.dryRun : DEFAULT_CONFIG.dryRun,
		});
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: CompactionPercentConfig, path = CONFIG_PATH): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
	renameSync(tmp, path);
}

/** Parse `provider/modelId`, splitting at the first slash: ids may contain more. */
export function splitModelKey(key: string): { provider: string; id: string } | undefined {
	const i = key.indexOf("/");
	return i <= 0 || i === key.length - 1 ? undefined : { provider: key.slice(0, i), id: key.slice(i + 1) };
}

// ---------------------------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------------------------

export type Boundary = "settle" | "turn";

export interface Lines {
	soft: number;
	hard: number;
}

/** Token lines for a window. A switch lowers the soft line by the margin. */
export function lines(config: CompactionPercentConfig, window: number, switching: boolean): Lines {
	const soft = Math.max(0, config.percent - (switching ? config.marginPercent : 0));
	return { soft: Math.floor((window * soft) / 100), hard: Math.floor((window * config.forcedPercent) / 100) };
}

export type Decision =
	| { compact: true; tier: "soft" | "hard" | "cold"; tokens: number; line: number; window: number }
	| { compact: false; reason: string };

/**
 * Pure rule.
 *   settle: the run is ending, nothing is in flight -> soft line (lowered on a switch).
 *   turn:   a tool loop continues -> a pending switch uses the lowered soft line, otherwise the
 *           hard line. A turn with no tool results defers to settle.
 *
 * A cold cache is its own trigger: whatever happens next is a full write of the whole prefix, so
 * compacting first — one summary plus a small write — is cheaper as soon as the context is near the
 * soft line. `cacheCold` is measured against the provider's TTL, and the band is `marginPercent`
 * below the soft line.
 */
export function decide(input: {
	config: CompactionPercentConfig;
	boundary: Boundary;
	tokens: number | undefined;
	window: number | undefined;
	switching: boolean;
	/** `turn` only: the turn issued tool calls, so another request follows. */
	loopContinues?: boolean;
	/** The cached prefix has expired: the next request is a full write either way. */
	cacheCold?: boolean;
	now: number;
	backoffUntil?: number;
	skipBelow?: number;
}): Decision {
	const { config, boundary, tokens, window, switching, loopContinues, cacheCold, now, backoffUntil, skipBelow } = input;
	if (!config.enabled) return { compact: false, reason: "disabled" };
	if (tokens === undefined) return { compact: false, reason: "no-usage" };
	if (window === undefined || window <= 0) return { compact: false, reason: "no-window" };
	if (backoffUntil !== undefined && now < backoffUntil) return { compact: false, reason: "backoff" };
	if (skipBelow !== undefined && tokens < skipBelow) return { compact: false, reason: "nothing-to-compact" };
	const l = lines(config, window, switching);
	// Cold cache: pay a summary now instead of writing the whole context on the next request. Only
	// when a request is actually next — a settle, or a turn that still has a tool loop to run.
	if (cacheCold === true && (boundary === "settle" || loopContinues === true)) {
		const coldLine = Math.max(0, l.soft - Math.floor((window * config.marginPercent) / 100));
		if (tokens >= coldLine) return { compact: true, tier: "cold", tokens, line: coldLine, window };
	}
	if (boundary === "settle") {
		return tokens >= l.soft ? { compact: true, tier: "soft", tokens, line: l.soft, window } : { compact: false, reason: "below" };
	}
	if (!loopContinues) return { compact: false, reason: "deferred-to-settle" };
	if (switching && tokens >= l.soft) return { compact: true, tier: "soft", tokens, line: l.soft, window };
	if (tokens >= l.hard) return { compact: true, tier: "hard", tokens, line: l.hard, window };
	return { compact: false, reason: "below" };
}

/**
 * After a compaction, judge whether it helped. When the context is still above 80% of what it was,
 * the kept tail (or the next tool results) refilled it, so compacting again right away would only
 * pay another summary: hold until it has grown by a tenth of the window.
 */
export function floorAfter(before: number, after: number, window: number): number | undefined {
	return after > before * 0.8 ? Math.ceil(after + window * 0.1) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Session reading
// ---------------------------------------------------------------------------------------------

interface Next {
	model: string;
	source: string;
}

/** `provider/id` of the newest assistant response, and the index it sits at. */
export function lastResponse(entries: readonly SessionEntry[]): { key: string; index: number } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as unknown as { type?: string; message?: { role?: string; provider?: string; model?: string } };
		const m = entry.message;
		if (entry.type === "message" && m?.role === "assistant" && typeof m.provider === "string" && typeof m.model === "string") {
			return { key: `${m.provider}/${m.model}`, index: i };
		}
	}
	return undefined;
}

/** The router's published next model, if it was published after the latest response. */
export function nextModel(entries: readonly SessionEntry[]): Next | undefined {
	const last = lastResponse(entries);
	for (let i = entries.length - 1; i >= 0; i--) {
		if (last && i < last.index) return undefined; // older than the latest response: stale
		const entry = entries[i] as unknown as { type?: string; customType?: string; data?: { model?: unknown; source?: unknown } };
		if (entry.type === "custom" && entry.customType === NEXT_ENTRY && typeof entry.data?.model === "string") {
			return { model: entry.data.model, source: typeof entry.data.source === "string" ? entry.data.source : "?" };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Cut and summary
// ---------------------------------------------------------------------------------------------

type AgentMessage = ProjectedSessionEntry["messages"][number];

const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

export interface Cut {
	/** Index into the projection of the first entry kept. */
	index: number;
	firstKeptEntryId: string;
	/** Messages that the summary replaces. */
	messages: AgentMessage[];
	previousSummary?: string;
}

/**
 * Choose what to summarise, on the PROJECTION (what the model actually sees), the way pi's own
 * preparation does: after context edits, after the previous compaction, never between a tool call
 * and its result, keeping roughly `keepRecentTokens` of the newest messages.
 */
export function chooseCut(entries: readonly ProjectedSessionEntry[], keepRecentTokens: number): Cut | undefined {
	let start = 0;
	let previousSummary: string | undefined;
	const prev = entries.findIndex((e) => e.sourceEntry.type === "compaction" && e.messages.length > 0);
	if (prev >= 0) {
		previousSummary = (entries[prev].sourceEntry as unknown as { summary?: string }).summary;
		start = prev + 1;
	}
	const end = entries.length;
	const points: number[] = [];
	for (let i = start; i < end; i++) {
		const e = entries[i];
		if (e.sourceEntry.type !== "compaction" && e.messages.some((m) => CUT_ROLES.has(m.role))) points.push(i);
	}
	if (points.length === 0) return undefined;
	let acc = 0;
	let cut: number | undefined;
	for (let i = end - 1; i >= start; i--) {
		const tokens = entries[i].messages.reduce((sum, m) => sum + estimateTokens(m), 0);
		if (tokens === 0) continue;
		acc += tokens;
		if (acc >= keepRecentTokens) {
			cut = points.find((p) => p >= i) ?? points[points.length - 1];
			break;
		}
	}
	if (cut === undefined) return undefined; // everything fits in the kept window: nothing to summarise
	while (cut > start) {
		const before = entries[cut - 1];
		if (before.sourceEntry.type === "compaction" || before.messages.length > 0) break;
		cut--;
	}
	const messages = entries
		.slice(start, cut)
		.flatMap((e) => (e.sourceEntry.type === "compaction" ? [] : e.messages.filter((m) => m.role !== "system")));
	const id = entries[cut]?.sourceEntry.id;
	if (messages.length === 0 || !id) return undefined;
	return { index: cut, firstKeptEntryId: id, messages, ...(previousSummary ? { previousSummary } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------------------------

/** Set PI_COMPACTION_PERCENT_LOG=/path to record every boundary decision. */
const LOG_PATH = process.env.PI_COMPACTION_PERCENT_LOG;
const log = (message: string) => {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
	} catch {}
};

const FAILURE_BACKOFF_MS = 60_000;
/** An upfront compaction holds the first message; give up rather than hang if a summariser stalls. */
const COMPACT_UPFRONT_TIMEOUT_MS = 180_000;
const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

export default function compactionPercent(pi: ExtensionAPI): void {
	let config = loadConfig();
	let inFlight = false;
	let backoffUntil: number | undefined;
	let skipBelow: number | undefined;
	/** Tokens before the last compaction, judged once the next usage figure exists. */
	let judge: number | undefined;
	let warnedNoNext = false;
	let warnedNoModel = false;
	let warnedFailure = false;

	/** Window and switch state for the next request. */
	const resolve = (ctx: ExtensionContext) => {
		const entries = ctx.sessionManager.getEntries() as SessionEntry[];
		const usage = ctx.getContextUsage();
		const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
		const live = peekNext(ctx);
		const next = live !== undefined ? { model: live, source: "live" } : nextModel(entries);
		let window: number | undefined = usage?.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : undefined;
		let switching = false;
		if (next) {
			const parts = splitModelKey(next.model);
			const found = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
			if (found?.contextWindow && found.contextWindow > 0) window = found.contextWindow;
			const last = lastResponse(entries);
			switching = last !== undefined && last.key !== next.model;
		} else if (ctx.model?.provider === "router" && !warnedNoNext && entries.some((e) => (e as { type?: string }).type === "message")) {
			warnedNoNext = true;
			ctx.ui.notify(
				`compaction-percent: ${ctx.model.id} is a router model but no "${NEXT_ENTRY}" entry was published. ` +
					"Install git:github.com/excessivechaos/pi-subscription-router; until then the current model's window is used.",
				"warning",
			);
		}
		return { tokens, window, switching, next };
	};

	/**
	 * Whether the provider's cache entry for this session has expired, in which case the next request
	 * writes the whole prefix whatever we do. Measured from the last assistant message: only provider
	 * requests refresh a cache entry, so a tool that ran for an hour does not count as activity.
	 */
	const cacheState = (ctx: ExtensionContext, nextKey: string | undefined): { cold: boolean; ageMs?: number; ttlMs: number } => {
		const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
		const parts = nextKey === undefined ? undefined : splitModelKey(nextKey);
		const model = (parts !== undefined ? ctx.modelRegistry.find(parts.provider, parts.id) : ctx.model) as
			| { promptCache?: { short?: number; long?: number } }
			| undefined;
		const ttlMs = (model?.promptCache?.[retention] ?? (retention === "long" ? 3600 : 300)) * 1000;
		const entries = ctx.sessionManager.getEntries() as SessionEntry[];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as unknown as { type?: string; timestamp?: string; message?: { role?: string } };
			if (entry.type !== "message" || entry.message?.role !== "assistant" || typeof entry.timestamp !== "string") continue;
			const at = Date.parse(entry.timestamp);
			if (!Number.isFinite(at)) continue;
			const ageMs = Date.now() - at;
			return { cold: ageMs > ttlMs, ageMs, ttlMs };
		}
		return { cold: false, ttlMs };
	};

	/** The summarisers to try, in order, resolved against the registry. `"current"` is the next model. */
	const summaryModels = (ctx: ExtensionContext) => {
		const r = resolve(ctx);
		const currentKey = r.next?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const keys = summariserKeys(config.compactionModels, currentKey);
		const resolved: { key: string; model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>> }[] = [];
		for (const key of keys) {
			const parts = splitModelKey(key);
			const model = parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
			if (model) resolved.push({ key, model });
		}
		if (resolved.length === 0 && keys.length > 0 && !warnedNoModel) {
			warnedNoModel = true;
			ctx.ui.notify(
				`compaction-percent: none of ${keys.join(", ")} is available; pi summarises with its own model`,
				"warning",
			);
		}
		return resolved;
	};

	/**
	 * Try the configured summarisers in order. The first one that returns a summary wins; a failure
	 * moves to the next, so a dead provider or an exhausted window does not cost the compaction. When
	 * every entry fails the boundary writes nothing (pi's overflow recovery still covers the wall) and
	 * the pi-initiated path falls back to pi's own summariser.
	 */
	const summarise = async (
		ctx: ExtensionContext,
		messages: Parameters<typeof generateSummaryWithUsage>[0],
		previousSummary: string | undefined,
	): Promise<{ key: string; text: string; usage: Awaited<ReturnType<typeof generateSummaryWithUsage>>["usage"] } | undefined> => {
		const candidates = summaryModels(ctx);
		if (candidates.length === 0) return undefined;
		const failures: string[] = [];
		for (const { key, model } of candidates) {
			try {
				const result = await generateSummaryWithUsage(
					messages,
					model,
					undefined,
					undefined,
					undefined,
					ctx.signal,
					undefined,
					previousSummary,
					"off",
					ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry) as never,
				);
				if (!result.text.trim()) throw new Error("empty summary");
				if (failures.length > 0) log(`  summariser ${key} worked after: ${failures.join("; ")}`);
				return { key, text: result.text, usage: result.usage };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${key}: ${message}`);
				log(`  summariser ${key} failed: ${message}`);
			}
		}
		log(`  every summariser failed (${failures.join("; ")})`);
		return undefined;
	};

	/** Build the draft for one boundary, or explain why there is nothing to write. */
	const draftFor = async (ctx: ExtensionContext, decision: Extract<Decision, { compact: true }>, switching: boolean, nextKey: string | undefined) => {
		const candidates = summaryModels(ctx);
		if (candidates.length === 0) {
			log(`  no summariser available (${config.compactionModels.join(" -> ") || "empty list"}); nothing written`);
			return undefined;
		}
		const keep = (await readKeepRecent()) ?? 20_000;
		const cut = chooseCut(ctx.sessionManager.buildSessionProjection().entries, keep);
		if (!cut) {
			log("  nothing before the kept tail to summarise");
			skipBelow = Math.ceil(decision.tokens * 1.2);
			return undefined;
		}
		const started = Date.now();
		const result = await summarise(ctx, cut.messages, cut.previousSummary);
		if (!result) throw new Error(`no summariser answered (${config.compactionModels.join(", ")})`);
		ctx.ui.notify(
			`compaction-percent: ${decision.tier} compaction at ${fmt(decision.tokens)} of ${fmt(decision.window)} (${Math.round((decision.line / decision.window) * 100)}%)` +
				`${switching && nextKey ? `, before switching to ${nextKey}` : ""} · summary by ${result.key} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
			"info",
		);
		return {
			type: "compaction" as const,
			summary: result.text,
			firstKeptEntryId: cut.firstKeptEntryId,
			usage: result.usage,
		};
	};

	/** `keepRecentTokens` from pi's settings, so the kept tail matches what pi would keep. */
	let keepRecentCache: number | undefined;
	const readKeepRecent = async (): Promise<number | undefined> => {
		if (keepRecentCache !== undefined) return keepRecentCache;
		try {
			const path = join(AGENT_DIR, "settings.json");
			const raw = JSON.parse(readFileSync(path, "utf-8")) as { compaction?: { keepRecentTokens?: number } };
			const v = raw.compaction?.keepRecentTokens;
			keepRecentCache = typeof v === "number" && v >= 0 ? v : undefined;
		} catch {}
		return keepRecentCache;
	};

	const atBoundary = async (
		boundary: Boundary,
		event: { entries: unknown[]; toolResults?: unknown[]; outcome?: string },
		ctx: ExtensionContext,
	) => {
		const r = resolve(ctx);
		if (judge !== undefined && r.tokens !== undefined && r.window !== undefined) {
			const floor = floorAfter(judge, r.tokens, r.window);
			if (floor !== undefined) {
				skipBelow = floor;
				log(`  last compaction did not shrink the context (${judge} -> ${r.tokens}); holding until ${floor}`);
			}
			judge = undefined;
		}
		if (inFlight) return undefined;
		const cache = cacheState(ctx, r.next?.model);
		const decision = decide({
			config,
			boundary,
			tokens: r.tokens,
			window: r.window,
			switching: r.switching,
			loopContinues: boundary === "turn" ? (event.toolResults?.length ?? 0) > 0 && event.outcome === "completed" : undefined,
			cacheCold: cache.cold,
			now: Date.now(),
			backoffUntil,
			skipBelow,
		});
		log(
			`${boundary} tokens=${r.tokens} window=${r.window} next=${r.next?.model ?? "-"} switching=${r.switching} cold=${cache.cold}${cache.ageMs === undefined ? "" : ` age=${Math.round(cache.ageMs / 60_000)}m/${Math.round(cache.ttlMs / 60_000)}m`} -> ${decision.compact ? `${decision.tier} (line ${decision.line})` : decision.reason}`,
		);
		if (!decision.compact) return undefined;
		if (config.dryRun) {
			ctx.ui.notify(`compaction-percent: would ${decision.tier}-compact at ${fmt(decision.tokens)} (line ${fmt(decision.line)} of ${fmt(decision.window)})`, "info");
			return undefined;
		}
		inFlight = true;
		try {
			const draft = await draftFor(ctx, decision, r.switching, r.next?.model);
			if (!draft) {
				log("  no draft written");
				return undefined;
			}
			log(`  draft written, firstKept=${draft.firstKeptEntryId} summaryChars=${draft.summary.length}`);
			skipBelow = undefined;
			judge = decision.tokens;
			warnedFailure = false;
			return { entries: [...(event.entries as never[]), draft] };
		} catch (error) {
			log(`  summary failed: ${error instanceof Error ? error.message : String(error)}`);
			backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
			if (!warnedFailure) {
				warnedFailure = true;
				ctx.ui.notify(`compaction-percent: summary failed (${error instanceof Error ? error.message : String(error)}); retrying in 60s`, "error");
			}
			return undefined;
		} finally {
			inFlight = false;
		}
	};

	/**
	 * Compact before the first request when no boundary can run first: a resumed session (the run that
	 * should have ended never did) and a run the user aborted (an aborted run skips
	 * `agent_before_settle`). Both otherwise reach the next request over the line and pay a cold start
	 * on the whole old context, which is exactly what the soft line exists to avoid.
	 *
	 * `ctx.compact()` is safe at these two points because nothing is in flight: it aborts nothing, and
	 * its `session_before_compact` path summarises with the same list as the boundary drafts.
	 */
	const compactUpFront = async (why: string, ctx: ExtensionContext): Promise<void> => {
		if (!config.enabled || inFlight) return;
		const r = resolve(ctx);
		const cache = cacheState(ctx, r.next?.model);
		const decision = decide({
			config,
			boundary: "settle",
			tokens: r.tokens,
			window: r.window,
			switching: r.switching,
			cacheCold: cache.cold,
			now: Date.now(),
			backoffUntil,
			skipBelow,
		});
		log(`upfront(${why}) tokens=${r.tokens} window=${r.window} switching=${r.switching} cold=${cache.cold}${cache.ageMs === undefined ? "" : ` age=${Math.round(cache.ageMs / 60_000)}m`} -> ${decision.compact ? `${decision.tier} (line ${decision.line})` : decision.reason}`);
		if (!decision.compact) return;
		if (config.dryRun) {
			ctx.ui.notify(
				`compaction-percent: would compact before the first request at ${fmt(decision.tokens)} (line ${fmt(decision.line)} of ${fmt(decision.window)})`,
				"info",
			);
			return;
		}
		inFlight = true;
		const started = Date.now();
		try {
			const finished = await new Promise<boolean>((done) => {
				ctx.compact({ onComplete: () => done(true), onError: () => done(false) });
				// A summariser that never answers must not hold the first message forever.
				setTimeout(() => done(false), COMPACT_UPFRONT_TIMEOUT_MS).unref?.();
			});
			if (finished) {
				judge = decision.tokens;
				skipBelow = undefined;
				warnedFailure = false;
			}
			ctx.ui.notify(
				`compaction-percent: ${finished ? "compacted" : "could not compact"} before the first request at ${fmt(decision.tokens)} (line ${fmt(decision.line)} of ${fmt(decision.window)}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
				finished ? "info" : "warning",
			);
		} finally {
			inFlight = false;
		}
	};

	// Soft boundary: the run is ending and nothing is in flight; the router's pending continuation, if
	// any, sees the compacted context because the boundary rebuilds it after every handler.
	pi.on("agent_before_settle", (event, ctx) => atBoundary("settle", event as never, ctx) as never);
	// Hard boundary: between the turns of a tool loop.
	pi.on("turn_end", (event, ctx) => atBoundary("turn", event as never, ctx) as never);
	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		keepRecentCache = undefined;
		warnedNoNext = warnedNoModel = warnedFailure = false;
		skipBelow = backoffUntil = undefined;
		// Resuming is the one start with no boundary before the first request: compact now, at the
		// small context, instead of after a cold start on the old one.
		await compactUpFront("resume", ctx);
	});
	// An aborted run skips `agent_before_settle`, so it too reaches the next message over the line.
	// Nothing is running by the time `agent_settled` fires, so this cannot abort the user's work.
	pi.on("agent_settled", async (event, ctx) => {
		if (!event.aborted) return;
		await compactUpFront("aborted-run", ctx);
	});
	pi.on("session_compact", () => {
		skipBelow = undefined;
		judge = undefined;
	});

	// Pi-initiated compactions (/compact, threshold, overflow) get the same summariser.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!config.enabled || config.dryRun) return undefined;
		const failures: string[] = [];
		for (const { key, model } of summaryModels(ctx)) {
			try {
				const result = await compact(
					event.preparation,
					model,
					undefined,
					undefined,
					event.customInstructions,
					event.signal,
					"off",
					ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry) as never,
				);
				if (failures.length > 0) log(`  pi-initiated summary by ${key} after: ${failures.join("; ")}`);
				return { compaction: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${key}: ${message}`);
				log(`  pi-initiated summariser ${key} failed: ${message}`);
			}
		}
		if (failures.length > 0) {
			ctx.ui.notify(`compaction-percent: no summariser answered (${failures.join("; ")}); pi summarises instead`, "warning");
		}
		return undefined;
	});

	// ---- commands ----------------------------------------------------------------------------
	const statusText = (ctx: ExtensionContext) => {
		const r = resolve(ctx);
		const l = r.window === undefined ? undefined : lines(config, r.window, r.switching);
		return [
			`compaction-percent ${config.enabled ? "on" : "off"} · soft ${config.percent}% · hard ${config.forcedPercent}% · switch margin ${config.marginPercent}%${config.dryRun ? " · dry-run" : ""}`,
			`next model ${r.next ? `${r.next.model} (${r.next.source})` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "—"}${r.switching ? " · SWITCHING" : ""} · window ${r.window === undefined ? "—" : r.window.toLocaleString()}`,
			`context ${r.tokens === undefined ? "—" : r.tokens.toLocaleString()}${l ? ` · soft line ${l.soft.toLocaleString()} · hard line ${l.hard.toLocaleString()}` : ""}`,
			`summaries by ${config.compactionModels.join(" -> ") || "(pi native)"} · ${CONFIG_PATH}`,
		].join("\n");
	};

	const command = async (args: string, ctx: ExtensionContext) => {
		const [verb = "", ...rest] = args.trim().split(/\s+/);
		const value = rest.join(" ");
		const save = (next: CompactionPercentConfig, message: string) => {
			config = normalize(next);
			saveConfig(config);
			ctx.ui.notify(message, "info");
		};
		if (verb === "" || verb === "status") return ctx.ui.notify(statusText(ctx), "info");
		if (verb === "on" || verb === "off") return save({ ...config, enabled: verb === "on" }, `compaction-percent ${verb}`);
		if (verb === "dry-run") return save({ ...config, dryRun: !config.dryRun }, `dry-run ${!config.dryRun ? "on" : "off"}`);
		if (verb === "model" || verb === "models") {
			if (!value) return ctx.ui.notify(statusText(ctx), "info");
			if (value.trim() === "none" || value.trim() === "pi") return save({ ...config, compactionModels: [] }, "summaries: pi native only");
			const models = readModels({ compactionModels: value.split(",").map((v) => v.trim()).filter(Boolean) });
			return save({ ...config, compactionModels: models }, `summaries by ${models.join(" -> ")}`);
		}
		if (verb === "forced" || verb === "hard") {
			const p = clampPercent(value);
			return p === undefined ? ctx.ui.notify("hard line: a percentage from 5 to 95", "error") : save({ ...config, forcedPercent: p }, `hard line ${p}%`);
		}
		if (verb === "margin") {
			const p = clampPercent(value, 0, 20);
			return p === undefined ? ctx.ui.notify("margin: 0 to 20", "error") : save({ ...config, marginPercent: p }, `switch margin ${p}%`);
		}
		const p = clampPercent(verb === "soft" ? value : verb);
		if (p === undefined) return ctx.ui.notify("usage: /compact-pct [status|<5-95>|forced <n>|margin <n>|model <a,b,current|none>|on|off|dry-run]", "error");
		return save({ ...config, percent: p }, `soft line ${p}%`);
	};
	pi.registerCommand("compaction-percent", { description: "Compaction thresholds: /compaction-percent [status|<soft%>|forced <n>|margin <n>|model <key>|on|off|line|dry-run]", handler: command });
	pi.registerCommand("compact-pct", { description: "Alias for /compaction-percent", handler: command });
}
