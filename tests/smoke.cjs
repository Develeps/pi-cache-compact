/*
 * Smoke test for cache-compact.ts (local pre-repo check).
 * Mock ExtensionAPI + globalThis.fetch; verifies wire replay byte-identity,
 * instruction assembly, usage mapping, all fallback branches, anthropic path.
 */
const path = require("path");
const { createRequire } = require("module");

const req = createRequire("C:/Users/user/pi-speed-barhistory/test/smoke.cjs"); // resolve jiti from the repo's node_modules
const { createJiti } = req("jiti");
const jiti = createJiti(__filename);
const EXT = "C:/Users/user/.pi/agent/extensions/cache-compact.ts";

let failures = 0;
function check(name, cond, extra) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
	}
}

(async () => {
	const mod = await jiti.import(EXT);
	const factory = mod.default ?? mod;
	check("module loads via jiti", typeof factory === "function");

	// ---- mocks ----
	const handlers = {};
	const commands = {};
	const notifications = [];
	const fetchCalls = [];
	let fetchImpl = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 });
	globalThis.fetch = (url, init) => {
		fetchCalls.push({ url, init });
		return fetchImpl(url, init);
	};
	const jsonRes = (obj, status = 200) => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => obj,
		text: async () => JSON.stringify(obj),
	});
	const ctx = {
		model: { id: "qwen3.8-27b", baseUrl: "http://127.0.0.1:8080/v1", contextWindow: 240000, maxTokens: 8192 },
		ui: { notify: (m, k) => notifications.push([k ?? "info", m]) },
	};
	const pi = {
		on: (n, fn) => (handlers[n] ??= []).push(fn),
		registerCommand: (n, o) => (commands[n] = o),
	};
	factory(pi);
	check("handlers: before_provider_request/headers, session_before_compact, session_compact", ["before_provider_request", "before_provider_headers", "session_before_compact", "session_compact"].every((n) => handlers[n]?.length));
	check("command 'cache-compact' registered", !!commands["cache-compact"]);
	const emit = (n, e, c = ctx) => handlers[n]?.forEach((f) => f(e, c));

	// ---- 1. capture ----
	const chatBody = {
		model: "qwen3.8-27b",
		messages: [
			{ role: "system", content: "You are a coding agent." },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		],
		tools: [{ type: "function", function: { name: "read", parameters: {} } }],
		max_tokens: 4096,
		temperature: 0.3,
	};
	emit("before_provider_request", { type: "before_provider_request", payload: chatBody });
	emit("before_provider_headers", { type: "before_provider_headers", headers: { authorization: "Bearer sk-test", "x-pi": "1" } });
	await commands["cache-compact"].handler("", ctx);
	const stateNote = notifications[notifications.length - 1][1];
	check("capture state reported (model, 3 msgs, few s old)", /qwen3\.8-27b/.test(stateNote) && /3 msgs/.test(stateNote) && /\ds old/.test(stateNote), stateNote);

	// ---- 2. manual compact: chat replay ----
	const mockSummary =
		"## Goal\nDo the thing: build and verify the cache-compact extension end-to-end.\n\n## Progress\n### Done\n- [x] built cache-compact\n- [x] wire capture + replay\n\n## Next Steps\n1. ship";
	const LONG =
		"## Goal\nRetry after empty thinking response: verify the cache-compact extension works end-to-end.\n\n## Progress\n### Done\n- [x] built\n\n## Next Steps\n1. ship";
	fetchImpl = async () =>
		jsonRes({
			choices: [{ message: { role: "assistant", content: mockSummary }, finish_reason: "stop" }],
			usage: { prompt_tokens: 120000, completion_tokens: 3000, total_tokens: 123000, prompt_tokens_details: { cached_tokens: 118000 } },
		});
	const event = {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "e42",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 120000,
			previousSummary: "OLD SUMMARY TEXT",
			fileOps: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
			settings: {},
		},
		branchEntries: [],
		customInstructions: "focus on networking",
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
	const result = await handlers.session_before_compact[0](event, ctx);
	check("returns compaction result", !!result?.compaction, JSON.stringify(result)?.slice(0, 120));
	check("summary passthrough", result?.compaction?.summary === mockSummary);
	check("firstKeptEntryId + tokensBefore from preparation", result?.compaction?.firstKeptEntryId === "e42" && result?.compaction?.tokensBefore === 120000);
	check("usage mapped: cacheRead 118000, output 3000", result?.compaction?.usage?.cacheRead === 118000 && result?.compaction?.usage?.output === 3000);
	check("details: readFiles/modifiedFiles from fileOps", result?.compaction?.details?.readFiles?.[0] === "a.ts" && result?.compaction?.details?.modifiedFiles?.[0] === "b.ts");

	check("exactly one fetch call", fetchCalls.length === 1);
	const call = fetchCalls[0];
	check("URL = {baseUrl}/chat/completions", call.url === "http://127.0.0.1:8080/v1/chat/completions", call.url);
	const sent = JSON.parse(call.init.body);
	check("prefix byte-identical: first 3 messages equal capture", JSON.stringify(sent.messages.slice(0, 3)) === JSON.stringify(chatBody.messages));
	check("model/tools/temperature preserved", sent.model === "qwen3.8-27b" && sent.tools?.[0]?.function?.name === "read" && sent.temperature === 0.3);
	check("stream forced false", sent.stream === false);
	check("exactly one instruction appended", sent.messages.length === 4 && sent.messages[3].role === "user");
	const instr = sent.messages[3].content;
	check("instruction: compactor format + OLD SUMMARY + custom + file lists + last-user rule", ["context compactor", "## Goal", "OLD SUMMARY TEXT", "focus on networking", "<read-files>", "a.ts", "<modified-files>", "b.ts", "LAST user message"].every((s) => instr.includes(s)));
	const sentHeaders = call.init.headers;
	check("captured auth headers reused + content-type", sentHeaders.authorization === "Bearer sk-test" && sentHeaders["content-type"] === "application/json" && sentHeaders["x-pi"] === "1");

	// session_compact notify
	emit("session_compact", { type: "session_compact", compactionEntry: result.compaction, fromExtension: true, reason: "manual", willRetry: false });
	const proofNote = notifications.filter((n) => n[1].startsWith("cache-compact ✓")).pop();
	check("proof notify with hit %", !!proofNote && /9\.?5\d*%|100%|9\d\.\d%/.test(proofNote?.[1] ?? ""), proofNote?.[1]);

	// capture consumed
	const r2 = await handlers.session_before_compact[0](event, { ...ctx, ui: { notify: () => {} } });
	check("capture consumed after success → default", r2 === undefined);
	check("no fetch without capture", fetchCalls.length === 1);

	// ---- 3. fallback branches ----
	const recapture = () => {
		fetchCalls.length = 0;
		emit("before_provider_request", { type: "before_provider_request", payload: chatBody });
	};

	// overflow
	recapture();
	check("overflow → default (no fetch)", (await handlers.session_before_compact[0](
		{ ...event, reason: "overflow" },
		{ ...ctx, ui: { notify: () => {} } },
	)) === undefined && fetchCalls.length === 0);

	// model switch
	recapture();
	check("model switch → default (no fetch)", (await handlers.session_before_compact[0](
		event,
		{ ...ctx, model: { ...ctx.model, id: "gpt-5" }, ui: { notify: () => {} } },
	)) === undefined && fetchCalls.length === 0);

	// size overflow (tokensBefore + 8192 + 4096 > contextWindow)
	recapture();
	check("replay would overflow window → default (no fetch)", (await handlers.session_before_compact[0](
		{ ...event, preparation: { ...event.preparation, tokensBefore: 238000 } },
		{ ...ctx, ui: { notify: () => {} } },
	)) === undefined && fetchCalls.length === 0);

	// HTTP 500
	recapture();
	fetchImpl = async () => jsonRes({ error: "boom" }, 500);
	check("HTTP 500 → default + warning", (await handlers.session_before_compact[0](
		event,
		{ ...ctx, ui: { notify: () => {} } },
	)) === undefined && fetchCalls.length === 1);

	// finish_reason length
	recapture();
	fetchImpl = async () => jsonRes({ choices: [{ message: { content: "partial" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 8192, prompt_tokens_details: { cached_tokens: 9 } } });
	check("summary hit token cap → default", (await handlers.session_before_compact[0](event, { ...ctx, ui: { notify: () => {} } })) === undefined);

	// empty summary
	recapture();
	fetchImpl = async () => jsonRes({ choices: [{ message: { content: "   " }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } } });
	check("empty summary → default", (await handlers.session_before_compact[0](event, { ...ctx, ui: { notify: () => {} } })) === undefined);

	// thinking model: empty content on 1st attempt, text on retry → success, cap doubled
	recapture();
	{
		let n = 0;
		fetchImpl = async () => {
			n++;
			return jsonRes({
				choices: [{ message: { role: "assistant", content: n === 1 ? "" : LONG }, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 95 } },
			});
		};
		const rr = await handlers.session_before_compact[0](event, { ...ctx, ui: { notify: () => {} } });
		check("empty→retry: succeeds on 2nd fetch", rr?.compaction?.summary === LONG && fetchCalls.length === 2);
		const m1 = JSON.parse(fetchCalls[0].init.body).max_tokens;
		const m2 = JSON.parse(fetchCalls[1].init.body).max_tokens;
		check("retry doubles the generation cap", m1 >= 8192 && m2 === m1 * 2, `m1=${m1} m2=${m2}`);
		check("both attempts: prefix byte-identical", JSON.stringify(JSON.parse(fetchCalls[0].init.body).messages.slice(0, 3)) === JSON.stringify(JSON.parse(fetchCalls[1].init.body).messages.slice(0, 3)));
		check("retry usage mapped (cacheRead 95)", rr?.compaction?.usage?.cacheRead === 95);
	}

	// fence stripping
	recapture();
	fetchImpl = async () => jsonRes({ choices: [{ message: { content: "```markdown\n" + LONG + "\n```" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } } });
	const fenced = await handlers.session_before_compact[0](event, { ...ctx, ui: { notify: () => {} } });
	check("code fences stripped from summary", fenced?.compaction?.summary === LONG, JSON.stringify(fenced?.compaction?.summary));

	// degenerate: model echoes the last assistant message verbatim → fallback to default compaction
	{
		const echoText = "The last assistant reply verbatim: we agreed to ship the extension once the smoke test passed and the user will run /compact as the final step. The next release bundles the README plus the smoke suite.";
		const echoBody = { ...chatBody, messages: [...chatBody.messages, { role: "user", content: "ok" }, { role: "assistant", content: echoText }] };
		fetchCalls.length = 0;
		emit("before_provider_request", { type: "before_provider_request", payload: echoBody });
		fetchImpl = async () => jsonRes({ choices: [{ message: { role: "assistant", content: echoText }, finish_reason: "stop" }], usage: {} });
		const notes = [];
		const r = await handlers.session_before_compact[0](event, { ...ctx, ui: { notify: (m) => notes.push(m) } });
		check("echo → fallback to default compaction", r === undefined && notes.some((n) => /echoes|too short|degenerate/i.test(n)), notes.join(" | "));
		recapture();
	}

	// network error
	recapture();
	globalThis.fetch = async () => {
		throw new Error("ECONNREFUSED");
	};
	check("network error → default", (await handlers.session_before_compact[0](event, { ...ctx, ui: { notify: () => {} } })) === undefined);

	// abort
	recapture();
	globalThis.fetch = async (_u, init) => {
		throw new Error("aborted");
	};
	const ac = new AbortController();
	ac.abort();
	check("aborted signal → silent default (no warning spam)", (await handlers.session_before_compact[0](
		{ ...event, signal: ac.signal },
		{ ...ctx, ui: { notify: (m, k) => notifications.push([k, m]) } },
	)) === undefined);

	// ---- 4. anthropic branch ----
	globalThis.fetch = (url, init) => {
		fetchCalls.push({ url, init });
		return jsonRes({
			id: "msg_1",
			content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: LONG }],
			stop_reason: "end_turn",
			usage: { input_tokens: 2000, output_tokens: 1500, cache_read_input_tokens: 118000, cache_creation_input_tokens: 3000 },
		});
	};
	const anthropicBody = {
		model: "claude-sonnet-4-5",
		max_tokens: 4096,
		thinking: { type: "enabled", budget_tokens: 2000 },
		system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
		tools: [{ name: "read", input_schema: {}, cache_control: { type: "ephemeral" } }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		],
	};
	emit("before_provider_request", { type: "before_provider_request", payload: anthropicBody });
	const aCtx = { model: { id: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", contextWindow: 200000, maxTokens: 64000 }, ui: { notify: () => {} } };
	const aResult = await handlers.session_before_compact[0](event, aCtx);
	const aCall = fetchCalls[fetchCalls.length - 1];
	check("anthropic URL {baseUrl}/v1/messages", aCall.url === "https://api.anthropic.com/v1/messages", aCall.url);
	const aSent = JSON.parse(aCall.init.body);
	check("anthropic prefix byte-identical (system/tools/messages)", JSON.stringify(aSent.system) === JSON.stringify(anthropicBody.system) && JSON.stringify(aSent.tools) === JSON.stringify(anthropicBody.tools) && JSON.stringify(aSent.messages.slice(0, 2)) === JSON.stringify(anthropicBody.messages));
	check("thinking stripped, max_tokens raised to 8192", aSent.thinking === undefined && aSent.max_tokens === 8192);
	check("instruction appended with cache_control", aSent.messages.length === 3 && aSent.messages[2].role === "user" && aSent.messages[2].content[0].cache_control?.type === "ephemeral" && aSent.messages[2].content[0].text.includes("context compactor"));
	check("anthropic-version header added", aCall.init.headers["anthropic-version"] === "2023-06-01");
	check("anthropic usage mapped (cacheRead 118000, cacheWrite 3000)", aResult?.compaction?.usage?.cacheRead === 118000 && aResult?.compaction?.usage?.cacheWrite === 3000);
	check("anthropic summary = text blocks only", aResult?.compaction?.summary === LONG);

	// ---- 5. /cache-compact off ----
	emit("before_provider_request", { type: "before_provider_request", payload: anthropicBody });
	await commands["cache-compact"].handler("off", ctx);
	check("off → default compaction (no fetch)", (await handlers.session_before_compact[0](event, aCtx)) === undefined);
	await commands["cache-compact"].handler("on", ctx);

	console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL OK");
	process.exit(failures ? 1 : 0);
})().catch((e) => {
	console.error("smoke crashed:", e);
	process.exit(1);
});
