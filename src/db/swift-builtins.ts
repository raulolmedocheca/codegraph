/**
 * Swift Standard-Library Built-in Nodes
 *
 * The Swift stdlib defines a handful of protocols and types that user code
 * conforms to constantly — `Sendable`, `Hashable`, `Codable`, etc. Without
 * synthetic nodes for them, every `conforms_to` edge from user code dangles
 * as an unresolved reference and the agent has no way to enumerate "all
 * types conforming to Sendable" via the graph.
 *
 * We register these as `kind: 'protocol'` nodes with `filePath: <swift-stdlib>`
 * the first time a database is initialized so the resolver can wire user
 * conformances to them by name.
 *
 * Module-aware extensions (Foundation, SwiftUI, Combine) can be added the
 * same way later if needed — they're orthogonal to this baseline.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Marker path used for synthetic Swift stdlib nodes. Distinct from any
 * real file path so it's easy to filter in MCP responses ("don't show
 * stdlib protocols as files to read").
 */
export const SWIFT_STDLIB_FILE_PATH = '<swift-stdlib>';

/**
 * Names of every Swift stdlib protocol / type we want resolvable by name.
 * Conformance edges from user code (`class Foo: Sendable`) will resolve to
 * these targets and surface as `conforms_to` edges after resolver promotion.
 *
 * Kept as a flat list because the resolver matches purely by name; module
 * membership doesn't help here.
 */
const SWIFT_STDLIB_PROTOCOLS = [
  // Concurrency
  'Sendable',
  'Actor',
  'AnyActor',
  'GlobalActor',
  'MainActor',
  'AsyncSequence',
  'AsyncIteratorProtocol',
  // Core protocols
  'Equatable',
  'Hashable',
  'Comparable',
  'Identifiable',
  'Error',
  'CaseIterable',
  'RawRepresentable',
  'CustomStringConvertible',
  'CustomDebugStringConvertible',
  'LosslessStringConvertible',
  'ExpressibleByStringLiteral',
  'ExpressibleByIntegerLiteral',
  'ExpressibleByFloatLiteral',
  'ExpressibleByBooleanLiteral',
  'ExpressibleByArrayLiteral',
  'ExpressibleByDictionaryLiteral',
  'ExpressibleByNilLiteral',
  // Codable
  'Encodable',
  'Decodable',
  'Codable',
  // Collections
  'Sequence',
  'Collection',
  'BidirectionalCollection',
  'RandomAccessCollection',
  'MutableCollection',
  'RangeReplaceableCollection',
  'IteratorProtocol',
  'Iterator',
  // Numeric / arithmetic
  'Numeric',
  'BinaryInteger',
  'FixedWidthInteger',
  'SignedInteger',
  'UnsignedInteger',
  'BinaryFloatingPoint',
  'FloatingPoint',
  'AdditiveArithmetic',
  'Strideable',
  // Other commonly conformed-to protocols
  'AnyObject',
  'NSObjectProtocol',
  'CVarArg',
  'OptionSet',
];

/**
 * Build a deterministic ID for a Swift stdlib synthetic node.
 *
 * Matches the format `generateNodeId` produces in `src/utils.ts`
 * (hash-free version for predictability): `<file>::<kind>::<name>::<line>`.
 * We use line 0 and a fixed kind so the ID is stable across runs.
 */
function syntheticNodeId(name: string): string {
  return `swift-stdlib:protocol:${name}`;
}

/**
 * Ensure every Swift stdlib synthetic node exists in the `nodes` table.
 * Idempotent — uses `INSERT OR IGNORE` so re-calling it on an already
 * populated DB is a no-op. Safe to call on every `initialize()` /
 * `open()` of a DatabaseConnection.
 */
export function ensureSwiftBuiltins(db: SqliteDatabase): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO nodes (
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column,
      docstring, signature, visibility,
      is_exported, is_async, is_static, is_abstract,
      decorators, type_parameters, updated_at,
      is_actor, is_throwing, is_sendable, is_override, is_final,
      isolation_kind, isolation_actor, metadata_json
    ) VALUES (
      @id, 'protocol', @name, @name, @filePath, 'swift',
      0, 0, 0, 0,
      NULL, NULL, 'public',
      1, 0, 0, 1,
      NULL, NULL, @updatedAt,
      0, 0, @isSendable, 0, 0,
      NULL, NULL, NULL
    )
  `);

  const insertMany = db.transaction(() => {
    for (const name of SWIFT_STDLIB_PROTOCOLS) {
      stmt.run({
        id: syntheticNodeId(name),
        name,
        filePath: SWIFT_STDLIB_FILE_PATH,
        updatedAt: now,
        isSendable: name === 'Sendable' ? 1 : 0,
      });
    }
  });
  insertMany();
}
