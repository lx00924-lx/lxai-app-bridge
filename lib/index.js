import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";
//#region lib/types/index.js
/**
* @deepseek-ai/dsh-rest-adapter — in-process local HTTP REST bridge over the
* DSH API gateway. Registers /v1/* and /health routes on the existing web
* server (no second port): each prompt is dispatched through `ctx.apiProxy`
* — the same gateway the browser uses — and the final assistant text is
* collected by polling session.history until the turn ends. CORS is enabled
* (Access-Control-Allow-Origin: *) so external local applications can call in.
*/
/** Stable Cordis plugin name. */
const name = "rest-adapter";
/** Services required before providing the REST routes. */
const inject = [
	"webServer",
	"apiProxy",
	"loader"
];
const Config = z.object({
	turnTimeoutMs: z.natural().min(1).default(6e5),
	pollIntervalMs: z.natural().min(1).default(500),
	maxBodyBytes: z.natural().min(1).default(10 * 1024 * 1024),
	defaultToolLimit: z.natural().min(1).default(50),
	maxToolLimit: z.natural().min(1).default(500),
	maxToolResultChars: z.natural().min(1).default(2e3)
});
/** How many session-log events each history poll reads (the recent tail). */
const HISTORY_PAGE = 2e3;
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "Content-Type, Authorization",
	"access-control-max-age": "86400"
};
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(Buffer.byteLength(text)),
		...CORS_HEADERS
	});
	res.end(text);
}
function errorBody(code, message, extra = {}) {
	return {
		status: "error",
		error: {
			code,
			message
		},
		choices: [],
		...extra
	};
}
function rejectMethod(res, method, allowed) {
	sendJson(res, 405, errorBody("method-not-allowed", `only ${allowed} is supported, got ${method ?? "no method"}`));
}
/** One unary JSON-RPC call through the in-process API gateway. */
async function call(gateway, method, payload, timeoutMs) {
	const request = new Request(`http://dsh.internal/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "client-request",
			rpcId: randomUUID(),
			method,
			payload
		}),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const response = await gateway.fetch(request);
	if (response.status !== 200) throw new Error(`api ${method} returned HTTP ${String(response.status)}`);
	let body;
	try {
		body = await response.json();
	} catch {
		throw new Error(`api ${method} returned a non-JSON body`);
	}
	const record = asRecord(asRecord(body)?.result);
	if (record === void 0 || typeof record.ok !== "boolean") throw new Error(`api ${method} returned a malformed envelope`);
	const parsed = { ok: record.ok };
	if (record.ok) {
		if ("value" in record) parsed.value = record.value;
	} else {
		const error = asRecord(record.error);
		parsed.error = {
			...typeof error?.code === "string" ? { code: error.code } : {},
			...typeof error?.message === "string" ? { message: error.message } : {}
		};
	}
	return parsed;
}
function businessError(result, method) {
	const error = /* @__PURE__ */ new Error(`${method} failed: ${result.error?.code ?? "unknown"} — ${result.error?.message ?? "no message"}`);
	const code = result.error?.code;
	if (typeof code === "string") error.code = code;
	return error;
}
function isSessionNotFound(error) {
	return error instanceof Error && error.code === "session-not-found";
}
async function createSession(gateway, sessionId) {
	const result = await call(gateway, "session.create", sessionId === void 0 ? {} : { sessionId }, 3e4);
	if (!result.ok) throw businessError(result, "session.create");
	const created = asRecord(result.value);
	if (typeof created?.sessionId !== "string") throw new Error("session.create returned no sessionId");
	return created.sessionId;
}
async function sendPrompt(gateway, sessionId, text) {
	const result = await call(gateway, "session.prompt", {
		sessionId,
		mode: "queue",
		content: [{
			type: "text",
			text
		}]
	}, 3e4);
	if (!result.ok) throw businessError(result, "session.prompt");
}
function asEvent(raw) {
	const record = asRecord(raw);
	if (record === void 0) return void 0;
	if (typeof record.seq !== "number" || typeof record.time !== "number" || typeof record.type !== "string") return;
	return {
		seq: record.seq,
		time: record.time,
		type: record.type,
		data: record.data
	};
}
async function historyTail(gateway, sessionId) {
	const result = await call(gateway, "session.history", {
		sessionId,
		maxMessages: HISTORY_PAGE
	}, 3e4);
	if (!result.ok) throw businessError(result, "session.history");
	const rows = asRecord(result.value)?.events;
	const events = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		const event = asEvent(asRecord(row)?.event);
		if (event !== void 0) events.push(event);
	}
	return events;
}
/** Read the DSH session roster through session.list. */
async function listSessions(gateway) {
	const result = await call(gateway, "session.list", {}, 3e4);
	if (!result.ok) throw businessError(result, "session.list");
	const items = asRecord(result.value)?.items;
	return Array.isArray(items) ? items.flatMap((item) => asRecord(item) === void 0 ? [] : [asRecord(item)]) : [];
}
/** Session display title: the host-generated title projection, with fallbacks. */
function titleOf(item) {
	const title = asRecord(asRecord(item.projections)?.values)?.title;
	if (typeof title === "string" && title.trim() !== "") return title;
	return item.blank === true ? "新会话" : "未命名会话";
}
/** First text content of a tool-result block, truncated for the wire. */
function toolResultText(block, maxChars) {
	const parts = [];
	const content = block.content;
	for (const part of Array.isArray(content) ? content : []) {
		const record = asRecord(part);
		if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	const joined = parts.join("").trim();
	if (joined.length > maxChars) return `${joined.slice(0, maxChars)}…`;
	return joined;
}
/**
* Reconstruct the tool execution status of a session from its event log.
* Status vocabulary: completed (result, no error), failed (result with
* error/isError), running (no result and the turn is still open), abandoned
* (no result and a later turn/end exists — interrupted/cancelled).
* @param gateway - in-process API gateway.
* @param sessionId - session whose tool calls are reported.
* @param limit - maximum number of tools returned, newest first.
* @param maxResultChars - resultText excerpt cap.
* @returns tool status rows, newest first.
*/
async function sessionTools(gateway, sessionId, limit, maxResultChars) {
	const events = await historyTail(gateway, sessionId);
	const calls = /* @__PURE__ */ new Map();
	const order = [];
	let lastTurnEnd = -1;
	for (const event of events) if (event.type === "turn/end") lastTurnEnd = event.seq;
	else if (event.type === "tool/call") {
		const data = asRecord(event.data) ?? {};
		const row = {
			callId: data.callId,
			name: data.name,
			arguments: data.arguments,
			status: "running",
			time: event.time,
			turn: data.turn,
			step: data.step,
			seq: event.seq
		};
		calls.set(row.callId, row);
		order.push(row.callId);
	} else if (event.type === "tool/result") {
		const data = asRecord(event.data) ?? {};
		const content = asRecord(data.message)?.content;
		const block = asRecord(Array.isArray(content) ? content[0] : void 0);
		const callId = block?.toolCallId;
		if (callId === void 0) continue;
		const row = calls.get(callId);
		if (row === void 0) continue;
		row.resultTime = event.time;
		row.resultText = block === void 0 ? "" : toolResultText(block, maxResultChars);
		row.error = data.error;
		row.status = data.error !== void 0 || block?.isError === true ? "failed" : "completed";
	}
	const tools = [];
	for (let index = order.length - 1; index >= 0; index--) {
		const callId = order[index];
		if (callId === void 0) continue;
		const row = calls.get(callId);
		if (row === void 0) continue;
		if (row.status === "running") row.status = lastTurnEnd > row.seq ? "abandoned" : "running";
		const out = {
			callId: row.callId,
			name: row.name,
			arguments: row.arguments,
			status: row.status,
			time: row.time,
			turn: row.turn,
			step: row.step
		};
		if (row.resultTime !== void 0) out.resultTime = row.resultTime;
		if (row.resultText !== void 0 && row.resultText !== "") out.resultText = row.resultText;
		if (row.error !== void 0) out.error = row.error;
		tools.push(out);
		if (tools.length >= limit) break;
	}
	return tools;
}
/** Cumulative visible and reasoning text of an event window, separately. */
function assistantTexts(events) {
	const text = [];
	const reasoning = [];
	for (const event of events) {
		if (event.type !== "assistant/message") continue;
		const content = asRecord(asRecord(event.data)?.message)?.content;
		for (const raw of Array.isArray(content) ? content : []) {
			const block = asRecord(raw);
			if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
			else if (block?.type === "reasoning" && typeof block.reasoning === "string") reasoning.push(block.reasoning);
		}
	}
	return {
		text: text.join("").trim(),
		reasoning: reasoning.join("").trim()
	};
}
function assistantText(events) {
	const { text, reasoning } = assistantTexts(events);
	if (text !== "") return text;
	return reasoning;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Wait until the session log gains a turn/end after `beforeSeq`, collecting assistant text. */
async function awaitTurnEnd(gateway, sessionId, beforeSeq, turnTimeoutMs, pollIntervalMs) {
	const deadline = Date.now() + turnTimeoutMs;
	let collected = "";
	let endReason;
	while (Date.now() < deadline) {
		const fresh = (await historyTail(gateway, sessionId)).filter((event) => event.seq > beforeSeq);
		const text = assistantText(fresh);
		if (text !== "") collected = text;
		const end = fresh.find((event) => event.type === "turn/end");
		if (end !== void 0) {
			endReason = asRecord(end.data);
			break;
		}
		await sleep(pollIntervalMs);
	}
	return {
		completed: endReason !== void 0,
		collected,
		endReason
	};
}
/**
* Map a turn outcome to REST status fields. A completed turn with an
* error/aborted reason is a failure even when no text was streamed; a
* timeout without any text is reported separately (HTTP 504 by the caller).
* @param outcome - the awaitTurnEnd result.
* @param turnTimeoutMs - the configured timeout, echoed in the timeout message.
* @returns status, finish reason, and optional error payload.
*/
function turnResultFields(outcome, turnTimeoutMs) {
	const kind = outcome.endReason?.kind;
	if (!outcome.completed) {
		if (outcome.collected !== "") return {
			status: "success",
			finish: "length"
		};
		return {
			status: "error",
			finish: null,
			error: {
				code: "turn-timeout",
				message: `agent turn did not complete within ${String(turnTimeoutMs)}ms`
			}
		};
	}
	if (kind === "error") {
		const failure = asRecord(outcome.endReason?.error);
		return {
			status: "error",
			finish: "error",
			error: failure === void 0 ? {
				code: "agent-error",
				message: "agent turn failed"
			} : {
				code: typeof failure.code === "string" ? failure.code : "agent-error",
				message: typeof failure.message === "string" ? failure.message : "agent turn failed"
			}
		};
	}
	if (kind === "aborted") return {
		status: "error",
		finish: "aborted",
		error: {
			code: "aborted",
			message: "agent turn was aborted"
		}
	};
	return {
		status: "success",
		finish: "stop"
	};
}
function readBody(req, maxBodyBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			const buffer = chunk;
			size += buffer.length;
			if (size > maxBodyBytes) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(buffer);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks));
		});
		req.on("error", reject);
	});
}
async function parseJson(req, maxBodyBytes) {
	const raw = await readBody(req, maxBodyBytes);
	if (raw.length === 0) throw new Error("empty request body");
	try {
		return JSON.parse(raw.toString("utf8"));
	} catch {
		throw new Error("request body is not valid JSON");
	}
}
/**
* Resolve the working session id and the log baseline (last event seq) before
* the prompt. A provided sessionId is adopted as-is and NEVER re-created; it
* is only created upstream when it does not exist yet (session-not-found).
* @param runtime - resolved route tunables.
* @param sessionId - optional caller-supplied session id.
* @returns the session id and the seq to treat as "before this turn".
*/
async function resolveSession(runtime, sessionId) {
	if (sessionId === void 0) return {
		id: await createSession(runtime.gateway, void 0),
		beforeSeq: -1
	};
	try {
		const before = await historyTail(runtime.gateway, sessionId);
		return {
			id: sessionId,
			beforeSeq: before.length > 0 ? before[before.length - 1]?.seq ?? -1 : -1
		};
	} catch (error) {
		if (!isSessionNotFound(error)) throw error;
	}
	return {
		id: await createSession(runtime.gateway, sessionId),
		beforeSeq: -1
	};
}
/** Extract the final answer from a user prompt string via DSH. */
async function runPrompt(runtime, prompt, sessionId, options = {}) {
	if (prompt.trim() === "") throw new Error("prompt must be a non-empty string");
	const { id, beforeSeq } = await resolveSession(runtime, sessionId);
	await prepareTurn(runtime, id, options);
	await sendPrompt(runtime.gateway, id, prompt);
	return {
		sessionId: id,
		outcome: await awaitTurnEnd(runtime.gateway, id, beforeSeq, runtime.turnTimeoutMs, runtime.pollIntervalMs)
	};
}
function contentToText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const part of content) {
			const record = asRecord(part);
			if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return JSON.stringify(content);
}
function lastUserText(messages) {
	if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages must be a non-empty array");
	const last = asRecord(messages[messages.length - 1]);
	if (last?.role !== "user") throw new Error("the last message must have role \"user\"");
	return contentToText(last.content);
}
/** Build a single prompt that carries earlier turns as context, for stateless callers. */
function transcriptPrompt(messages) {
	const last = asRecord(messages[messages.length - 1]);
	const history = messages.slice(0, -1);
	if (history.length === 0) return contentToText(last?.content);
	return [
		"以下是此前的对话历史：",
		...history.flatMap((raw) => {
			const message = asRecord(raw);
			if (message === void 0) return [];
			return [`${message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system"}: ${contentToText(message.content)}`];
		}),
		"",
		`用户最新消息：${contentToText(last?.content)}`,
		"请根据以上历史，回答用户的这条最新消息。"
	].join("\n");
}
async function handleCompletion(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "POST") {
		rejectMethod(res, req.method, "POST");
		return;
	}
	let body;
	try {
		body = await parseJson(req, runtime.maxBodyBytes);
	} catch (error) {
		sendJson(res, 400, errorBody("bad-request", error instanceof Error ? error.message : String(error)));
		return;
	}
	const record = asRecord(body) ?? {};
	const sessionId = typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : void 0;
	let prompt;
	try {
		const messages = record.messages;
		if (!Array.isArray(messages)) throw new Error("messages must be a non-empty array");
		prompt = sessionId !== void 0 ? lastUserText(messages) : transcriptPrompt(messages);
	} catch (error) {
		sendJson(res, 400, errorBody("bad-request", error instanceof Error ? error.message : String(error)));
		return;
	}
	try {
		const { sessionId: id, outcome } = await runPrompt(runtime, prompt, sessionId, turnOptionsOf(record));
		const fields = turnResultFields(outcome, runtime.turnTimeoutMs);
		const result = {
			status: fields.status,
			result: outcome.collected,
			sessionId: id,
			choices: [{
				index: 0,
				message: {
					role: "assistant",
					content: outcome.collected
				},
				finish_reason: fields.finish ?? "stop"
			}]
		};
		if (fields.error !== void 0) result.error = fields.error;
		if (fields.status === "error" && !outcome.completed && outcome.collected === "") {
			sendJson(res, 504, result);
			return;
		}
		sendJson(res, 200, result);
	} catch (error) {
		sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
	}
}
async function handlePrompt(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "POST") {
		rejectMethod(res, req.method, "POST");
		return;
	}
	let body;
	try {
		body = await parseJson(req, runtime.maxBodyBytes);
	} catch (error) {
		sendJson(res, 400, errorBody("bad-request", error instanceof Error ? error.message : String(error)));
		return;
	}
	const record = asRecord(body) ?? {};
	if (record.stream === true) {
		const prompt = typeof record.prompt === "string" ? record.prompt : "";
		if (prompt.trim() === "") {
			sendJson(res, 400, errorBody("bad-request", "prompt must be a non-empty string"));
			return;
		}
		await streamTurn(req, res, runtime, typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : void 0, prompt, turnOptionsOf(record));
		return;
	}
	await handlePromptRoute(res, runtime, record);
}
async function handleSessions(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "GET") {
		rejectMethod(res, req.method, "GET");
		return;
	}
	try {
		sendJson(res, 200, {
			status: "success",
			sessions: (await listSessions(runtime.gateway)).map((item) => ({
				id: item.sessionId,
				title: titleOf(item),
				updatedAt: item.updatedAt
			}))
		});
	} catch (error) {
		sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
	}
}
function safeDecode(segment) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
function toolLimitOf(url, runtime) {
	const raw = url.searchParams.get("limit");
	if (raw === null) return runtime.defaultToolLimit;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) return runtime.defaultToolLimit;
	return Math.min(parsed, runtime.maxToolLimit);
}
async function handleSessionsPrefix(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	const pathname = new URL(req.url ?? "/", "http://x").pathname;
	const url = new URL(req.url ?? "/", "http://x");
	const routed = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(tools|abort|approve))?$/);
	if (routed === null) {
		sendJson(res, 404, errorBody("not-found", `no route for ${req.method ?? "no method"} ${pathname}`));
		return;
	}
	const sessionId = safeDecode(routed[1] ?? "");
	const action = routed[2];
	const method = req.method ?? "";
	if (method === "GET" && action === "tools") {
		try {
			const tools = await sessionTools(runtime.gateway, sessionId, toolLimitOf(url, runtime), runtime.maxToolResultChars);
			sendJson(res, 200, {
				status: "success",
				sessionId,
				count: tools.length,
				tools
			});
		} catch (error) {
			if (isSessionNotFound(error)) {
				sendJson(res, 404, errorBody("session-not-found", `session "${sessionId}" not found`));
				return;
			}
			sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
		}
		return;
	}
	if (method === "PATCH" && action === void 0) {
		let body;
		try {
			body = await parseJson(req, runtime.maxBodyBytes);
		} catch (error) {
			sendJson(res, 400, errorBody("bad-request", error instanceof Error ? error.message : String(error)));
			return;
		}
		const rawTitle = asRecord(body)?.title;
		const title = typeof rawTitle === "string" ? rawTitle : void 0;
		if (title === void 0 || title.trim() === "") {
			sendJson(res, 400, errorBody("bad-request", "title must be a non-empty string"));
			return;
		}
		try {
			const result = await call(runtime.gateway, "session.rename", {
				sessionId,
				title
			}, 3e4);
			if (!result.ok) throw businessError(result, "session.rename");
			sendJson(res, 200, {
				status: "success",
				sessionId,
				title: asRecord(result.value)?.title ?? title
			});
		} catch (error) {
			if (isSessionNotFound(error)) {
				sendJson(res, 404, errorBody("session-not-found", `session "${sessionId}" not found`));
				return;
			}
			sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
		}
		return;
	}
	if (method === "DELETE" && action === void 0) {
		try {
			const result = await call(runtime.gateway, "workspace.archiveSession", { sessionId }, 3e4);
			if (!result.ok) throw businessError(result, "workspace.archiveSession");
			sendJson(res, 200, {
				status: "success",
				sessionId,
				archived: true
			});
		} catch (error) {
			if (isSessionNotFound(error)) {
				sendJson(res, 404, errorBody("session-not-found", `session "${sessionId}" not found`));
				return;
			}
			sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
		}
		return;
	}
	if (method === "POST" && action === "abort") {
		try {
			await abortSession(runtime, sessionId);
			sendJson(res, 200, {
				status: "success",
				sessionId,
				aborted: true
			});
		} catch (error) {
			if (isSessionNotFound(error)) {
				sendJson(res, 404, errorBody("session-not-found", `session "${sessionId}" not found`));
				return;
			}
			sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
		}
		return;
	}
	if (method === "POST" && action === "approve") {
		let body;
		try {
			body = await parseJson(req, runtime.maxBodyBytes);
		} catch (error) {
			sendJson(res, 400, errorBody("bad-request", error instanceof Error ? error.message : String(error)));
			return;
		}
		try {
			await approveSession(runtime, sessionId, asRecord(body) ?? {});
			sendJson(res, 200, {
				status: "success",
				sessionId
			});
		} catch (error) {
			sendJson(res, 409, errorBody("approval-answer-failed", error instanceof Error ? error.message : String(error)));
		}
		return;
	}
	sendJson(res, 405, errorBody("method-not-allowed", `no ${method} route for ${pathname}`));
}
function handleHealth(req, res) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "GET") {
		rejectMethod(res, req.method, "GET");
		return;
	}
	sendJson(res, 200, {
		status: "ok",
		service: "dsh-rest-adapter",
		endpoints: [
			"/v1/chat/completions",
			"/v1/agent/prompt",
			"/v1/agent/prompt/stream",
			"/v1/agent/abort",
			"/v1/models",
			"/v1/sessions",
			"/v1/sessions/:id",
			"/v1/sessions/:id/tools",
			"/v1/sessions/:id/abort",
			"/v1/sessions/:id/approve",
			"/v1/plugins"
		]
	});
}
/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_PHASE = {
	0: "pending",
	1: "loading",
	2: "active",
	3: "failed",
	4: null,
	5: "unloading"
};
/** GET /v1/plugins — the Loader plugin roster, read directly from the tree. */
async function handlePlugins(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "GET") {
		rejectMethod(res, req.method, "GET");
		return;
	}
	try {
		const plugins = [];
		for (const entry of runtime.loader.entries()) {
			if (entry.options.group) continue;
			plugins.push({
				id: entry.options.id,
				name: entry.options.name,
				enabled: !entry.disabled,
				phase: entry.fiber === void 0 ? null : FIBER_PHASE[entry.fiber.state]
			});
		}
		sendJson(res, 200, {
			status: "success",
			count: plugins.length,
			plugins
		});
	} catch (error) {
		sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
	}
}
/** Session permission preset vocabulary (the /permission command targets). */
const PERMISSION_PRESETS = new Set([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
/** Normalize common client spellings into the preset vocabulary. */
function normalizePermission(value) {
	const normalized = value.trim().toLowerCase().replaceAll("_", "-");
	if (PERMISSION_PRESETS.has(normalized)) return normalized;
	if (normalized === "full-access" || normalized === "full" || normalized === "all") return "danger-full-access";
	if (normalized === "readonly") return "read-only";
	if (normalized === "workspace" || normalized === "workspacewrite") return "workspace-write";
	return value;
}
function turnOptionsOf(body) {
	const effort = body.reasoningEffort ?? body.reasoning_effort;
	const rawPermission = body.permission ?? body.permissionLevel;
	const permission = typeof rawPermission === "string" && rawPermission !== "" ? normalizePermission(rawPermission) : void 0;
	return {
		...typeof body.model === "string" && body.model !== "" ? { model: body.model } : {},
		...typeof body.provider === "string" && body.provider !== "" ? { provider: body.provider } : {},
		...typeof effort === "string" && effort !== "" ? { reasoningEffort: effort } : {},
		...permission !== void 0 ? { permission } : {}
	};
}
/** Resolve the provider route that serves a model id in the session directory. */
async function resolveProvider(runtime, sessionId, model) {
	const result = await call(runtime.gateway, "session.models", { sessionId }, 3e4);
	if (!result.ok) throw businessError(result, "session.models");
	const groups = asRecord(result.value)?.groups;
	for (const raw of Array.isArray(groups) ? groups : []) {
		const group = asRecord(raw);
		if (group === void 0) continue;
		const models = group.models;
		for (const entry of Array.isArray(models) ? models : []) if (asRecord(entry)?.id === model) return String(group.id ?? "");
	}
	throw new Error(`model "${model}" not found in the session model directory`);
}
/**
* Apply the requested session state before a prompt: the permission preset
* rides the `/permission <preset>` slash command (never reaches the model),
* and model/effort ride `session.selectModel`.
*/
async function prepareTurn(runtime, sessionId, options) {
	const permission = options.permission;
	if (permission !== void 0) {
		if (!PERMISSION_PRESETS.has(permission)) throw new Error(`permission must be one of read-only | workspace-write | danger-full-access, got "${permission}"`);
		const result = await call(runtime.gateway, "session.prompt", {
			sessionId,
			mode: "queue",
			content: [{
				type: "text",
				text: `/permission ${permission}`
			}]
		}, 3e4);
		if (!result.ok) throw businessError(result, "session.prompt (permission command)");
	}
	const model = options.model;
	if (model !== void 0) {
		const provider = options.provider ?? await resolveProvider(runtime, sessionId, model);
		const result = await call(runtime.gateway, "session.selectModel", {
			sessionId,
			provider,
			model,
			...options.reasoningEffort !== void 0 ? { reasoningEffort: options.reasoningEffort } : {}
		}, 3e4);
		if (!result.ok) throw businessError(result, "session.selectModel");
	}
}
/** Write one SSE event frame. */
function writeSse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
/** Best-effort current session title from the history projection baseline. */
async function titleOfSession(runtime, sessionId) {
	try {
		const result = await call(runtime.gateway, "session.history", {
			sessionId,
			maxMessages: 1
		}, 1e4);
		if (!result.ok) return void 0;
		const title = asRecord(asRecord(asRecord(result.value)?.projections)?.values)?.title;
		return typeof title === "string" && title.trim() !== "" ? title : void 0;
	} catch {
		return;
	}
}
/** Resolve the working session, adopt it for app-driven approvals, then stream. */
async function streamTurn(req, res, runtime, requestedSessionId, prompt, options) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
		...CORS_HEADERS
	});
	res.write(`: connected\n\n`);
	let closed = false;
	const finish = () => {
		if (closed) return;
		closed = true;
		for (const held of [...runtime.approvals.held.values()]) {
			if (held.sessionId !== currentSessionId) continue;
			runtime.approvals.held.delete(held.approvalId);
			held.resolve("cancelled");
		}
		if (currentSessionId !== void 0) runtime.approvals.driven.delete(currentSessionId);
		res.end();
	};
	let currentSessionId;
	req.on("close", finish);
	try {
		const { id, beforeSeq } = await resolveSession(runtime, requestedSessionId);
		currentSessionId = id;
		await prepareTurn(runtime, id, options);
		runtime.approvals.driven.add(id);
		await sendPrompt(runtime.gateway, id, prompt);
		const deadline = Date.now() + runtime.turnTimeoutMs;
		let lastSeq = beforeSeq;
		let sentText = 0;
		let sentReasoning = 0;
		const toolNames = /* @__PURE__ */ new Map();
		let lastWrite = Date.now();
		const heartbeat = (now) => {
			if (now - lastWrite < 5e3) return;
			res.write(`: keep-alive\n\n`);
			lastWrite = now;
		};
		while (!closed && Date.now() < deadline) {
			const turnEvents = (await historyTail(runtime.gateway, id)).filter((event) => event.seq > beforeSeq);
			const fresh = turnEvents.filter((event) => event.seq > lastSeq);
			const { text, reasoning } = assistantTexts(turnEvents);
			if (text.length > sentText) {
				writeSse(res, "content", { content: text.slice(sentText) });
				sentText = text.length;
				lastWrite = Date.now();
			}
			if (reasoning.length > sentReasoning) {
				writeSse(res, "reasoning", { content: reasoning.slice(sentReasoning) });
				sentReasoning = reasoning.length;
				lastWrite = Date.now();
			}
			let ended = false;
			let endStatus = "completed";
			for (const event of fresh) if (event.type === "tool/call") {
				const data = asRecord(event.data) ?? {};
				toolNames.set(data.callId, data.name);
				writeSse(res, "tool_start", {
					id: data.callId,
					tool: data.name,
					input: data.arguments
				});
				lastWrite = Date.now();
			} else if (event.type === "tool/result") {
				const data = asRecord(event.data) ?? {};
				const content = asRecord(data.message)?.content;
				const block = asRecord(Array.isArray(content) ? content[0] : void 0);
				const callId = block?.toolCallId;
				writeSse(res, "tool_end", {
					id: callId,
					tool: toolNames.get(callId),
					output: block === void 0 ? "" : toolResultText(block, runtime.maxToolResultChars),
					status: data.error !== void 0 || block?.isError === true ? "error" : "success"
				});
				lastWrite = Date.now();
			} else if (event.type === "approval/asked") {
				const data = asRecord(event.data) ?? {};
				writeSse(res, "waiting_approval", {
					approvalId: data.id,
					tool: data.toolName
				});
				lastWrite = Date.now();
			} else if (event.type === "approval/decided") {
				const data = asRecord(event.data) ?? {};
				writeSse(res, "approval_resolved", {
					approvalId: data.id,
					outcome: data.outcome
				});
				lastWrite = Date.now();
			} else if (event.type === "turn/end") {
				const kind = asRecord(event.data)?.kind;
				endStatus = kind === "completed" ? "completed" : kind === "error" ? "error" : kind === "aborted" ? "aborted" : String(kind ?? "completed");
				ended = true;
			}
			if (fresh.length > 0) {
				const last = fresh[fresh.length - 1];
				if (last !== void 0) lastSeq = last.seq;
			}
			if (ended) {
				const done = {
					sessionId: id,
					status: endStatus
				};
				const title = await titleOfSession(runtime, id);
				if (title !== void 0) done.title = title;
				writeSse(res, "done", done);
				finish();
				return;
			}
			heartbeat(Date.now());
			await sleep(runtime.pollIntervalMs);
		}
		if (!closed) {
			writeSse(res, "done", {
				sessionId: id,
				status: "timeout"
			});
			finish();
		}
	} catch (error) {
		if (!closed) {
			writeSse(res, "error", { message: error instanceof Error ? error.message : String(error) });
			finish();
		}
	}
}
/** Answer one prompt route: sync JSON, or SSE when stream is requested. */
async function handlePromptRoute(res, runtime, body) {
	const prompt = typeof body.prompt === "string" ? body.prompt : void 0;
	const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : void 0;
	if (prompt === void 0 || prompt.trim() === "") {
		sendJson(res, 400, errorBody("bad-request", "prompt must be a non-empty string"));
		return;
	}
	const options = turnOptionsOf(body);
	try {
		const { sessionId: id, outcome } = await runPrompt(runtime, prompt, sessionId, options);
		const fields = turnResultFields(outcome, runtime.turnTimeoutMs);
		const result = {
			status: fields.status,
			result: outcome.collected,
			sessionId: id,
			choices: [{ message: {
				role: "assistant",
				content: outcome.collected
			} }]
		};
		if (fields.error !== void 0) result.error = fields.error;
		if (fields.status === "error" && !outcome.completed && outcome.collected === "") {
			sendJson(res, 504, result);
			return;
		}
		sendJson(res, 200, result);
	} catch (error) {
		sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
	}
}
/** POST /v1/agent/prompt/stream — SSE turn stream with heartbeats. */
async function handleStream(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "POST") {
		rejectMethod(res, req.method, "POST");
		return;
	}
	let body;
	try {
		body = await parseJson(req, runtime.maxBodyBytes);
	} catch (error) {
		sendJson(res, 400, errorBody("bad-request", error instanceof Error ? error.message : String(error)));
		return;
	}
	const record = asRecord(body) ?? {};
	const prompt = typeof record.prompt === "string" ? record.prompt : "";
	if (prompt.trim() === "") {
		sendJson(res, 400, errorBody("bad-request", "prompt must be a non-empty string"));
		return;
	}
	await streamTurn(req, res, runtime, typeof record.sessionId === "string" && record.sessionId !== "" ? record.sessionId : void 0, prompt, turnOptionsOf(record));
}
/** GET /v1/models — provider model catalog with reasoning-effort metadata. */
async function handleModels(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "GET") {
		rejectMethod(res, req.method, "GET");
		return;
	}
	try {
		const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId");
		let result;
		if (sessionId !== null && sessionId !== "") result = await call(runtime.gateway, "session.models", { sessionId }, 3e4);
		else result = await call(runtime.gateway, "llm.models", {}, 3e4);
		if (!result.ok) throw businessError(result, "models");
		const value = asRecord(result.value) ?? {};
		const groups = Array.isArray(value.groups) ? value.groups : [];
		const failures = Array.isArray(value.failures) ? value.failures : [];
		const models = [];
		for (const raw of groups) {
			const group = asRecord(raw);
			if (group === void 0) continue;
			for (const entry of Array.isArray(group.models) ? group.models : []) {
				const model = asRecord(entry);
				if (model === void 0) continue;
				const reasoning = asRecord(model.reasoning);
				const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];
				models.push({
					id: model.id,
					name: model.name,
					provider: group.id,
					...typeof model.description === "string" ? { description: model.description } : {},
					supportsReasoningEffort: reasoning !== void 0 && efforts.length > 0,
					reasoningEfforts: efforts.flatMap((rawEffort) => {
						const effort = asRecord(rawEffort);
						return typeof effort?.id === "string" ? [effort.id] : [];
					}),
					...typeof reasoning?.defaultEffort === "string" ? { defaultEffort: reasoning.defaultEffort } : {}
				});
			}
		}
		const response = {
			status: "success",
			models,
			failures
		};
		if (value.current !== void 0) {
			const current = asRecord(value.current);
			if (current !== void 0) response.current = {
				provider: current.provider,
				model: current.model,
				...typeof current.reasoningEffort === "string" ? { reasoningEffort: current.reasoningEffort } : {}
			};
		}
		sendJson(res, 200, response);
	} catch (error) {
		sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
	}
}
/** POST /v1/sessions/:id/abort — cancel the session's active turn. */
async function abortSession(runtime, sessionId) {
	const result = await call(runtime.gateway, "session.cancel", { sessionId }, 3e4);
	if (!result.ok) throw businessError(result, "session.cancel");
}
/** POST /v1/agent/abort — alias abort by body { sessionId }. */
async function handleAbortAlias(req, res, runtime) {
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	if (req.method !== "POST") {
		rejectMethod(res, req.method, "POST");
		return;
	}
	let body;
	try {
		body = await parseJson(req, runtime.maxBodyBytes);
	} catch (error) {
		sendJson(res, 400, errorBody("bad-request", error instanceof Error ? error.message : String(error)));
		return;
	}
	const rawSessionId = asRecord(body)?.sessionId;
	const sessionId = typeof rawSessionId === "string" ? rawSessionId : void 0;
	if (sessionId === void 0 || sessionId === "") {
		sendJson(res, 400, errorBody("bad-request", "sessionId is required"));
		return;
	}
	try {
		await abortSession(runtime, sessionId);
		sendJson(res, 200, {
			status: "success",
			sessionId,
			aborted: true
		});
	} catch (error) {
		sendJson(res, 502, errorBody("upstream-error", error instanceof Error ? error.message : String(error)));
	}
}
/** POST /v1/sessions/:id/approve — answer one app-held approval. */
async function approveSession(runtime, sessionId, body) {
	const approvalId = typeof body.approvalId === "string" ? body.approvalId : void 0;
	const rawAction = body.action ?? body.outcome;
	const action = typeof rawAction === "string" ? rawAction.trim().toLowerCase() : void 0;
	let outcome;
	if (action === "allow" || action === "approve" || action === "approved" || action === "allowed-once" || action === "yes") outcome = "allowed-once";
	else if (action === "deny" || action === "reject" || action === "rejected" || action === "no") outcome = "rejected";
	if (approvalId === void 0 || outcome === void 0) throw new Error("approvalId and action (\"allow\" | \"deny\") are required");
	const held = runtime.approvals.held.get(approvalId);
	if (held === void 0) throw new Error(`no pending approval "${approvalId}" (it may already be decided or expired)`);
	if (held.sessionId !== sessionId) throw new Error(`approval "${approvalId}" belongs to another session`);
	runtime.approvals.held.delete(approvalId);
	held.resolve(outcome);
}
/**
* Mount the REST routes on the existing web server. The /api prefix stays
* untouched (owned by the browser transport), so the OpenAI-style and prompt
* routes live under /v1 with /health as the probe.
* @param ctx - host plugin context.
* @param config - resolved plugin config (schema defaults applied).
*/
function apply(ctx, config) {
	const approvals = {
		driven: /* @__PURE__ */ new Set(),
		held: /* @__PURE__ */ new Map()
	};
	const runtime = {
		gateway: toFetchHandler(ctx.apiProxy),
		loader: ctx.loader,
		approvals,
		turnTimeoutMs: config?.turnTimeoutMs ?? 6e5,
		pollIntervalMs: config?.pollIntervalMs ?? 500,
		maxBodyBytes: config?.maxBodyBytes ?? 10 * 1024 * 1024,
		defaultToolLimit: config?.defaultToolLimit ?? 50,
		maxToolLimit: config?.maxToolLimit ?? 500,
		maxToolResultChars: config?.maxToolResultChars ?? 2e3
	};
	ctx.on("approval/request", (request, next) => {
		const sessionId = String(request.agent.session.id);
		if (!approvals.driven.has(sessionId)) return next();
		const events = request.agent.session.events;
		const heldIds = new Set(approvals.held.keys());
		const decided = /* @__PURE__ */ new Set();
		let approvalId;
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const record = asRecord(events[index]);
			const type = record?.type;
			const data = asRecord(record?.data);
			if (type === "approval/decided") decided.add(String(data?.id ?? ""));
			else if (type === "approval/asked") {
				const id = String(data?.id ?? "");
				if (decided.has(id) || heldIds.has(id)) continue;
				if ((request.callId ?? null) !== (data?.callId ?? null)) continue;
				approvalId = id;
				break;
			}
		}
		if (approvalId === void 0) return next();
		return new Promise((resolve) => {
			approvals.held.set(approvalId, {
				sessionId,
				approvalId,
				toolName: request.toolName,
				resolve
			});
			request.signal?.addEventListener("abort", () => {
				if (approvals.held.delete(approvalId)) resolve("cancelled");
			}, { once: true });
		});
	}, { prepend: true });
	const routes = [
		{
			kind: "exact",
			path: "/health",
			handler: (req, res) => handleHealth(req, res)
		},
		{
			kind: "exact",
			path: "/v1/chat/completions",
			handler: (req, res) => handleCompletion(req, res, runtime)
		},
		{
			kind: "exact",
			path: "/v1/agent/prompt",
			handler: (req, res) => handlePrompt(req, res, runtime)
		},
		{
			kind: "exact",
			path: "/v1/agent/prompt/stream",
			handler: (req, res) => handleStream(req, res, runtime)
		},
		{
			kind: "exact",
			path: "/v1/agent/abort",
			handler: (req, res) => handleAbortAlias(req, res, runtime)
		},
		{
			kind: "exact",
			path: "/v1/models",
			handler: (req, res) => handleModels(req, res, runtime)
		},
		{
			kind: "exact",
			path: "/v1/sessions",
			handler: (req, res) => handleSessions(req, res, runtime)
		},
		{
			kind: "prefix",
			path: "/v1/sessions",
			handler: (req, res) => handleSessionsPrefix(req, res, runtime)
		},
		{
			kind: "exact",
			path: "/v1/plugins",
			handler: (req, res) => handlePlugins(req, res, runtime)
		}
	];
	for (const route of routes) ctx.effect(() => ctx.webServer.register(route), `rest-adapter: ${route.path} route`);
	ctx.logger.info("rest-adapter: mounted /v1 REST control plane (chat, prompts + SSE stream, models, session rename/archive/tools/abort/approve, plugins) plus /health");
}
//#endregion
export { Config, apply, inject, name };
