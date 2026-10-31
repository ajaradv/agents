# Codemode audit

Alice has the `codemode` tool (agents/alice/agent.yaml `tools: +codemode`). Audited against
pi-coding-agent and pi-codemode in node_modules/@earendil-works/ on 2026-10-30, for the vault plan
alice-memory-and-tools (M3) before bash can go. No hole found, so no code changed.

## Findings

- **Reach beyond `tools.*` (no).** A script runs as an async function body in a QuickJS VM compiled to
  WebAssembly, inside a worker thread (pi-codemode README, "Nothing else: no timers, `fetch`,
  `process`, `require`, modules, or `WebAssembly`"; pi-coding-agent/dist/extensions/codemode/tool.js
  `DESCRIPTION_INTRO`: "No Node, file system, network, or timers"). `eval` and `Function` only make
  more code inside the same VM. The VM heap is capped (execute.js `CODEMODE_MEMORY_LIMIT_BYTES`). Its only
  host capabilities are the injected tools and globals (execute.js, `new CodemodeSandbox({ tools, globals })`).
- **Which tools a script can call.** `_getCallableTools` (core/agent-session.js): active `direct`
  tools, plus every registered tool whose exposure is `codemode` or `deferred`, active or not. Built-in
  tools (read, write, edit, bash, grep, find, ls) have the default `direct` exposure, so a tool removed
  with `-bash` in agent.yaml `tools:` (bin/launch passes it as `--tools`) is not active and not
  callable. Our own lazy tools (extensions/fleet.ts, `RARE` and `RARE_VAULT` with `FLEET_LAZY_TOOLS=1`)
  are `codemode` exposure on purpose: callable without being declared. Any other extension that
  registers a `codemode`/`deferred` tool makes it callable the same way, so check new extensions for that.
- **The tool gate sees nested calls (yes).** Each nested call goes through `_executeNestedToolCall`,
  which runs `runToolCall` with `beforeToolCall: this._beforeToolCall(context, parentId)`, and that emits
  `tool_call` to the extension runner (core/nested-tool-calls.js header; agent-session.js lines
  ~386-415). extensions/tool-gate.ts therefore judges every nested call, and `codemode` itself is
  listed safe in extensions/tool-gate/rules.ts because of that.
- **`models.*` and other globals.** Registry methods only (execute.js `createModelGlobals`):
  `getModelsOfType`, `getAvailableOfType`, `getModelOfType` (catalog entries without `headers`, which
  can carry credentials), `classify`, and `generateImages`. These call a model on the agent's own
  provider keys, so a script can spend money, but they cannot write files, run commands, or reach a
  network address of its choosing. They are not tool calls, so the gate does not see them; spend shows in
  the usage totals. Other globals: `ALL_TOOLS`, `text`, `image` (data URLs only, remote URLs rejected),
  `exit`, `store`/`load` (JSON kept as session entries), and the discovery globals.

## Not tested

Whether a removed tool stays uncallable depends on a live pi session (`getCallableToolNames()`), which a
unit test here cannot start without a model. Check by hand when bash is removed: a script calling
`tools.bash(...)` must fail with an unknown tool.
