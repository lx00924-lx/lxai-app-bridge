/**
 * @deepseek-ai/dsh-rest-adapter — in-process local HTTP REST bridge over the
 * DSH API gateway. Registers /v1/* and /health routes on the existing web
 * server (no second port): each prompt is dispatched through `ctx.apiProxy`
 * — the same gateway the browser uses — and the final assistant text is
 * collected by polling session.history until the turn ends. CORS is enabled
 * (Access-Control-Allow-Origin: *) so external local applications can call in.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'rest-adapter'

/** Services required before providing the REST routes. */
export const inject = ['webServer', 'apiProxy', 'loader']

/** Plugin configuration. */
export interface Config {
  /** Maximum wait for one agent turn before the route answers 504. @default 600000 */
  turnTimeoutMs?: number
  /** History poll interval while waiting for the turn to end. @default 500 */
  pollIntervalMs?: number
  /** Maximum buffered request body bytes per POST. @default 10485760 */
  maxBodyBytes?: number
  /** Default number of tool rows returned by the tool-status route. @default 50 */
  defaultToolLimit?: number
  /** Upper bound accepted for the `?limit=` query. @default 500 */
  maxToolLimit?: number
  /** Character cap for the resultText excerpt of one tool row. @default 2000 */
  maxToolResultChars?: number
}

export const Config: z<Config> = z.object({
  turnTimeoutMs: z.natural().min(1).default(600_000),
  pollIntervalMs: z.natural().min(1).default(500),
  maxBodyBytes: z.natural().min(1).default(10 * 1024 * 1024),
  defaultToolLimit: z.natural().min(1).default(50),
  maxToolLimit: z.natural().min(1).default(500),
  maxToolResultChars: z.natural().min(1).default(2000),
})

/** How many session-log events each history poll reads (the recent tail). */
const HISTORY_PAGE = 2000

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
  'access-control-max-age': '86400',
} as const

/** One pending approval held by the REST answerer for the phone app. */
interface HeldApproval {
  readonly sessionId: string
  readonly approvalId: string
  readonly toolName: string
  resolve: (outcome: ApprovalOutcome) => void
}

/** Approval bridging state between the answerer and the REST routes. */
interface ApprovalBridge {
  /** Sessions whose approvals currently belong to the phone app. */
  readonly driven: Set<string>
  /** Pending approvals held for the app, keyed by approvalId. */
  readonly held: Map<string, HeldApproval>
}

/** Resolved tunables shared by every route handler. */
interface AdapterRuntime {
  readonly gateway: ReturnType<typeof toFetchHandler>
  readonly loader: Context['loader']
  readonly approvals: ApprovalBridge
  readonly turnTimeoutMs: number
  readonly pollIntervalMs: number
  readonly maxBodyBytes: number
  readonly defaultToolLimit: number
  readonly maxToolLimit: number
  readonly maxToolResultChars: number
}

/** Narrow JSON-RPC business result read back from the in-process gateway. */
interface RpcResult {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

interface CodedError extends Error {
  code?: string
}

/** One session-log event with a wide data slot (the merge-extensible envelope). */
interface HistoryEvent {
  seq: number
  time: number
  type: string
  data: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...CORS_HEADERS,
  })
  res.end(text)
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'error', error: { code, message }, choices: [], ...extra }
}

function rejectMethod(res: ServerResponse, method: string | undefined, allowed: string): void {
  sendJson(res, 405, errorBody('method-not-allowed', `only ${allowed} is supported, got ${method ?? 'no method'}`))
}

/** One unary JSON-RPC call through the in-process API gateway. */
async function call(
  gateway: AdapterRuntime['gateway'],
  method: string,
  payload: unknown,
  timeoutMs: number,
): Promise<RpcResult> {
  const request = new Request(`http://dsh.internal/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const response = await gateway.fetch(request)
  if (response.status !== 200) {
    throw new Error(`api ${method} returned HTTP ${String(response.status)}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`api ${method} returned a non-JSON body`)
  }
  const record = asRecord(asRecord(body)?.result)
  if (record === undefined || typeof record.ok !== 'boolean') {
    throw new Error(`api ${method} returned a malformed envelope`)
  }
  const parsed: RpcResult = { ok: record.ok }
  if (record.ok) {
    if ('value' in record) parsed.value = record.value
  } else {
    const error = asRecord(record.error)
    parsed.error = {
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(typeof error?.message === 'string' ? { message: error.message } : {}),
    }
  }
  return parsed
}

function businessError(result: RpcResult, method: string): CodedError {
  const error: CodedError = new Error(`${method} failed: ${result.error?.code ?? 'unknown'} — ${result.error?.message ?? 'no message'}`)
  const code = result.error?.code
  if (typeof code === 'string') error.code = code
  return error
}

function isSessionNotFound(error: unknown): boolean {
  return error instanceof Error && (error as CodedError).code === 'session-not-found'
}

async function createSession(gateway: AdapterRuntime['gateway'], sessionId: string | undefined): Promise<string> {
  const payload = sessionId === undefined ? {} : { sessionId }
  const result = await call(gateway, 'session.create', payload, 30_000)
  if (!result.ok) throw businessError(result, 'session.create')
  const created = asRecord(result.value)
  if (typeof created?.sessionId !== 'string') throw new Error('session.create returned no sessionId')
  return created.sessionId
}

async function sendPrompt(gateway: AdapterRuntime['gateway'], sessionId: string, text: string): Promise<void> {
  const result = await call(gateway, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, 30_000)
  if (!result.ok) throw businessError(result, 'session.prompt')
}

function asEvent(raw: unknown): HistoryEvent | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  if (typeof record.seq !== 'number' || typeof record.time !== 'number' || typeof record.type !== 'string') {
    return undefined
  }
  return { seq: record.seq, time: record.time, type: record.type, data: record.data }
}

async function historyTail(
  gateway: AdapterRuntime['gateway'],
  sessionId: string,
): Promise<HistoryEvent[]> {
  const result = await call(gateway, 'session.history', { sessionId, maxMessages: HISTORY_PAGE }, 30_000)
  if (!result.ok) throw businessError(result, 'session.history')
  const rows = asRecord(result.value)?.events
  const events: HistoryEvent[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const event = asEvent(asRecord(row)?.event)
    if (event !== undefined) events.push(event)
  }
  return events
}

/** Read the DSH session roster through session.list. */
async function listSessions(gateway: AdapterRuntime['gateway']): Promise<Record<string, unknown>[]> {
  const result = await call(gateway, 'session.list', {}, 30_000)
  if (!result.ok) throw businessError(result, 'session.list')
  const items = asRecord(result.value)?.items
  return Array.isArray(items)
    ? items.flatMap(item => asRecord(item) === undefined ? [] : [asRecord(item) as Record<string, unknown>])
    : []
}

/** Session display title: the host-generated title projection, with fallbacks. */
function titleOf(item: Record<string, unknown>): string {
  const title = asRecord(asRecord(item.projections)?.values)?.title
  if (typeof title === 'string' && title.trim() !== '') return title
  return item.blank === true ? '新会话' : '未命名会话'
}

/** First text content of a tool-result block, truncated for the wire. */
function toolResultText(block: Record<string, unknown>, maxChars: number): string {
  const parts: string[] = []
  const content = block.content
  for (const part of Array.isArray(content) ? content : []) {
    const record = asRecord(part)
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  const joined = parts.join('').trim()
  if (joined.length > maxChars) return `${joined.slice(0, maxChars)}…`
  return joined
}

interface ToolRow {
  callId: unknown
  name: unknown
  arguments: unknown
  status: 'running' | 'completed' | 'failed' | 'abandoned'
  time: number
  turn: unknown
  step: unknown
  seq: number
  resultTime?: number
  resultText?: string
  error?: unknown
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
async function sessionTools(
  gateway: AdapterRuntime['gateway'],
  sessionId: string,
  limit: number,
  maxResultChars: number,
): Promise<Record<string, unknown>[]> {
  const events = await historyTail(gateway, sessionId)
  const calls = new Map<unknown, ToolRow>()
  const order: unknown[] = []
  let lastTurnEnd = -1
  for (const event of events) {
    if (event.type === 'turn/end') {
      lastTurnEnd = event.seq
    } else if (event.type === 'tool/call') {
      const data = asRecord(event.data) ?? {}
      const row: ToolRow = {
        callId: data.callId,
        name: data.name,
        arguments: data.arguments,
        status: 'running',
        time: event.time,
        turn: data.turn,
        step: data.step,
        seq: event.seq,
      }
      calls.set(row.callId, row)
      order.push(row.callId)
    } else if (event.type === 'tool/result') {
      const data = asRecord(event.data) ?? {}
      const content = asRecord(data.message)?.content
      const first = Array.isArray(content) ? content[0] : undefined
      const block = asRecord(first)
      const callId = block?.toolCallId
      if (callId === undefined) continue
      const row = calls.get(callId)
      if (row === undefined) continue
      row.resultTime = event.time
      row.resultText = block === undefined ? '' : toolResultText(block, maxResultChars)
      row.error = data.error
      row.status = data.error !== undefined || block?.isError === true ? 'failed' : 'completed'
    }
  }
  const tools: Record<string, unknown>[] = []
  for (let index = order.length - 1; index >= 0; index--) {
    const callId = order[index]
    if (callId === undefined) continue
    const row = calls.get(callId)
    if (row === undefined) continue
    if (row.status === 'running') row.status = lastTurnEnd > row.seq ? 'abandoned' : 'running'
    const out: Record<string, unknown> = {
      callId: row.callId,
      name: row.name,
      arguments: row.arguments,
      status: row.status,
      time: row.time,
      turn: row.turn,
      step: row.step,
    }
    if (row.resultTime !== undefined) out.resultTime = row.resultTime
    if (row.resultText !== undefined && row.resultText !== '') out.resultText = row.resultText
    if (row.error !== undefined) out.error = row.error
    tools.push(out)
    if (tools.length >= limit) break
  }
  return tools
}

/** Cumulative visible and reasoning text of an event window, separately. */
function assistantTexts(events: readonly HistoryEvent[]): { text: string; reasoning: string } {
  const text: string[] = []
  const reasoning: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = asRecord(asRecord(event.data)?.message)?.content
    for (const raw of Array.isArray(content) ? content : []) {
      const block = asRecord(raw)
      if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
      else if (block?.type === 'reasoning' && typeof block.reasoning === 'string') reasoning.push(block.reasoning)
    }
  }
  return { text: text.join('').trim(), reasoning: reasoning.join('').trim() }
}

function assistantText(events: readonly HistoryEvent[]): string {
  const { text, reasoning } = assistantTexts(events)
  if (text !== '') return text
  return reasoning
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface TurnOutcome {
  completed: boolean
  collected: string
  endReason: Record<string, unknown> | undefined
}

/** Wait until the session log gains a turn/end after `beforeSeq`, collecting assistant text. */
async function awaitTurnEnd(
  gateway: AdapterRuntime['gateway'],
  sessionId: string,
  beforeSeq: number,
  turnTimeoutMs: number,
  pollIntervalMs: number,
): Promise<TurnOutcome> {
  const deadline = Date.now() + turnTimeoutMs
  let collected = ''
  let endReason: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    const events = await historyTail(gateway, sessionId)
    const fresh = events.filter(event => event.seq > beforeSeq)
    const text = assistantText(fresh)
    if (text !== '') collected = text
    const end = fresh.find(event => event.type === 'turn/end')
    if (end !== undefined) {
      endReason = asRecord(end.data)
      break
    }
    await sleep(pollIntervalMs)
  }
  return { completed: endReason !== undefined, collected, endReason }
}

interface TurnFields {
  status: 'success' | 'error'
  finish: string | null
  error?: { code: string; message: string }
}

/**
 * Map a turn outcome to REST status fields. A completed turn with an
 * error/aborted reason is a failure even when no text was streamed; a
 * timeout without any text is reported separately (HTTP 504 by the caller).
 * @param outcome - the awaitTurnEnd result.
 * @param turnTimeoutMs - the configured timeout, echoed in the timeout message.
 * @returns status, finish reason, and optional error payload.
 */
function turnResultFields(outcome: TurnOutcome, turnTimeoutMs: number): TurnFields {
  const kind = outcome.endReason?.kind
  if (!outcome.completed) {
    if (outcome.collected !== '') return { status: 'success', finish: 'length' }
    return {
      status: 'error',
      finish: null,
      error: { code: 'turn-timeout', message: `agent turn did not complete within ${String(turnTimeoutMs)}ms` },
    }
  }
  if (kind === 'error') {
    const failure = asRecord(outcome.endReason?.error)
    return {
      status: 'error',
      finish: 'error',
      error: failure === undefined
        ? { code: 'agent-error', message: 'agent turn failed' }
        : {
            code: typeof failure.code === 'string' ? failure.code : 'agent-error',
            message: typeof failure.message === 'string' ? failure.message : 'agent turn failed',
          },
    }
  }
  if (kind === 'aborted') {
    return { status: 'error', finish: 'aborted', error: { code: 'aborted', message: 'agent turn was aborted' } }
  }
  return { status: 'success', finish: 'stop' }
}

function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > maxBodyBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

async function parseJson(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const raw = await readBody(req, maxBodyBytes)
  if (raw.length === 0) throw new Error('empty request body')
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
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
async function resolveSession(runtime: AdapterRuntime, sessionId: string | undefined): Promise<{ id: string; beforeSeq: number }> {
  if (sessionId === undefined) {
    const id = await createSession(runtime.gateway, undefined)
    return { id, beforeSeq: -1 }
  }
  try {
    const before = await historyTail(runtime.gateway, sessionId)
    return { id: sessionId, beforeSeq: before.length > 0 ? before[before.length - 1]?.seq ?? -1 : -1 }
  } catch (error) {
    if (!isSessionNotFound(error)) throw error
  }
  const id = await createSession(runtime.gateway, sessionId)
  return { id, beforeSeq: -1 }
}

/** Extract the final answer from a user prompt string via DSH. */
async function runPrompt(runtime: AdapterRuntime, prompt: string, sessionId: string | undefined, options: TurnOptions = {}): Promise<{ sessionId: string; outcome: TurnOutcome }> {
  if (prompt.trim() === '') throw new Error('prompt must be a non-empty string')
  const { id, beforeSeq } = await resolveSession(runtime, sessionId)
  await prepareTurn(runtime, id, options)
  await sendPrompt(runtime.gateway, id, prompt)
  const outcome = await awaitTurnEnd(runtime.gateway, id, beforeSeq, runtime.turnTimeoutMs, runtime.pollIntervalMs)
  return { sessionId: id, outcome }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      const record = asRecord(part)
      if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return JSON.stringify(content)
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array')
  }
  const last = asRecord(messages[messages.length - 1])
  if (last?.role !== 'user') {
    throw new Error('the last message must have role "user"')
  }
  return contentToText(last.content)
}

/** Build a single prompt that carries earlier turns as context, for stateless callers. */
function transcriptPrompt(messages: unknown[]): string {
  const last = asRecord(messages[messages.length - 1])
  const history = messages.slice(0, -1)
  if (history.length === 0) return contentToText(last?.content)
  const lines = history.flatMap(raw => {
    const message = asRecord(raw)
    if (message === undefined) return []
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'system'
    return [`${role}: ${contentToText(message.content)}`]
  })
  return [
    '以下是此前的对话历史：',
    ...lines,
    '',
    `用户最新消息：${contentToText(last?.content)}`,
    '请根据以上历史，回答用户的这条最新消息。',
  ].join('\n')
}

async function handleCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    rejectMethod(res, req.method, 'POST')
    return
  }
  let body: unknown
  try {
    body = await parseJson(req, runtime.maxBodyBytes)
  } catch (error) {
    sendJson(res, 400, errorBody('bad-request', error instanceof Error ? error.message : String(error)))
    return
  }
  const record = asRecord(body) ?? {}
  const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
  let prompt: string
  try {
    const messages = record.messages
    if (!Array.isArray(messages)) throw new Error('messages must be a non-empty array')
    prompt = sessionId !== undefined ? lastUserText(messages) : transcriptPrompt(messages)
  } catch (error) {
    sendJson(res, 400, errorBody('bad-request', error instanceof Error ? error.message : String(error)))
    return
  }
  try {
    const { sessionId: id, outcome } = await runPrompt(runtime, prompt, sessionId, turnOptionsOf(record))
    const fields = turnResultFields(outcome, runtime.turnTimeoutMs)
    const result: Record<string, unknown> = {
      status: fields.status,
      result: outcome.collected,
      sessionId: id,
      choices: [
        { index: 0, message: { role: 'assistant', content: outcome.collected }, finish_reason: fields.finish ?? 'stop' },
      ],
    }
    if (fields.error !== undefined) result.error = fields.error
    if (fields.status === 'error' && !outcome.completed && outcome.collected === '') {
      sendJson(res, 504, result)
      return
    }
    sendJson(res, 200, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, errorBody('upstream-error', message))
  }
}

async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    rejectMethod(res, req.method, 'POST')
    return
  }
  let body: unknown
  try {
    body = await parseJson(req, runtime.maxBodyBytes)
  } catch (error) {
    sendJson(res, 400, errorBody('bad-request', error instanceof Error ? error.message : String(error)))
    return
  }
  const record = asRecord(body) ?? {}
  if (record.stream === true) {
    const prompt = typeof record.prompt === 'string' ? record.prompt : ''
    if (prompt.trim() === '') {
      sendJson(res, 400, errorBody('bad-request', 'prompt must be a non-empty string'))
      return
    }
    const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
    await streamTurn(req, res, runtime, sessionId, prompt, turnOptionsOf(record))
    return
  }
  await handlePromptRoute(res, runtime, record)
}

async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'GET') {
    rejectMethod(res, req.method, 'GET')
    return
  }
  try {
    const items = await listSessions(runtime.gateway)
    const sessions = items.map(item => ({
      id: item.sessionId,
      title: titleOf(item),
      updatedAt: item.updatedAt,
    }))
    sendJson(res, 200, { status: 'success', sessions })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, errorBody('upstream-error', message))
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function toolLimitOf(url: URL, runtime: AdapterRuntime): number {
  const raw = url.searchParams.get('limit')
  if (raw === null) return runtime.defaultToolLimit
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return runtime.defaultToolLimit
  return Math.min(parsed, runtime.maxToolLimit)
}

async function handleSessionsPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const url = new URL(req.url ?? '/', 'http://x')
  const routed = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(tools|abort|approve))?$/)
  if (routed === null) {
    sendJson(res, 404, errorBody('not-found', `no route for ${req.method ?? 'no method'} ${pathname}`))
    return
  }
  const sessionId = safeDecode(routed[1] ?? '')
  const action = routed[2]
  const method = req.method ?? ''

  // GET /v1/sessions/:id/tools — tool execution status
  if (method === 'GET' && action === 'tools') {
    try {
      const tools = await sessionTools(runtime.gateway, sessionId, toolLimitOf(url, runtime), runtime.maxToolResultChars)
      sendJson(res, 200, { status: 'success', sessionId, count: tools.length, tools })
    } catch (error) {
      if (isSessionNotFound(error)) {
        sendJson(res, 404, errorBody('session-not-found', `session "${sessionId}" not found`))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 502, errorBody('upstream-error', message))
    }
    return
  }

  // PATCH /v1/sessions/:id — rename (pins the title)
  if (method === 'PATCH' && action === undefined) {
    let body: unknown
    try {
      body = await parseJson(req, runtime.maxBodyBytes)
    } catch (error) {
      sendJson(res, 400, errorBody('bad-request', error instanceof Error ? error.message : String(error)))
      return
    }
    const rawTitle = asRecord(body)?.title
    const title = typeof rawTitle === 'string' ? rawTitle : undefined
    if (title === undefined || title.trim() === '') {
      sendJson(res, 400, errorBody('bad-request', 'title must be a non-empty string'))
      return
    }
    try {
      const result = await call(runtime.gateway, 'session.rename', { sessionId, title }, 30_000)
      if (!result.ok) throw businessError(result, 'session.rename')
      const value = asRecord(result.value)
      sendJson(res, 200, { status: 'success', sessionId, title: value?.title ?? title })
    } catch (error) {
      if (isSessionNotFound(error)) {
        sendJson(res, 404, errorBody('session-not-found', `session "${sessionId}" not found`))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 502, errorBody('upstream-error', message))
    }
    return
  }

  // DELETE /v1/sessions/:id — archive from its workspace
  if (method === 'DELETE' && action === undefined) {
    try {
      const result = await call(runtime.gateway, 'workspace.archiveSession', { sessionId }, 30_000)
      if (!result.ok) throw businessError(result, 'workspace.archiveSession')
      sendJson(res, 200, { status: 'success', sessionId, archived: true })
    } catch (error) {
      if (isSessionNotFound(error)) {
        sendJson(res, 404, errorBody('session-not-found', `session "${sessionId}" not found`))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 502, errorBody('upstream-error', message))
    }
    return
  }

  // POST /v1/sessions/:id/abort — cancel the active turn
  if (method === 'POST' && action === 'abort') {
    try {
      await abortSession(runtime, sessionId)
      sendJson(res, 200, { status: 'success', sessionId, aborted: true })
    } catch (error) {
      if (isSessionNotFound(error)) {
        sendJson(res, 404, errorBody('session-not-found', `session "${sessionId}" not found`))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 502, errorBody('upstream-error', message))
    }
    return
  }

  // POST /v1/sessions/:id/approve — answer a held approval
  if (method === 'POST' && action === 'approve') {
    let body: unknown
    try {
      body = await parseJson(req, runtime.maxBodyBytes)
    } catch (error) {
      sendJson(res, 400, errorBody('bad-request', error instanceof Error ? error.message : String(error)))
      return
    }
    try {
      await approveSession(runtime, sessionId, asRecord(body) ?? {})
      sendJson(res, 200, { status: 'success', sessionId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 409, errorBody('approval-answer-failed', message))
    }
    return
  }

  sendJson(res, 405, errorBody('method-not-allowed', `no ${method} route for ${pathname}`))
}

function handleHealth(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'GET') {
    rejectMethod(res, req.method, 'GET')
    return
  }
  sendJson(res, 200, {
    status: 'ok',
    service: 'dsh-rest-adapter',
    endpoints: [
      '/v1/chat/completions',
      '/v1/agent/prompt',
      '/v1/agent/prompt/stream',
      '/v1/agent/abort',
      '/v1/models',
      '/v1/sessions',
      '/v1/sessions/:id',
      '/v1/sessions/:id/tools',
      '/v1/sessions/:id/abort',
      '/v1/sessions/:id/approve',
      '/v1/plugins',
    ],
  })
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
} as const

/** GET /v1/plugins — the Loader plugin roster, read directly from the tree. */
async function handlePlugins(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'GET') {
    rejectMethod(res, req.method, 'GET')
    return
  }
  try {
    const plugins: Record<string, unknown>[] = []
    for (const entry of runtime.loader.entries()) {
      if (entry.options.group) continue
      plugins.push({
        // The composed row's plain id — the same id the GUI toggle patches.
        id: entry.options.id,
        name: entry.options.name,
        enabled: !entry.disabled,
        phase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    sendJson(res, 200, { status: 'success', count: plugins.length, plugins })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, errorBody('upstream-error', message))
  }
}

// ── phone-app control plane: models, SSE streaming, abort, approvals ───────

/** Extra per-turn options accepted by the prompt routes. */
interface TurnOptions {
  readonly model?: string
  readonly provider?: string
  readonly reasoningEffort?: string
  readonly permission?: string
}

/** Session permission preset vocabulary (the /permission command targets). */
const PERMISSION_PRESETS = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/** Normalize common client spellings into the preset vocabulary. */
function normalizePermission(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-')
  if (PERMISSION_PRESETS.has(normalized)) return normalized
  if (normalized === 'full-access' || normalized === 'full' || normalized === 'all') return 'danger-full-access'
  if (normalized === 'readonly') return 'read-only'
  if (normalized === 'workspace' || normalized === 'workspacewrite') return 'workspace-write'
  return value
}

function turnOptionsOf(body: Record<string, unknown>): TurnOptions {
  const effort = body.reasoningEffort ?? body.reasoning_effort
  const rawPermission = body.permission ?? body.permissionLevel
  const permission = typeof rawPermission === 'string' && rawPermission !== '' ? normalizePermission(rawPermission) : undefined
  return {
    ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
    ...(typeof body.provider === 'string' && body.provider !== '' ? { provider: body.provider } : {}),
    ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
    ...(permission !== undefined ? { permission } : {}),
  }
}

/** Resolve the provider route that serves a model id in the session directory. */
async function resolveProvider(runtime: AdapterRuntime, sessionId: string, model: string): Promise<string> {
  const result = await call(runtime.gateway, 'session.models', { sessionId }, 30_000)
  if (!result.ok) throw businessError(result, 'session.models')
  const groups = asRecord(result.value)?.groups
  for (const raw of Array.isArray(groups) ? groups : []) {
    const group = asRecord(raw)
    if (group === undefined) continue
    const models = group.models
    for (const entry of Array.isArray(models) ? models : []) {
      const row = asRecord(entry)
      if (row?.id === model) return String(group.id ?? '')
    }
  }
  throw new Error(`model "${model}" not found in the session model directory`)
}

/**
 * Apply the requested session state before a prompt: the permission preset
 * rides the `/permission <preset>` slash command (never reaches the model),
 * and model/effort ride `session.selectModel`.
 */
async function prepareTurn(
  runtime: AdapterRuntime,
  sessionId: string,
  options: TurnOptions,
): Promise<void> {
  const permission = options.permission
  if (permission !== undefined) {
    if (!PERMISSION_PRESETS.has(permission)) {
      throw new Error(`permission must be one of read-only | workspace-write | danger-full-access, got "${permission}"`)
    }
    const result = await call(runtime.gateway, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `/permission ${permission}` }],
    }, 30_000)
    if (!result.ok) throw businessError(result, 'session.prompt (permission command)')
  }
  const model = options.model
  if (model !== undefined) {
    const provider = options.provider ?? await resolveProvider(runtime, sessionId, model)
    const result = await call(runtime.gateway, 'session.selectModel', {
      sessionId,
      provider,
      model,
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    }, 30_000)
    if (!result.ok) throw businessError(result, 'session.selectModel')
  }
}

/** Write one SSE event frame. */
function writeSse(res: ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Best-effort current session title from the history projection baseline. */
async function titleOfSession(runtime: AdapterRuntime, sessionId: string): Promise<string | undefined> {
  try {
    const result = await call(runtime.gateway, 'session.history', { sessionId, maxMessages: 1 }, 10_000)
    if (!result.ok) return undefined
    const title = asRecord(asRecord(asRecord(result.value)?.projections)?.values)?.title
    return typeof title === 'string' && title.trim() !== '' ? title : undefined
  } catch {
    return undefined
  }
}

/** Resolve the working session, adopt it for app-driven approvals, then stream. */
async function streamTurn(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
  requestedSessionId: string | undefined,
  prompt: string,
  options: TurnOptions,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...CORS_HEADERS,
  })
  res.write(`: connected\n\n`)

  let closed = false
  const finish = (): void => {
    if (closed) return
    closed = true
    for (const held of [...runtime.approvals.held.values()]) {
      if (held.sessionId !== currentSessionId) continue
      runtime.approvals.held.delete(held.approvalId)
      held.resolve('cancelled')
    }
    if (currentSessionId !== undefined) runtime.approvals.driven.delete(currentSessionId)
    res.end()
  }
  let currentSessionId: string | undefined
  req.on('close', finish)

  try {
    const { id, beforeSeq } = await resolveSession(runtime, requestedSessionId)
    currentSessionId = id
    await prepareTurn(runtime, id, options)
    runtime.approvals.driven.add(id)
    await sendPrompt(runtime.gateway, id, prompt)

    const deadline = Date.now() + runtime.turnTimeoutMs
    let lastSeq = beforeSeq
    let sentText = 0
    let sentReasoning = 0
    const toolNames = new Map<unknown, unknown>()
    let lastWrite = Date.now()
    const heartbeat = (now: number): void => {
      if (now - lastWrite < 5000) return
      res.write(`: keep-alive\n\n`)
      lastWrite = now
    }

    while (!closed && Date.now() < deadline) {
      const events = await historyTail(runtime.gateway, id)
      const turnEvents = events.filter(event => event.seq > beforeSeq)
      const fresh = turnEvents.filter(event => event.seq > lastSeq)

      const { text, reasoning } = assistantTexts(turnEvents)
      if (text.length > sentText) {
        writeSse(res, 'content', { content: text.slice(sentText) })
        sentText = text.length
        lastWrite = Date.now()
      }
      if (reasoning.length > sentReasoning) {
        writeSse(res, 'reasoning', { content: reasoning.slice(sentReasoning) })
        sentReasoning = reasoning.length
        lastWrite = Date.now()
      }

      let ended = false
      let endStatus = 'completed'
      for (const event of fresh) {
        if (event.type === 'tool/call') {
          const data = asRecord(event.data) ?? {}
          toolNames.set(data.callId, data.name)
          writeSse(res, 'tool_start', { id: data.callId, tool: data.name, input: data.arguments })
          lastWrite = Date.now()
        } else if (event.type === 'tool/result') {
          const data = asRecord(event.data) ?? {}
          const content = asRecord(data.message)?.content
          const first = Array.isArray(content) ? content[0] : undefined
          const block = asRecord(first)
          const callId = block?.toolCallId
          writeSse(res, 'tool_end', {
            id: callId,
            tool: toolNames.get(callId),
            output: block === undefined ? '' : toolResultText(block, runtime.maxToolResultChars),
            status: data.error !== undefined || block?.isError === true ? 'error' : 'success',
          })
          lastWrite = Date.now()
        } else if (event.type === 'approval/asked') {
          const data = asRecord(event.data) ?? {}
          writeSse(res, 'waiting_approval', { approvalId: data.id, tool: data.toolName })
          lastWrite = Date.now()
        } else if (event.type === 'approval/decided') {
          const data = asRecord(event.data) ?? {}
          writeSse(res, 'approval_resolved', { approvalId: data.id, outcome: data.outcome })
          lastWrite = Date.now()
        } else if (event.type === 'turn/end') {
          const reason = asRecord(event.data)
          const kind = reason?.kind
          endStatus = kind === 'completed' ? 'completed' : kind === 'error' ? 'error' : kind === 'aborted' ? 'aborted' : String(kind ?? 'completed')
          ended = true
        }
      }
      if (fresh.length > 0) {
        const last = fresh[fresh.length - 1]
        if (last !== undefined) lastSeq = last.seq
      }
      if (ended) {
        const done: Record<string, unknown> = { sessionId: id, status: endStatus }
        const title = await titleOfSession(runtime, id)
        if (title !== undefined) done.title = title
        writeSse(res, 'done', done)
        finish()
        return
      }
      heartbeat(Date.now())
      await sleep(runtime.pollIntervalMs)
    }
    if (!closed) {
      writeSse(res, 'done', { sessionId: id, status: 'timeout' })
      finish()
    }
  } catch (error) {
    if (!closed) {
      writeSse(res, 'error', { message: error instanceof Error ? error.message : String(error) })
      finish()
    }
  }
}

/** Answer one prompt route: sync JSON, or SSE when stream is requested. */
async function handlePromptRoute(
  res: ServerResponse,
  runtime: AdapterRuntime,
  body: Record<string, unknown>,
): Promise<void> {
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  if (prompt === undefined || prompt.trim() === '') {
    sendJson(res, 400, errorBody('bad-request', 'prompt must be a non-empty string'))
    return
  }
  const options = turnOptionsOf(body)
  try {
    const { sessionId: id, outcome } = await runPrompt(runtime, prompt, sessionId, options)
    const fields = turnResultFields(outcome, runtime.turnTimeoutMs)
    const result: Record<string, unknown> = {
      status: fields.status,
      result: outcome.collected,
      sessionId: id,
      choices: [{ message: { role: 'assistant', content: outcome.collected } }],
    }
    if (fields.error !== undefined) result.error = fields.error
    if (fields.status === 'error' && !outcome.completed && outcome.collected === '') {
      sendJson(res, 504, result)
      return
    }
    sendJson(res, 200, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, errorBody('upstream-error', message))
  }
}

/** POST /v1/agent/prompt/stream — SSE turn stream with heartbeats. */
async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    rejectMethod(res, req.method, 'POST')
    return
  }
  let body: unknown
  try {
    body = await parseJson(req, runtime.maxBodyBytes)
  } catch (error) {
    sendJson(res, 400, errorBody('bad-request', error instanceof Error ? error.message : String(error)))
    return
  }
  const record = asRecord(body) ?? {}
  const prompt = typeof record.prompt === 'string' ? record.prompt : ''
  if (prompt.trim() === '') {
    sendJson(res, 400, errorBody('bad-request', 'prompt must be a non-empty string'))
    return
  }
  const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
  await streamTurn(req, res, runtime, sessionId, prompt, turnOptionsOf(record))
}

/** GET /v1/models — provider model catalog with reasoning-effort metadata. */
async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'GET') {
    rejectMethod(res, req.method, 'GET')
    return
  }
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    const sessionId = url.searchParams.get('sessionId')
    let result: RpcResult
    if (sessionId !== null && sessionId !== '') {
      result = await call(runtime.gateway, 'session.models', { sessionId }, 30_000)
    } else {
      result = await call(runtime.gateway, 'llm.models', {}, 30_000)
    }
    if (!result.ok) throw businessError(result, 'models')
    const value = asRecord(result.value) ?? {}
    const groups = Array.isArray(value.groups) ? value.groups : []
    const failures = Array.isArray(value.failures) ? value.failures : []
    const models: Record<string, unknown>[] = []
    for (const raw of groups) {
      const group = asRecord(raw)
      if (group === undefined) continue
      for (const entry of Array.isArray(group.models) ? group.models : []) {
        const model = asRecord(entry)
        if (model === undefined) continue
        const reasoning = asRecord(model.reasoning)
        const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
        models.push({
          id: model.id,
          name: model.name,
          provider: group.id,
          ...(typeof model.description === 'string' ? { description: model.description } : {}),
          supportsReasoningEffort: reasoning !== undefined && efforts.length > 0,
          reasoningEfforts: efforts.flatMap(rawEffort => {
            const effort = asRecord(rawEffort)
            return typeof effort?.id === 'string' ? [effort.id] : []
          }),
          ...(typeof reasoning?.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}),
        })
      }
    }
    const response: Record<string, unknown> = { status: 'success', models, failures }
    if (value.current !== undefined) {
      const current = asRecord(value.current)
      if (current !== undefined) {
        response.current = {
          provider: current.provider,
          model: current.model,
          ...(typeof current.reasoningEffort === 'string' ? { reasoningEffort: current.reasoningEffort } : {}),
        }
      }
    }
    sendJson(res, 200, response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, errorBody('upstream-error', message))
  }
}

/** POST /v1/sessions/:id/abort — cancel the session's active turn. */
async function abortSession(runtime: AdapterRuntime, sessionId: string): Promise<void> {
  const result = await call(runtime.gateway, 'session.cancel', { sessionId }, 30_000)
  if (!result.ok) throw businessError(result, 'session.cancel')
}

/** POST /v1/agent/abort — alias abort by body { sessionId }. */
async function handleAbortAlias(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AdapterRuntime,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    rejectMethod(res, req.method, 'POST')
    return
  }
  let body: unknown
  try {
    body = await parseJson(req, runtime.maxBodyBytes)
  } catch (error) {
    sendJson(res, 400, errorBody('bad-request', error instanceof Error ? error.message : String(error)))
    return
  }
  const rawSessionId = asRecord(body)?.sessionId
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined
  if (sessionId === undefined || sessionId === '') {
    sendJson(res, 400, errorBody('bad-request', 'sessionId is required'))
    return
  }
  try {
    await abortSession(runtime, sessionId)
    sendJson(res, 200, { status: 'success', sessionId, aborted: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, errorBody('upstream-error', message))
  }
}

/** POST /v1/sessions/:id/approve — answer one app-held approval. */
async function approveSession(
  runtime: AdapterRuntime,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined
  const rawAction = body.action ?? body.outcome
  const action = typeof rawAction === 'string' ? rawAction.trim().toLowerCase() : undefined
  let outcome: ApprovalOutcome | undefined
  if (action === 'allow' || action === 'approve' || action === 'approved' || action === 'allowed-once' || action === 'yes') {
    outcome = 'allowed-once'
  } else if (action === 'deny' || action === 'reject' || action === 'rejected' || action === 'no') {
    outcome = 'rejected'
  }
  if (approvalId === undefined || outcome === undefined) {
    throw new Error('approvalId and action ("allow" | "deny") are required')
  }
  const held = runtime.approvals.held.get(approvalId)
  if (held === undefined) {
    throw new Error(`no pending approval "${approvalId}" (it may already be decided or expired)`)
  }
  if (held.sessionId !== sessionId) {
    throw new Error(`approval "${approvalId}" belongs to another session`)
  }
  runtime.approvals.held.delete(approvalId)
  held.resolve(outcome)
}

/**
 * Mount the REST routes on the existing web server. The /api prefix stays
 * untouched (owned by the browser transport), so the OpenAI-style and prompt
 * routes live under /v1 with /health as the probe.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: Config): void {
  const approvals: ApprovalBridge = {
    driven: new Set<string>(),
    held: new Map<string, HeldApproval>(),
  }
  const runtime: AdapterRuntime = {
    gateway: toFetchHandler(ctx.apiProxy),
    loader: ctx.loader,
    approvals,
    turnTimeoutMs: config?.turnTimeoutMs ?? 600_000,
    pollIntervalMs: config?.pollIntervalMs ?? 500,
    maxBodyBytes: config?.maxBodyBytes ?? 10 * 1024 * 1024,
    defaultToolLimit: config?.defaultToolLimit ?? 50,
    maxToolLimit: config?.maxToolLimit ?? 500,
    maxToolResultChars: config?.maxToolResultChars ?? 2000,
  }

  // App-driven approvals: runs BEFORE the browser answerer (api-proxy) and
  // owns every ask for sessions the phone app is currently streaming, so the
  // app can answer through /v1/sessions/:id/approve. Everything else falls
  // through to the browser's approval dialog unchanged.
  ctx.on('approval/request', (request, next) => {
    const sessionId = String(request.agent.session.id)
    if (!approvals.driven.has(sessionId)) return next()
    // Claim the newest undecided approval/asked event for this exact ask,
    // mirroring the api-proxy answerer's pairing walk.
    const events = request.agent.session.events
    const heldIds = new Set(approvals.held.keys())
    const decided = new Set<string>()
    let approvalId: string | undefined
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const record = asRecord(events[index])
      const type = record?.type
      const data = asRecord(record?.data)
      if (type === 'approval/decided') {
        decided.add(String(data?.id ?? ''))
      } else if (type === 'approval/asked') {
        const id = String(data?.id ?? '')
        if (decided.has(id) || heldIds.has(id)) continue
        if ((request.callId ?? null) !== (data?.callId ?? null)) continue
        approvalId = id
        break
      }
    }
    if (approvalId === undefined) return next()
    return new Promise<ApprovalOutcome>((resolve) => {
      approvals.held.set(approvalId, {
        sessionId,
        approvalId,
        toolName: request.toolName,
        resolve,
      })
      request.signal?.addEventListener('abort', () => {
        if (approvals.held.delete(approvalId)) resolve('cancelled')
      }, { once: true })
    })
  }, { prepend: true })

  const routes: WebRoute[] = [
    { kind: 'exact', path: '/health', handler: (req, res) => handleHealth(req, res) },
    { kind: 'exact', path: '/v1/chat/completions', handler: (req, res) => handleCompletion(req, res, runtime) },
    { kind: 'exact', path: '/v1/agent/prompt', handler: (req, res) => handlePrompt(req, res, runtime) },
    { kind: 'exact', path: '/v1/agent/prompt/stream', handler: (req, res) => handleStream(req, res, runtime) },
    { kind: 'exact', path: '/v1/agent/abort', handler: (req, res) => handleAbortAlias(req, res, runtime) },
    { kind: 'exact', path: '/v1/models', handler: (req, res) => handleModels(req, res, runtime) },
    { kind: 'exact', path: '/v1/sessions', handler: (req, res) => handleSessions(req, res, runtime) },
    { kind: 'prefix', path: '/v1/sessions', handler: (req, res) => handleSessionsPrefix(req, res, runtime) },
    { kind: 'exact', path: '/v1/plugins', handler: (req, res) => handlePlugins(req, res, runtime) },
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register(route), `rest-adapter: ${route.path} route`)
  }
  ctx.logger.info('rest-adapter: mounted /v1 REST control plane (chat, prompts + SSE stream, models, session rename/archive/tools/abort/approve, plugins) plus /health')
}
