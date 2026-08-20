# dsh-subagent-http

English | [中文](README.zh.md)

HTTP subagent provider for DeepSeek Harness — delegates one-shot subagent runs to a remote HTTP endpoint and streams the reply back as `AssistantOutput` (`ContentBlock[]`).

## Install

```sh
# from local checkout (no allowlist step)
dsh plugin --profile <name> add ./plugins/subagent/dsh-subagent-http

# from GitHub (sources, needs allowBuilds)
dsh plugin --profile <name> add github:<owner>/dsh-subagent-http
# first run prints the exact allow key — copy it into
# $DSH_HOME/profiles/<name>/pnpm-workspace.yaml:
# allowBuilds:
#   dsh-subagent-http: true
# then re-run the add

# from npm (prebuilt)
dsh plugin --profile <name> add dsh-subagent-http
```

Verify:

```sh
dsh --profile <name> --dump-config  # shows "# == dsh-subagent-http" layer
```

## How it works

The plugin registers a `SubagentProvider` named `http` on `ctx.subagents` (spec alias `ctx.subagent`). Each `start()` POSTs `{ task, session }` to `endpoint`:

- `task`: text joined from `request.prompt` (`ContentBlock[]`) plus `prompt` (raw blocks)
- `session`: `{ id, cwd, label, descriptor, maxDepth?, outputSchema? }` derived from the parent agent's session

Headers: `content-type: application/json`, `accept: text/event-stream, application/x-ndjson, application/json, text/plain`, and `Authorization: Bearer <token>` when `token` is set.

Streaming response handling (ports `packages/subagent/subagent/src/assistant-output.ts:AssistantOutputFold` semantics):

- `application/json` (non-stream): parses `{ content | message.content | output | result }` as `ContentBlock[]`, else `{ text | output_text | result_text | "<raw>" }` as fallback text; honors `stopReason`/`diagnostic` when present.
- `text/event-stream` / `x-ndjson` / `text/plain` streaming: incremental `ReadableStream` reader split on `\n`; each `data: <json>` or JSON line with `{ text | delta | chunk.text | content | message.content | output }` is folded; plain-text chunks are pushed as `text` deltas. Folding keeps the last non-empty message and otherwise joins text deltas — identical to `AssistantOutputFold.collect()`.

Result settlement: `result` never rejects on child failure — it resolves with `stopReason: 'error'` and a `diagnostic` (≤4096 bytes). Parent `signal` abort yields `stopReason: 'aborted'`; timeout or fetch failure yields `stopReason: 'error'`. `dispose()` aborts the fetch and awaits settlement.

## Configuration

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `endpoint` | `string` | _(required)_ | HTTP(S) URL to POST `{task, session}` to |
| `token` | `string?` | unset | Bearer token for `Authorization` |
| `timeoutMs` | `number` | `60000` | Per-request deadline in ms |

`cordis.patch.yml` default:

```yaml
- insert:
    - id: dsh-subagent-http
      name: dsh-subagent-http
      config:
        endpoint: http://127.0.0.1:8080/run
        timeoutMs: 60000
```

`endpoint` must be a valid `http:`/`https:` URL; `timeoutMs` must be `>=1` (validated at `apply`, loud fail).

## Endpoint contract

Request:

```json
{
  "task": "summarize this repo",
  "prompt": [{ "type": "text", "text": "summarize this repo" }],
  "session": { "id": "sess_...", "cwd": "/work", "label": "explore", "descriptor": { "mode":"one-shot", "provider":"http" } }
}
```

Accepted response shapes (all streamed or single-shot):

- Plain text: `hello world\n...` → `[{ type:"text", text:"hello world\n..." }]`
- JSON: `{ "text": "hello" }` or `{ "content": [{ "type":"text","text":"hello" }] }`
- SSE: `data: {"text":"hello "}\ndata: {"text":"world"}\n`
- NDJSON: `{"delta":"hello "}\n{"delta":"world"}\n`

## Capability

`capabilities = { outputSchema:false, depthLimit:false, toolFilter:false, persona:false }`, `inheritsParentContext = false` — an HTTP child starts fresh and does not inherit parent context or tool filters, consistent with out-of-process providers (`subagent-acp`, `subagent-fork-in-process`).

## Events

Provider registration emits `subagent/provider-added` / `subagent/provider-removed` via `ctx.subagents.registerProvider` (effect-scoped). Run lifecycle still emits `subagent/start` / `subagent/end` through the seam's `LifecycleEmitter`.

## Upstream tracker

Seam reference: `deepseek-harness/packages/subagent/subagent/src/index.ts:SubagentRuntime` + `types.ts:SubagentProvider` + `assistant-output.ts:AssistantOutputFold`. Report provider issues to this repository; report seam issues to `deepseek-ai/deepseek-harness`.

## Versions

- deepseek-harness `0.1.0-rc.8` (also `^0.1.0-rc.7` peer range)
- Node `>=22`
- `@deepseek-ai/cordis ^4.0.1`, `@deepseek-ai/schemastery ^3.18.1`
