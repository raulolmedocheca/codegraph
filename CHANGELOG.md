# Changelog

All notable changes to CodeGraph are documented here. Each entry also ships as
a [GitHub Release](https://github.com/colbymchenry/codegraph/releases) tagged
`vX.Y.Z`, which is where most people will look.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.9-webel.1] — Webel Fork — Swift Concurrency Support

Private fork of upstream `0.7.9` adding full Swift concurrency and architecture
visibility for the Webel-iOS codebase (actors, `@MainActor`, `Sendable`,
property wrappers, typed throws, await/try call sites, …). Backward-compatible
with the upstream MCP API; non-Swift languages see no behaviour change.

### Added

- **New `NodeKind`s**: `actor`, `extension`, `initializer`, `deinitializer`,
  `subscript`, `operator`.
- **New `EdgeKind`s**: `conforms_to`, `inherits_from`, `wrapped_by`,
  `isolated_to`.
- **New `Node` fields**: `modifiers`, `isActor`, `isOverride`, `isFinal`,
  `isThrowing`, `isRethrowing`, `thrownType`, `isSendable`,
  `isSendableUnchecked`, `isolation` (`{ kind, actor? }`), `conformsTo`,
  `inheritsFrom`, `propertyWrappers`, `whereClause`.
- **Call-site metadata** on `calls` edges: `isAwait`, `tryKind`
  (`plain | optional | forced`), `spawnsTask`, `asyncIteration`,
  `isolationBoundary`.
- **Synthetic Swift stdlib nodes** (`Sendable`, `Hashable`, `Codable`,
  `Identifiable`, `Error`, `AsyncSequence`, …) registered on DB init so
  conformances resolve to real targets.
- **MCP surfacing**: `formatNodeDetails` shows isolation, sendable, throws,
  modifiers, wrappers, conformances, attributes; `formatNodeList` adds
  compact tags (`[@MainActor]`, `[Sendable]`, `[throws]`, `[@Inject]`);
  `formatImpact` summarises concurrency context.
- **Server-instructions Swift section**: explains the model and gives 5
  concrete tool-selection patterns for concurrency / DI queries.
- **24 new tests** in `swift-concurrency.test.ts` covering the full
  feature matrix.

### Changed

- `LanguageExtractor` gains 9 optional hooks: `getModifiers`, `getIsolation`,
  `isThrowing`, `isRethrowing`, `getThrownType`, `isOverride`, `isFinal`,
  `getPropertyWrappers`, `getInheritanceClause`. `classifyClassNode` return
  type widened with `'actor'` and `'extension'`.
- `extractDecoratorsFor` now recognises tree-sitter's `attribute` node type
  (Swift). The matched attribute is searched both as a direct child and
  inside the `modifiers` wrapper.
- `extractInheritance` already supported Swift's `inheritance_specifier`;
  the resolver now promotes `extends` to `conforms_to` (target = protocol)
  or `inherits_from` (target = class/actor) on Swift sources, leaving JVM
  languages on the historic `implements` promotion.
- DB schema v5: 8 new indexable boolean / kind columns on `nodes` plus a
  `metadata_json` blob; `unresolved_refs.metadata` for propagating
  call-site flags.
- Swift extractor (`src/extraction/languages/swift.ts`) fully rewritten
  (83 → 651 lines) with the new hooks, robust attribute-name extraction
  (regex against raw text), `isAsync` / `isThrowing` walking all children
  (not just named) since tree-sitter-swift emits these keywords as
  unnamed terminals.

### Known limitations (tree-sitter-swift grammar)

- `nonisolated(unsafe)` is parsed as a syntax `ERROR`; the
  `nonisolated_unsafe` isolation kind is unreachable until the grammar
  ships support.
- Swift 6 typed throws `throws(SomeError)` parses as `ERROR +
  call_expression`; the `thrownType` field is plumbed through but won't
  be populated for typed throws until the grammar lands.

## [0.7.8] - 2026-05-17

### Fixed
- **opencode**: install actually wires up the MCP server now. v0.7.7 wrote
  `~/.config/opencode/opencode.json`, but opencode reads `opencode.jsonc` by
  default — so the `codegraph` entry never showed up in any opencode session.
  The installer now prefers an existing `.jsonc`, falls back to `.json` when
  only that exists, and creates `.jsonc` for greenfield installs. **Re-run
  `codegraph install --target=opencode` after upgrading** so the entry lands
  in the file opencode actually reads.

### Added
- **opencode**: installer now writes `AGENTS.md` (global
  `~/.config/opencode/AGENTS.md`, local `./AGENTS.md`) with the same
  codegraph usage guidance the other agents already received. Without it,
  opencode's model would call native `Grep` instead of the `codegraph_*`
  tools it could see in its MCP list.
- User comments and formatting in `opencode.jsonc` survive install /
  re-install / uninstall round-trips — surgical edits via `jsonc-parser`
  rather than full-file rewrites.

[0.7.8]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.8

## [0.7.7] - 2026-05-17

### Added
- **Multi-agent installer** (closes [#137](https://github.com/colbymchenry/codegraph/issues/137)).
  `codegraph install` now opens with a multi-select prompt for **Claude Code**,
  **Cursor**, **Codex CLI**, and **opencode** — detected agents are pre-checked.
  Each writes its native MCP config + instructions file (e.g. `~/.cursor/mcp.json`
  + `.cursor/rules/codegraph.mdc`, `~/.codex/config.toml` + `~/.codex/AGENTS.md`,
  `~/.config/opencode/opencode.json`). The runtime MCP server was already
  agent-agnostic; this brings the installer to parity.
- Non-interactive install flags for scripting / CI:
  `--target=<csv|auto|all|none>`, `--location=<global|local>`, `--yes`,
  `--no-permissions`, `--print-config <id>`.
- `codegraph init` now auto-wires project-local agent surfaces for any agent
  configured globally. In practice: Cursor's `.cursor/rules/codegraph.mdc`
  is dropped on `init` so a single global `codegraph install` works in every
  project you open — no per-project re-install needed.

### Fixed
- **Cursor**: globally-installed codegraph reported "not initialized" in every
  workspace because Cursor launches MCP-server subprocesses with the wrong
  working directory and doesn't pass `rootUri` in the MCP initialize call.
  We now inject `--path` into Cursor's MCP args — absolute path for local
  installs, `${workspaceFolder}` for global installs.

### Changed
- Agent-instructions template is now agent-agnostic. The previous template was
  inherited from the Claude-only era and prescribed "spawn an Explore agent" —
  a Claude Code-specific concept that confused Cursor's and Codex's agents and
  caused them to fall back to native grep even with codegraph available. The
  new template adds explicit "trust codegraph results, don't re-verify with
  grep" guidance and a clear tool-by-question matrix. Applies to
  `~/.claude/CLAUDE.md`, `.cursor/rules/codegraph.mdc`, and `~/.codex/AGENTS.md`.
- `codegraph install` prompt order: agent picker is now step 1, before the
  PATH-install and location prompts.
- Disambiguated "global" wording in install prompts ("Install codegraph CLI on
  your PATH?" vs "Apply agent configs to all your projects, or just this one?")
  — both used to say "Global" and read as duplicates.

### Internal
- New `AgentTarget` interface in `src/installer/targets/` — adding a 5th agent
  (Continue, Zed, Windsurf, …) is a new file + one entry in `registry.ts`.
- Hand-rolled TOML serializer for Codex (`src/installer/targets/toml.ts`) — no
  new dependency, scoped to the `[mcp_servers.codegraph]` table only, sibling
  tables and `[[array_of_tables]]` preserved verbatim.
- +47 parameterized contract tests across the 4 targets — install idempotency,
  sibling preservation, uninstall reverses install, byte-equal re-runs return
  `unchanged`, partial-state recovery for Codex.

Based on substantive draft by [@andreinknv](https://github.com/andreinknv)
([fork commit `c5165e4`](https://github.com/andreinknv/codegraph/commit/c5165e4)).
Thank you.

[0.7.7]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.7

## [0.7.6] - 2026-05-13

### Fixed
- `codegraph` CLI failing with `zsh: permission denied: codegraph` after a fresh
  global install. The published 0.7.5 tarball shipped `dist/bin/codegraph.js`
  without the executable bit, so the shell refused to run it through the npm
  symlink. The build now `chmod +x`'s the binary before packing.

  Already on 0.7.5? Either upgrade to 0.7.6, or unblock yourself in place:
  ```bash
  chmod +x "$(npm root -g)/@colbymchenry/codegraph/dist/bin/codegraph.js"
  ```

[0.7.6]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.6
