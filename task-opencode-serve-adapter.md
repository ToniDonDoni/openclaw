# OpenCode Serve ACP Adapter

## Task

Add a new isolated ACP adapter inside `extensions/acpx` that talks to a running `opencode serve` instance over HTTP.

Constraints:

- keep all product changes scoped to the adapter area
- do not touch ACP manager/core protocol plumbing
- prefer tests first and keep the diff localized

## Plan

- add a new raw agent id for `acpx` that resolves to a local ACP agent command
- implement the ACP agent command as a thin bridge to `opencode serve`
- cover session creation, prompt forwarding, and model/provider config in tests
- run targeted tests and a live smoke check

## Progress

- branch/worktree created
- extension point identified in `extensions/acpx`
- added a local `opencode-serve` raw agent mapping in `extensions/acpx`
- added `opencode-serve-agent.mjs` as a thin ACP bridge over `opencode serve`
- added focused tests for agent-command resolution, adapter session/prompt flow, and local runtime wiring
- verified the bridge against a live local `opencode serve` on `127.0.0.1:4096`
- addressed review feedback:
  - removed mutable per-session provider/model config so adapter model binding is stable across reloads
  - restored MCP proxy wrapping for `opencode-serve` when `mcpServers` are configured
  - made unsupported config updates fail explicitly instead of silently no-oping

## Verification

- `pnpm exec vitest run --config vitest.extensions.config.ts extensions/acpx/src/runtime-internals/mcp-agent-command.test.ts extensions/acpx/src/runtime-internals/opencode-serve-agent.test.ts extensions/acpx/src/runtime.local-agent.test.ts`
  - passed, `3` files / `18` tests
- live smoke:
  - `OpenCodeServeAgent.newSession()` succeeded against the running server
  - `OpenCodeServeAgent.prompt()` returned `stopReason: "end_turn"`
  - emitted `agent_thought_chunk` and `agent_message_chunk` updates from the real response
- note:
  - the large existing `extensions/acpx/src/runtime.test.ts` harness did not finish cleanly in this environment when run in isolation, so the new coverage is anchored in the focused resolver/agent tests above plus the live smoke check

## Review

- reviewer findings recorded and addressed
- findings summary:
  - durability risk from mutable per-session provider/model config
  - missing MCP proxy wrapping for the new local adapter path
  - silent success for unsupported config updates
- resolution:
  - adapter now uses fixed instance-level provider/model binding
  - runtime now wraps the local adapter in `mcp-proxy.mjs` whenever MCP servers are configured
  - unsupported config updates now throw explicitly
- final re-review result:
  - no remaining findings in the reviewed file set

## Final Status

Ready to commit.
