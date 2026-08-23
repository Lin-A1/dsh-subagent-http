# AGENTS.md — dsh-subagent-http

Plugin-local conventions for the HTTP subagent provider.

## Scope

- Runtime: Node `>=22`, host fiber only. No web `lib/client.js` face.
- Loader contract: named exports `name` / `inject` / `Config` / `apply` only — no `default` export. `inject = ['subagents']` (matches real seam `super(ctx,'subagents')`; runtime resolves `ctx.subagents ?? ctx.subagent ?? ctx.get('subagents') ?? ctx.get('subagent')` fallback for compatibility). Registrations are effects: `ctx.effect` → `runtime.registerProvider`; dispose unregisters.
- Peer correctness: `@deepseek-ai/cordis` in **both** `peerDependencies` and `devDependencies` same range (`^4.0.1`); `@deepseek-ai/dsh-subagent` peer+dev for the `SubagentProvider` type; `@deepseek-ai/schemastery` in `dependencies`. Duplicate Cordis check via single instance.

## Repository shape invariants

- `package.json`: `name: dsh-subagent-http`, `private: true`, `type: module`, `main: lib/index.js`, `types: lib/index.d.ts`, `exports["."]` typed, `files: [lib/, cordis.patch.yml, README.md, AGENTS.md]`, `dsh.bundle.patch: ./cordis.patch.yml`, scripts `build` (`tsdown`), `prepare` (`pnpm run build`), `typecheck` (`tsc --noEmit`), `lint`. `pnpm-workspace.yaml` is plugin-local (`packages: [.]`), never merged into `dsh-hub` or `deepseek-harness`.
- `cordis.patch.yml`: single `- insert` with stable `id: dsh-subagent-http`, `name: dsh-subagent-http`, config keys `endpoint`/`timeoutMs` matching `Config` defaults.
- `tsdown.config.ts`: `entry ['src/index.ts']`, `format ['esm']`, `platform node`, `dts true`, `outDir lib`.
- `tsconfig.json`: extends base via `module NodeNext`, `strict true`, `noEmit true`, `allowImportingTsExtensions` for `tsdown` ESM build.

## Design choices

- Provider `http`: `capabilities = { outputSchema:false, depthLimit:false, toolFilter:false, persona:false }`, `inheritsParentContext = false` — remote child starts fresh, no parent context/tool scoping.
- `start()` mints remote `SessionId` as `${parent.session.id}::http::${ts36}-${rand}`; `localAgent: undefined` (remote). `result` is the fetch settlement promise; `dispose()` aborts the `AbortController` (composed from `request.signal` + `timeoutMs`) and awaits `result`.
- POST `endpoint` `{ task, session }` where `task = blocksToText(prompt)` and `session = { id, cwd, label, descriptor }`. Headers include `Authorization: Bearer <token>` when set. Timeout via `setTimeout` → `abort(TimeoutError)`, parent abort forwarded.
- Streaming fold mirrors `assistant-output.ts:AssistantOutputFold`: `StreamFold` keeps `message` last-wins and `partial` text join; `foldChunk` handles SSE `data:`, ndjson JSON lines (`text`/`delta`/`chunk.text`/`content`/`message.content`/`output`) and plain-text fallback. Non-stream JSON shortcut parses `content`/`text`/`stopReason`/`diagnostic`. Output caps follow seam: `diagnostic` sliced to 4096 bytes; `result` never rejects on child error (`stopReason: 'error'`), parent abort is `aborted`.
- Validation at `apply` (loud fail): `endpoint` non-empty valid `http(s)` URL, `timeoutMs` finite `>=1`. Runtime availability checked via `ctx.subagents ?? ctx.subagent ?? ctx.get('subagents') ?? ctx.get('subagent')` (real seam first, alias fallback).

## Testing & verification before hub PR

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm test  # --passWithNoTests
```

Then `dsh plugin add ./plugins/subagent/dsh-subagent-http` against a fresh profile on `deepseek-harness 0.1.0-rc.8` must install cleanly (prepare builds `lib/`) and show `dsh-subagent-http` layer in `dsh --dump-config`. Runtime check: point `endpoint` at a stub server returning `text/plain` or `data: {"text":"hello"}` SSE and verify a subagent delegation returns `[{type:"text",text:"hello"}]` with `stopReason: completed`.

## References

- Seam: `deepseek-harness/packages/subagent/subagent/src/index.ts:SubagentRuntime` + `types.ts:SubagentProvider` + `assistant-output.ts`
- Out-of-process example: `packages/subagent/subagent-acp/src/index.ts`
- In-process example: `packages/subagent/subagent-fork-in-process/src/index.ts`
