/**
 * HTTP subagent provider for DeepSeek Harness. Delegates each one-shot child
 * to a remote HTTP endpoint via `POST {task, session}` and streams the reply
 * back into the canonical {@link AssistantOutput}-compatible {@link ContentBlock} output.
 * @module dsh-subagent-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'dsh-subagent-http'
export const inject = ['subagents']

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** HTTP subagent provider configuration. */
export interface Config {
  /** Remote HTTP endpoint that handles subagent tasks. */
  endpoint: string
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string
  /** Per-request timeout in milliseconds (default 60000). */
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  token: z.string().required(false),
  timeoutMs: z.number().step(1).min(1).default(60000),
})

// ---------------------------------------------------------------------------
// Helpers: task / session serialization + streaming fold
// ---------------------------------------------------------------------------

type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(b => {
      if (b.type === 'text') return (b as { text: string }).text
      if (b.type === 'image') return '[image]'
      return JSON.stringify(b)
    })
    .join('\n')
}

function sessionPayload(req: ResolvedSubagentStartRequest): Record<string, unknown> {
  const s: Record<string, unknown> = {
    id: req.parent.session.id,
    cwd: (req.parent.session.header as { cwd?: string }).cwd,
    label: req.label,
    descriptor: req.descriptor,
  }
  if (req.maxDepth !== undefined) s['maxDepth'] = req.maxDepth
  if (req.outputSchema !== undefined) s['outputSchema'] = req.outputSchema
  return s
}

/**
 * Minimal fold mirroring `AssistantOutputFold` from `@deepseek-ai/dsh-subagent`.
 * Keeps the last non-empty `assistant/message` and falls back to streamed text.
 */
class StreamFold {
  private message: ContentBlock[] | undefined
  private partial: string[] = []

  pushText(text: string): void {
    if (text.length > 0) this.partial.push(text)
  }

  pushMessage(content: ContentBlock[]): void {
    if (content.length > 0) this.message = content
  }

  collect(): ContentBlock[] | undefined {
    if (this.message !== undefined) return this.message
    const text = this.partial.join('')
    return text.length > 0 ? [{ type: 'text', text } as ContentBlock] : undefined
  }
}

function tryParseJson(line: string): unknown | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('data:')) {
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return undefined
    try { return JSON.parse(payload) } catch { return payload }
  }
  try { return JSON.parse(trimmed) } catch { return undefined }
}

function foldChunk(fold: StreamFold, raw: string): void {
  // SSE or ndjson lines
  const lines = raw.split('\n')
  let consumedJson = false
  for (const line of lines) {
    const parsed = tryParseJson(line)
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>
      // { type: "text-delta", text: "..." }  |  { delta: "..." }  |  { chunk: { type:"text-delta", text }}
      const text =
        (obj['text'] as string | undefined) ??
        (obj['delta'] as string | undefined) ??
        ((obj['chunk'] as Record<string, unknown> | undefined)?.['text'] as string | undefined) ??
        ((obj['data'] as Record<string, unknown> | undefined)?.['text'] as string | undefined)
      if (typeof text === 'string') {
        fold.pushText(text)
        consumedJson = true
        continue
      }
      // { content: ContentBlock[] } | { message: { content } } | { output: ContentBlock[] }
      const content =
        (obj['content'] as ContentBlock[] | undefined) ??
        ((obj['message'] as Record<string, unknown> | undefined)?.['content'] as ContentBlock[] | undefined) ??
        (obj['output'] as ContentBlock[] | undefined)
      if (Array.isArray(content)) {
        fold.pushMessage(content)
        consumedJson = true
        continue
      }
      // { text: "..." } already handled; fallback treat as stringified
    }
  }
  if (!consumedJson && raw.length > 0) {
    // plain text streaming (no JSON envelope)
    // avoid double-counting SSE lines that were non-JSON text
    const isSseLike = raw.includes('data:')
    if (!isSseLike) fold.pushText(raw)
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class HttpSubagentProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  readonly inheritsParentContext = false

  constructor(
    name: string,
    private readonly config: ResolvedConfig,
  ) {
    this.name = name
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const runId = `${request.parent.session.id}::http::${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as SessionId
    const abort = new AbortController()
    const onParentAbort = (): void => abort.abort((request.signal as unknown as { reason?: unknown })?.reason)
    if (request.signal.aborted) abort.abort((request.signal as unknown as { reason?: unknown })?.reason)
    else request.signal.addEventListener('abort', onParentAbort, { once: true })

    const timeout = setTimeout(() => abort.abort(new DOMException('timeout', 'TimeoutError')), this.config.timeoutMs)

    // Build POST body: { task, session }
    const taskText = blocksToText(request.prompt)
    const body = JSON.stringify({
      task: taskText,
      // also send structured prompt blocks for richer endpoints
      prompt: request.prompt,
      session: sessionPayload(request),
    })

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/x-ndjson, application/json, text/plain, */*',
    }
    if (this.config.token) headers['authorization'] = `Bearer ${this.config.token}`

    let settled = false
    const cleanup = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', onParentAbort)
    }

    const resultPromise: Promise<SubagentResult> = (async (): Promise<SubagentResult> => {
      try {
        const res = await fetch(this.config.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: abort.signal,
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`http subagent endpoint ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`)
        }

        const fold = new StreamFold()
        const ct = res.headers.get('content-type') ?? ''

        // JSON non-streaming shortcut
        if (ct.includes('application/json') && !ct.includes('ndjson') && !ct.includes('event-stream')) {
          const text = await res.text()
          // try to parse as structured output
          try {
            const json = JSON.parse(text) as Record<string, unknown>
            const content =
              (json['content'] as ContentBlock[] | undefined) ??
              ((json['message'] as Record<string, unknown> | undefined)?.['content'] as ContentBlock[] | undefined) ??
              (json['output'] as ContentBlock[] | undefined) ??
              (json['result'] as ContentBlock[] | undefined)
            if (Array.isArray(content) && content.length > 0) fold.pushMessage(content)
            else {
              const t = (json['text'] as string | undefined) ?? (json['output_text'] as string | undefined) ?? (json['result_text'] as string | undefined)
              if (typeof t === 'string' && t.length > 0) fold.pushText(t)
              else if (text.trim().length > 0) fold.pushText(text)
            }
            // diagnostic / stopReason passthrough
            const stopReason = typeof json['stopReason'] === 'string' ? (json['stopReason'] as SubagentResult['stopReason']) : undefined
            const diagnostic = typeof json['diagnostic'] === 'string' ? json['diagnostic'] : undefined
            const output = fold.collect() ?? []
            cleanup()
            return {
              output,
              stopReason: stopReason ?? 'completed',
              ...(diagnostic !== undefined ? { diagnostic } : {}),
            }
          } catch {
            fold.pushText(text)
          }
        } else {
          // streaming body
          if (!res.body) {
            const text = await res.text().catch(() => '')
            if (text) fold.pushText(text)
          } else {
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              const chunk = decoder.decode(value, { stream: true })
              buf += chunk
              // process line-delimited JSON / SSE incrementally, but also handle plain text chunks directly
              // split on newline for structured lines; if no newline, still fold as text chunk
              if (buf.includes('\n')) {
                const lines = buf.split('\n')
                buf = lines.pop() ?? ''
                for (const line of lines) foldChunk(fold, line + '\n')
              } else {
                // for plain text streaming without newlines, push incrementally
                // detect JSON lines vs text by trying parse; if not JSON, treat as text delta
                const maybeJson = tryParseJson(buf)
                if (maybeJson !== undefined && typeof maybeJson === 'object') {
                  foldChunk(fold, buf)
                  buf = ''
                } else if (buf.length > 1024) {
                  // flush large plain-text buffer to avoid unbounded growth
                  fold.pushText(buf)
                  buf = ''
                }
              }
            }
            if (buf.length > 0) foldChunk(fold, buf)
            // flush remaining decoder
            const tail = decoder.decode()
            if (tail) fold.pushText(tail)
          }
        }

        const output = fold.collect() ?? []
        cleanup()
        return { output, stopReason: 'completed' }
      } catch (err) {
        cleanup()
        const e = err as Error & { name?: string }
        if (abort.signal.aborted || e.name === 'AbortError' || e.name === 'TimeoutError') {
          const reason = (abort.signal as unknown as { reason?: unknown })?.reason
          const abortedByParent = request.signal.aborted
          // parent abort maps to aborted stopReason; timeout/other abort maps to error
          if (abortedByParent) return { output: [], stopReason: 'aborted', diagnostic: String(reason ?? e.message).slice(0, 4096) }
          return { output: [], stopReason: 'error', diagnostic: `http subagent aborted: ${String(e.message).slice(0, 4096)}` }
        }
        return { output: [], stopReason: 'error', diagnostic: String(e.message).slice(0, 4096) }
      }
    })()

    const run: SubagentRun = {
      id: runId,
      localAgent: undefined,
      result: resultPromise,
      async dispose(): Promise<void> {
        cleanup()
        abort.abort(new DOMException('disposed', 'AbortError'))
        try { await resultPromise } catch { /* settlement via result, not throw */ }
      },
    }
    return run
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Register the HTTP subagent provider on `ctx.subagents` (real seam
 * `super(ctx,'subagents')`, with `ctx.subagent` fallback for compatibility).
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (typeof resolved.endpoint !== 'string' || resolved.endpoint.trim().length === 0) {
    throw new Error('dsh-subagent-http: endpoint must be a non-empty string')
  }
  try {
    const u = new URL(resolved.endpoint)
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
  } catch {
    throw new Error(`dsh-subagent-http: endpoint must be a valid http(s) URL: ${resolved.endpoint}`)
  }
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs < 1) {
    throw new Error('dsh-subagent-http: timeoutMs must be a positive finite number')
  }

  // inject = ['subagents'] matches the real seam `super(ctx,'subagents')`;
  // keep `ctx.subagent` / `ctx.get('subagent')` fallback for compatibility
  // with older specs / aliases.
  const getRuntime = (): { registerProvider: (p: SubagentProvider) => () => void } => {
    const anyCtx = ctx as unknown as Record<string, unknown>
    const runtime =
      (anyCtx['subagents'] as { registerProvider?: (p: SubagentProvider) => () => void } | undefined) ??
      (anyCtx['subagent'] as { registerProvider?: (p: SubagentProvider) => () => void } | undefined) ??
      (typeof (ctx as unknown as { get?: (k: string) => unknown }).get === 'function'
        ? ((ctx as unknown as { get: (k: string) => unknown }).get('subagents') as { registerProvider?: (p: SubagentProvider) => () => void } | undefined) ??
          ((ctx as unknown as { get: (k: string) => unknown }).get('subagent') as { registerProvider?: (p: SubagentProvider) => () => void } | undefined)
        : undefined)
    if (!runtime || typeof runtime.registerProvider !== 'function') {
      throw new Error('dsh-subagent-http: subagent runtime not available — requires @deepseek-ai/dsh-subagent (ctx.subagents)')
    }
    return runtime as { registerProvider: (p: SubagentProvider) => () => void }
  }

  const provider = new HttpSubagentProvider('http', resolved)
  ctx.effect(() => {
    const runtime = getRuntime()
    return runtime.registerProvider(provider as unknown as SubagentProvider)
  }, 'dsh-subagent-http.registerProvider()')
}
