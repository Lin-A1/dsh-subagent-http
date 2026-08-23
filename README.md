# dsh-subagent-http

English | [中文](README.zh.md)

HTTP subagent provider for DeepSeek Harness — delegates one-shot subagent runs to a remote HTTP endpoint and streams the reply back as `AssistantOutput` (`ContentBlock[]`).

## Capability

`capabilities = { outputSchema:false, depthLimit:false, toolFilter:false, persona:false }`, `inheritsParentContext = false` — an HTTP child starts fresh and does not inherit parent context or tool filters, consistent with out-of-process providers (`subagent-acp`, `subagent-fork-in-process`).

The plugin registers a `SubagentProvider` named `http` on `ctx.subagents` (spec alias `ctx.subagent`). Each `start()` POSTs `{ task, session }` to `endpoint` and folds streaming chunks via `AssistantOutputFold` semantics.

## Config

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

## Events

Provider registration emits `subagent/provider-added` / `subagent/provider-removed` via `ctx.subagents.registerProvider` (effect-scoped). Run lifecycle still emits `subagent/start` / `subagent/end` through the seam's `LifecycleEmitter`. No custom session events.

## Install

Verified with a fresh profile `tmp` (AGENTS.md:112). All three paths build `lib/` via `prepare`, emit no `dsh plugin` warning, and appear in `dsh --dump-config`.

```sh
# GitHub (source, needs allowBuilds on first install)
dsh plugin --profile tmp add github:Lin-A1/dsh-subagent-http
# pin to a commit for trusted installs
dsh plugin --profile tmp add github:Lin-A1/dsh-subagent-http#<sha>

# npm (prebuilt lib/, no allowBuilds)
dsh plugin --profile tmp add dsh-subagent-http

# local (from dsh-hub root)
dsh plugin --profile tmp add ./plugins/subagent/dsh-subagent-http
```

First GitHub install prints the exact `allowBuilds` key. Copy it into `$DSH_HOME/profiles/tmp/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-subagent-http: true
```

then re-run the `add`.

Verify:

```sh
dsh --profile tmp --dump-config  # must contain "# == dsh-subagent-http" layer
```

### How it works

Headers: `content-type: application/json`, `accept: text/event-stream, application/x-ndjson, application/json, text/plain`, and `Authorization: Bearer <token>` when `token` is set.

Streaming handling (ports `packages/subagent/subagent/src/assistant-output.ts:AssistantOutputFold`):

- `application/json` (non-stream): parses `{ content | message.content | output | result }` as `ContentBlock[]`, else `{ text | output_text | result_text | "<raw>" }` as fallback text; honors `stopReason`/`diagnostic`.
- `text/event-stream` / `x-ndjson` / `text/plain` streaming: incremental `ReadableStream` reader split on `\n`; each `data: <json>` or JSON line with `{ text | delta | chunk.text | content | message.content | output }` is folded; plain-text chunks are pushed as `text` deltas.

Result settlement: `result` never rejects on child failure — it resolves with `stopReason: 'error'` and a `diagnostic` (≤4096 bytes). Parent `signal` abort yields `stopReason: 'aborted'`; timeout or fetch failure yields `stopReason: 'error'`. `dispose()` aborts the fetch and awaits settlement.

### Endpoint contract

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

## Versions

- deepseek-harness `0.1.0-rc.8` (also `^0.1.0-rc.7` peer range, compatible with `0.1.1-rc.2`)
- Node `>=22`
- `@deepseek-ai/cordis ^4.0.1`, `@deepseek-ai/schemastery ^3.18.1`
- `@deepseek-ai/dsh-subagent ^0.1.0-rc.7` (peer+dev)

## Upstream tracker

- Seam: `deepseek-harness/packages/subagent/subagent/src/index.ts:SubagentRuntime` + `types.ts:SubagentProvider` + `assistant-output.ts:AssistantOutputFold`.
- Plugin repo: `https://github.com/Lin-A1/dsh-subagent-http` (`master`, submodule `plugins/subagent/dsh-subagent-http` in `dsh-hub`).
- Harness upstream: `https://github.com/deepseek-ai/deepseek-harness` `branch = master`.
- Example: `packages/subagent/subagent-acp` and `subagent-fork-in-process` for isolated provider reference.
