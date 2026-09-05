/**
 * cache-compact: KV-cache-friendly compaction for pi.
 *
 * Default /compact rebuilds the whole history as a SERIALIZED TEXT in a fresh
 * one-shot request (new session id, cache disabled) → the provider recomputes
 * the entire context from scratch (minutes of prefill on local models), then
 * the next turn re-caches the compacted context anyway.
 *
 * This extension intercepts `session_before_compact` (manual /compact, the
 * auto-threshold, and overflow are all covered) and REPLAYS the wire body of
 * the last live agent request — byte-identical system + tools + messages,
 * exactly what is already in the provider's prefix cache (Anthropic
 * cache-control breakpoints / llama.cpp slot LCP reuse) — with ONE summary
 * instruction appended at the END:
 *
 *   cached:  [system][tools][ctx…]                    ← full cache hit
 *   replay:  [system][tools][ctx…][⊕ instruction]     ← only the tail is new
 *   after:   [system][summary][kept tail]             ← one small re-cache
 *             (unavoidable in ANY compaction design)
 *
 * Benefits: the summarization call costs ~the instruction + summary
 * generation (no full-context re-prefill), and the model sees the REAL
 * messages with full tool results (the default truncates them to 2000 chars).
 *
 * Safety: any anomaly (overflow, model switch, no capture, HTTP error,
 * empty/length-capped summary, abort) → return → pi's default compaction.
 * Display-only otherwise; never touches the session except the standard
 * CompactionEntry pi writes from the returned summary.
 *
 * Commands:
 *   /cache-compact             — status (mode, capture, last replay stats)
 *   /cache-compact auto|on|off — mode: auto (default: enabled at session start
 *                                and after /reload, banner shown then) / on /
 *                                off (until next /reload)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUMMARY_MAX_TOKENS = 8192; // output budget for the generated summary
const INSTRUCTION_SLACK = 4096; // ~instruction text + headroom for the size guard

/** pi's Usage is not re-exported from the package index — structural copy. */
interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface CapturedWire {
	body: unknown; // JSON round-tripped provider request body (byte-identity with what was sent)
	modelId: string;
	at: number;
}

interface ReplayStats {
	cached: number;
	fresh: number;
	hitPct: number;
	ms: number;
}

export default function cacheCompact(pi: ExtensionAPI): void {
	let mode: "auto" | "on" | "off" = "auto"; // "auto": enabled at session start / after /reload
	let lastWire: CapturedWire | null = null;
	let lastHeaders: Record<string, string> = {};
	let lastReplay: ReplayStats | null = null;

	// Wire body arrives from the provider adapter; clone via JSON so the
	// replay is byte-identical to what was actually sent on the wire.
	const safeClone = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

	// ------------------------------------------------ capture main requests

	pi.on("before_provider_request", (event) => {
		const p = event.payload as Record<string, unknown> | undefined;
		if (!p || typeof p !== "object") return;
		const messages = p.messages;
		// Only full conversations (never one-shot calls); chat or anthropic shape.
		if (!Array.isArray(messages) || messages.length < 2) return;
		const isChat = (messages[0] as { role?: string })?.role !== undefined;
		const isAnthropic = p.system !== undefined;
		if (!isChat && !isAnthropic) return;
		const modelId = typeof p.model === "string" ? p.model : "";
		if (!modelId) return;
		lastWire = { body: safeClone(p), modelId, at: Date.now() };
	});

	pi.on("before_provider_headers", (event) => {
		lastHeaders = { ...event.headers };
	});

	// ------------------------------------------------ summary instruction

	const buildInstruction = (
		previousSummary: string | undefined,
		fileOps: { readFiles?: string[]; modifiedFiles?: string[] } | undefined,
		customInstructions?: string,
	): string => {
		const parts: string[] = [];
		parts.push(
			"You are a context compactor. The conversation above is being compacted to free context space. " +
				"Write a summary of it in EXACTLY this markdown format:\n\n" +
				"## Goal\n(what the user is trying to accomplish)\n\n" +
				"## Constraints & Preferences\n- (requirements the user mentioned)\n\n" +
				"## Progress\n### Done\n- [x] (completed work)\n### In Progress\n- [ ] (current work)\n### Blocked\n- (issues, if any)\n\n" +
				"## Key Decisions\n- (decision: rationale)\n\n" +
				"## Next Steps\n1. (what happens next)\n\n" +
				"## Critical Context\n- (data needed to continue: exact file paths, symbols, commands, config values)\n",
		);
		const reads = fileOps?.readFiles ?? [];
		const modified = fileOps?.modifiedFiles ?? [];
		if (reads.length > 0) parts.push(`\n<read-files>\n${reads.join("\n")}\n</read-files>`);
		if (modified.length > 0) parts.push(`\n<modified-files>\n${modified.join("\n")}\n</modified-files>`);
		parts.push(
			"\nRules:\n" +
				"- Write a FRESH digest of the whole conversation: NEVER copy or echo any previous message verbatim (especially the last assistant reply) — a summary that merely repeats a chat message is WRONG.\n" +
				"- The summary MUST begin with the \"## Goal\" heading.\n" +
				"- The LAST user message in the conversation (and the reply to it) is kept verbatim after compaction: reference it in at most one line, do not restate it.\n" +
				"- Preserve exact file paths, identifiers, and decisions; be dense, no filler.\n" +
				"- Respond with ONLY the summary markdown — no preamble, no code fences.",
		);
		if (previousSummary) {
			parts.push(
				`\nA previous compaction summary exists. Merge it with the newer conversation into ONE updated summary (drop what is stale, keep what is still relevant):\n\n${previousSummary}`,
			);
		}
		if (customInstructions) {
			parts.push(`\nAdditional focus requested by the user: ${customInstructions}`);
		}
		return parts.join("\n");
	};

	const mapUsage = (input: number, output: number, cacheRead: number, cacheWrite: number): UsageLike => ({
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	const stripFences = (s: string): string => {
		let out = s.trim();
		const m = out.match(/^```[a-zA-Z]*\n([\s\S]*)\n?```$/);
		if (m) out = (m[1] ?? out).trim();
		return out;
	};

	// ------------------------------------------------ the interception

	pi.on("session_before_compact", async (event, ctx) => {
		if (mode === "off") return;
		const prep = event.preparation;
		const notify = (msg: string, kind: "info" | "warning" = "warning") => {
			try {
				ctx.ui.notify(msg, kind);
			} catch {
				/* headless */
			}
		};

		try {
			if (event.reason === "overflow") return; // full replay may not fit — default handles truncation
			const model = ctx.model as
				| (ExtensionContext["model"] & { baseUrl?: string; contextWindow?: number; maxTokens?: number })
				| undefined;
			if (!model?.id || !model.baseUrl) return;
			if (!lastWire) {
				notify("cache-compact: no captured request yet — using default compaction", "info");
				return;
			}
			if (lastWire.modelId !== model.id) {
				notify(`cache-compact: model changed (${lastWire.modelId} → ${model.id}) — using default compaction`);
				return;
			}
			const cw = model.contextWindow ?? 0;
			if (cw > 0 && prep.tokensBefore + SUMMARY_MAX_TOKENS + INSTRUCTION_SLACK > cw) {
				notify(`cache-compact: replay would overflow the window (${prep.tokensBefore}+${SUMMARY_MAX_TOKENS} > ${cw}) — using default compaction`);
				return;
			}

			const body = lastWire.body as Record<string, unknown>;
			const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
			const instruction = buildInstruction(prep.previousSummary, prep.fileOps as { readFiles?: string[]; modifiedFiles?: string[] } | undefined, event.customInstructions);
			const isAnthropic = body.system !== undefined;

			// -- build the replay body (prefix byte-identical, instruction appended) --
			const replay: Record<string, unknown> = { ...body, stream: false };
			if (isAnthropic) {
				delete replay.thinking;
				delete replay.max_thinking_tokens;
				replay.max_tokens = Math.max((replay.max_tokens as number) ?? 0, SUMMARY_MAX_TOKENS);
				replay.messages = [
					...messages,
					{
						role: "user",
						content: [{ type: "text", text: instruction, cache_control: { type: "ephemeral" } }],
					},
				];
			} else {
				replay.messages = [...messages, { role: "user", content: instruction }];
			}

			// -- send --
			// SDK-style string join (NOT URL resolution): baseURL "http://h/v1" must yield
			// "http://h/v1/chat/completions", exactly where the live request went.
			const joinUrl = (base: string, p: string) => `${base.replace(/\/+$/, "")}/${p.replace(/^\//, "")}`;
			const url = isAnthropic ? joinUrl(model.baseUrl, "v1/messages") : joinUrl(model.baseUrl, "chat/completions");
			const headers: Record<string, string> = { ...lastHeaders, "content-type": "application/json" };
			if (isAnthropic) headers["anthropic-version"] = "2023-06-01";

			// Generation caps are NOT rendered into the prompt — raising them keeps the prefix
			// byte-identical (unlike template kwargs / messages, which we never touch).
			if (!isAnthropic) {
				const cap = Math.max(Number(replay.max_tokens as number) || 0, Number(replay.max_completion_tokens as number) || 0, SUMMARY_MAX_TOKENS);
				replay.max_tokens = cap;
				if (replay.max_completion_tokens !== undefined) replay.max_completion_tokens = cap;
			}

			const doFetch = async (): Promise<Record<string, any>> => {
				const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(replay), signal: event.signal });
				if (!res.ok) {
					const text = await res.text().catch(() => "");
					throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
				}
				return (await res.json()) as Record<string, any>;
			};

			const t0 = Date.now();
			let json = await doFetch();
			let ms = Date.now() - t0;

			// -- parse --
			let summary = "";
			let usage: UsageLike;
			if (isAnthropic) {
				if (json.stop_reason === "max_tokens") throw new Error("summary hit the token cap");
				summary = (json.content ?? [])
					.filter((b: { type: string }) => b.type === "text")
					.map((b: { text?: string }) => b.text ?? "")
					.join("\n");
				const u = json.usage ?? {};
				usage = mapUsage(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0);
			} else {
				if (json.choices?.[0]?.finish_reason === "length") throw new Error(`summary hit the token cap (max_tokens=${replay.max_tokens})`);
				summary = String(json.choices?.[0]?.message?.content ?? "");
				if (!summary.trim()) {
					// Qwen3-style thinking models can emit chain-of-thought then EOS with empty
					// content (budget eaten by thinking). Retry once with double the cap — the
					// prefix stays byte-identical, so the retry is still a cache hit.
					replay.max_tokens = (Number(replay.max_tokens) || SUMMARY_MAX_TOKENS) * 2;
					if (replay.max_completion_tokens !== undefined)
						replay.max_completion_tokens = (Number(replay.max_completion_tokens) || SUMMARY_MAX_TOKENS) * 2;
					json = await doFetch();
					ms = Date.now() - t0;
					if (json.choices?.[0]?.finish_reason === "length") throw new Error(`summary hit the token cap (max_tokens=${replay.max_tokens})`);
					summary = String(json.choices?.[0]?.message?.content ?? "");
				}
				const u = json.usage ?? {};
				// OpenAI semantics: prompt_tokens INCLUDES cached — pi's Usage.input is non-cached.
				const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
				usage = mapUsage(Math.max(0, (u.prompt_tokens ?? 0) - cached), u.completion_tokens ?? 0, cached, 0);
			}
			summary = stripFences(summary);
			if (!summary) throw new Error(`empty summary (server reply: ${JSON.stringify(json.choices?.[0] ?? json).slice(0, 240)})`);

			// Degeneracy guard: small models sometimes echo the last assistant message instead of
			// writing a digest (observed live with Qwen3-27B). Detect it and fall back to default.
			let lastAssistant = "";
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "assistant") {
					const c = messages[i].content;
					lastAssistant = typeof c === "string" ? c : Array.isArray(c) ? (c as Array<{ text?: string }>).map((b) => b?.text ?? "").join("") : "";
					break;
				}
			}
			const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
			const sN = norm(summary);
			const aN = norm(lastAssistant);
			if (sN.length < 150) throw new Error(`summary too short (${sN.length} chars) — likely degenerate`);
			const head = aN.slice(0, 60);
			if (head.length >= 30 && (sN.startsWith(head) || aN.startsWith(sN.slice(0, 60))))
				throw new Error("summary echoes the last assistant message — likely degenerate");

			const total = usage.cacheRead + usage.input;
			lastReplay = { cached: usage.cacheRead, fresh: usage.input, hitPct: total > 0 ? (100 * usage.cacheRead) / total : 0, ms };
			lastWire = null; // consumed — the post-compaction context is new; next live request re-captures

			return {
				compaction: {
					summary,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore,
					usage,
					details: { readFiles: prep.fileOps?.readFiles ?? [], modifiedFiles: prep.fileOps?.modifiedFiles ?? [] },
				},
			};
		} catch (error) {
			if (event.signal?.aborted) return; // user aborted — let pi treat it as a cancelled compaction
			lastWire = null;
			const msg = error instanceof Error ? error.message : String(error);
			notify(`cache-compact: replay failed (${msg}) — using default compaction`);
			return;
		}
	});

	// ------------------------------------------------ visible proof

	pi.on("session_compact", (event, ctx) => {
		if (!event.fromExtension || !lastReplay) return;
		try {
			ctx.ui.notify(
				`cache-compact ✓: cached ${fmtK(lastReplay.cached)} / fresh ${fmtK(lastReplay.fresh)} (${lastReplay.hitPct.toFixed(1)}% hit, ${Math.round(lastReplay.ms / 1000)}s)`,
				"info",
			);
		} catch {
			/* headless */
		}
	});

	// ------------------------------------------------ session-start banner

	const banner = (ctx: ExtensionContext): void => {
		try {
			ctx.ui.notify(
				"cache-compact: enabled — /compact replays the captured request through the server's prompt cache (manage: /cache-compact auto|on|off|status)",
				"info",
			);
		} catch {
			/* headless */
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (mode === "off") return;
		banner(ctx);
	});

	// ------------------------------------------------ diagnostics command

	const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

	pi.registerCommand("cache-compact", {
		description: "Cache-friendly compaction: /cache-compact [auto|on|off|status] (default: auto)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "auto") {
				mode = "auto";
				try {
					ctx.ui.notify("cache-compact: auto — enabled now, at session start and after /reload (banner shown then); disable with: /cache-compact off", "info");
				} catch {
					/* headless */
				}
				return;
			}
			if (arg === "on") {
				mode = "on";
				banner(ctx);
				return;
			}
			if (arg === "off") {
				mode = "off";
				try {
					ctx.ui.notify("cache-compact: off (default compaction in use; resets to auto after /reload)", "info");
				} catch {
					/* headless */
				}
				return;
			}
			if (arg === "status") {
				const state = mode;
				if (!lastWire) {
					try {
						ctx.ui.notify(`cache-compact: ${state}; no captured request yet (send a prompt first)`, "info");
					} catch {
						/* headless */
					}
					return;
				}
				const body = lastWire.body as Record<string, any>;
				const nMsg = Array.isArray(body.messages) ? body.messages.length : 0;
				const approxTok = Math.round(JSON.stringify(body).length / 4);
				const age = Math.round((Date.now() - lastWire.at) / 1000);
				let line = `cache-compact: ${state}; capture: ${lastWire.modelId}, ${nMsg} msgs, ~${fmtK(approxTok)} tok, max_tokens=${body.max_tokens ?? body.max_completion_tokens ?? "?"}, ${age}s old`;
				if (lastReplay) line += `; last replay: ${fmtK(lastReplay.cached)} cached / ${fmtK(lastReplay.fresh)} fresh (${lastReplay.hitPct.toFixed(1)}%)`;
				try {
					ctx.ui.notify(line, "info");
				} catch {
					/* headless */
				}
				return;
			}
			const state = mode;
			if (!lastWire) {
				ctx.ui.notify(`cache-compact: ${state}; no captured request yet (send a prompt first)`, "info");
				return;
			}
			const body = lastWire.body as Record<string, any>;
			const nMsg = Array.isArray(body.messages) ? body.messages.length : 0;
			const approxTok = Math.round(JSON.stringify(body).length / 4);
			const age = Math.round((Date.now() - lastWire.at) / 1000);
			let line = `cache-compact: ${state}; capture: ${lastWire.modelId}, ${nMsg} msgs, ~${fmtK(approxTok)} tok, max_tokens=${body.max_tokens ?? body.max_completion_tokens ?? "?"}, ${age}s old`;
			if (lastReplay) line += `; last replay: ${fmtK(lastReplay.cached)} cached / ${fmtK(lastReplay.fresh)} fresh (${lastReplay.hitPct.toFixed(1)}%)`;
			ctx.ui.notify(line, "info");
		},
	});
}
