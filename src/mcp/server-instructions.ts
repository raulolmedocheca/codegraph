/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't grep when codegraph_search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file
in the workspace. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher. Consult it BEFORE writing or
editing code, not during.

## Tool selection by intent

- **"What is the symbol named X?"** → \`codegraph_search\`
- **"What's the deal with this task / feature / area?"** → \`codegraph_context\` (PRIMARY — composes search + node + callers + callees in one call)
- **"What calls this?"** → \`codegraph_callers\`
- **"What does this call?"** → \`codegraph_callees\`
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\`
- **"Survey an unfamiliar topic / pattern / module."** → \`codegraph_explore\` (heavier; deep dive)
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`

## Common chains

- **Onboarding**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

## Anti-patterns

- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one round-trip.
- **Don't use \`codegraph_explore\` for narrow questions** — it's a multi-call deep dive, expensive in tokens. Save it for genuine "I'm new here" surveys.
- **Don't query the index immediately after editing a file** — the watcher needs ~500ms to debounce + sync. Wait for the next turn.

## Swift concurrency & architecture

This index captures Swift's full concurrency and architecture model.
Use it BEFORE assuming an actor is a class or a property is unwrapped.

- **Actors** appear with \`kind=actor\`. \`codegraph_search Foo\` returns kind
  directly — if it says \`actor\`, calls to its non-\`nonisolated\` members
  cross an actor boundary.
- **Isolation** is on every symbol's detail view: \`main_actor\`,
  \`global_actor (Name)\`, \`actor\`, \`nonisolated\`, \`nonisolated_unsafe\`.
- **\`Sendable\` conformance** is exposed two ways:
  - On the node: \`Sendable: yes\` or \`Sendable: @unchecked\`.
  - As an edge: \`conforms_to\` targeting the synthetic \`Sendable\` protocol.
    Use \`codegraph_callers Sendable\` to enumerate every conformer.
- **Class inheritance** (\`inherits_from\`) and **protocol conformance**
  (\`conforms_to\`) are distinct edge kinds — don't conflate them. The
  legacy \`extends\` edge is reserved for languages without the
  inheritance/conformance distinction.
- **Property wrappers** (\`@Inject\`, \`@LazyInject\`, SwiftUI \`@State\`,
  \`@Published\`, …) live in \`propertyWrappers\` and emit \`wrapped_by\`
  edges. Use \`codegraph_callees <prop> kinds=wrapped_by\` to see what's
  injecting it; \`codegraph_callers Inject kinds=wrapped_by\` to list
  every injected property.
- **Throws** is on the node (\`throws\` or \`throws(SomeError)\` for
  Swift 6 typed throws); \`rethrows\` is separate.
- **Call-site flags** ride on \`calls\` edge metadata:
  - \`isAwait=true\`           → \`await\` suspension point
  - \`tryKind=plain|optional|forced\` → \`try\` / \`try?\` / \`try!\`
  - \`spawnsTask=true\`        → call to \`Task { }\` / \`Task.detached\` / \`withTaskGroup\`
  - \`asyncIteration=true\`    → call inside \`for await … in …\`
  - \`isolationBoundary=true\` → \`MainActor.run\`, \`assumeIsolated\`,
                                 \`withCheckedContinuation\`, etc.

### Concurrency-aware tool patterns

- **"What conforms to a protocol?"** → \`codegraph_callers <Protocol> kinds=conforms_to\`.
- **"What is the actor isolation of X?"** → \`codegraph_node X\` (read **Isolation**).
- **"What does \`@Inject\` inject for this property?"** → \`codegraph_callees <Property> kinds=wrapped_by\`.
- **"What crosses the main-actor boundary?"** → \`codegraph_search\` symbols with isolation \`main_actor\`, then inspect their \`calls\` edges with \`isAwait=true\`.
- **"Show me all actors / extensions / initializers in module X."** → \`codegraph_search\` with the appropriate \`kind\` filter (\`actor\`, \`extension\`, \`initializer\`).

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
- Swift stdlib types (\`Int\`, \`String\`, \`Foundation\`, \`UIKit\`, …) are recognised as external and won't appear as resolvable nodes; stdlib **protocols** (\`Sendable\`, \`Hashable\`, \`Codable\`, \`Identifiable\`, \`Error\`, \`AsyncSequence\`, …) DO have synthetic nodes so conformances resolve.
`;
