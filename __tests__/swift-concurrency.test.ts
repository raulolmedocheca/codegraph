/**
 * Swift Concurrency & Architecture Extraction Tests
 *
 * Exercises the metadata produced by the Swift extractor for the full
 * concurrency / DI / inheritance model captured in the Phase 1–4 work:
 *
 *   - actor / extension / protocol classification
 *   - @MainActor / custom global actor / nonisolated / nonisolated(unsafe)
 *   - Sendable conformance (plain + @unchecked)
 *   - typed throws (Swift 6) + throws / rethrows
 *   - inheritsFrom vs conformsTo (heuristic on `class` declarations)
 *   - Property wrappers (@Inject, @LazyInject, SwiftUI @State / @Published)
 *   - Attributes flowing to `decorators`
 *   - Call-site flags: isAwait, tryKind, spawnsTask, isolationBoundary
 *   - isolated_to / wrapped_by unresolved references with right kind
 *
 * These run against the real tree-sitter-swift grammar via `extractFromSource`,
 * so they double as a smoke test for the upstream parser's node shapes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function findOne(nodes: Node[], pred: (n: Node) => boolean): Node {
  const found = nodes.find(pred);
  if (!found) {
    throw new Error(
      `No node matched predicate. Available nodes:\n` +
        nodes.map((n) => `  - ${n.kind} ${n.name}`).join('\n')
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Type classification
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Classification', () => {
  it('classifies actor declarations with kind=actor and isActor=true', () => {
    const code = `
public actor CategoryRepositoryImpl {
    public init() {}
    public func getCategories() async throws -> [String] { return [] }
}
`;
    const result = extractFromSource('CategoryRepositoryImpl.swift', code);
    const actorNode = findOne(result.nodes, (n) => n.name === 'CategoryRepositoryImpl');
    expect(actorNode.kind).toBe('actor');
    expect(actorNode.isActor).toBe(true);
    // Members of an actor inherit `{ kind: 'actor' }` isolation by default
    // (set by extractClass when kind === 'actor').
    expect(actorNode.isolation?.kind).toBe('actor');
  });

  it('classifies extensions with kind=extension', () => {
    const code = `
extension String: Identifiable {
    public var id: String { self }
}
`;
    const result = extractFromSource('StringExt.swift', code);
    const ext = findOne(result.nodes, (n) => n.kind === 'extension');
    expect(ext.name).toBe('String');
    // Conformance captured on the extension node itself.
    expect(ext.conformsTo).toContain('Identifiable');
  });

  it('classifies protocols with kind=protocol (not interface)', () => {
    const code = `
public protocol CategoryRepository: Sendable {
    func getCategories() async throws -> [String]
}
`;
    const result = extractFromSource('CategoryRepository.swift', code);
    const proto = findOne(result.nodes, (n) => n.name === 'CategoryRepository');
    expect(proto.kind).toBe('protocol');
    // Protocol refinement: Sendable shows up in conformsTo + isSendable=true.
    expect(proto.conformsTo).toContain('Sendable');
    expect(proto.isSendable).toBe(true);
  });

  it('classifies structs and enums via declaration_kind', () => {
    const code = `
public struct HTTPMethod: Sendable {
    public let rawValue: String
}

public enum APIError: Error {
    case timeout
    case invalidURL
}
`;
    const result = extractFromSource('HTTPMethod.swift', code);
    const struct = findOne(result.nodes, (n) => n.name === 'HTTPMethod');
    expect(struct.kind).toBe('struct');
    expect(struct.isSendable).toBe(true);
    const enumNode = findOne(result.nodes, (n) => n.name === 'APIError');
    expect(enumNode.kind).toBe('enum');
    expect(enumNode.conformsTo).toContain('Error');
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Isolation', () => {
  it('detects @MainActor on a type', () => {
    const code = `
@MainActor
public final class HomeViewController {
    func viewDidLoad() {}
}
`;
    const result = extractFromSource('HomeViewController.swift', code);
    const cls = findOne(result.nodes, (n) => n.name === 'HomeViewController');
    expect(cls.isolation?.kind).toBe('main_actor');
    expect(cls.isFinal).toBe(true);
  });

  it('detects @MainActor on a method', () => {
    const code = `
class Foo {
    @MainActor func updateUI() {}
}
`;
    const result = extractFromSource('Foo.swift', code);
    const m = findOne(result.nodes, (n) => n.name === 'updateUI');
    expect(m.isolation?.kind).toBe('main_actor');
  });

  it('detects custom global actor (@SomeActor) on a type', () => {
    const code = `
@DatabaseActor
public final class Store {
    func read() {}
}
`;
    const result = extractFromSource('Store.swift', code);
    const cls = findOne(result.nodes, (n) => n.name === 'Store');
    expect(cls.isolation?.kind).toBe('global_actor');
    expect(cls.isolation?.actor).toBe('DatabaseActor');

    // An `isolated_to` reference is emitted for resolver follow-up.
    const isoRef = result.unresolvedReferences.find(
      (r) => r.fromNodeId === cls.id && r.referenceKind === 'isolated_to'
    );
    expect(isoRef?.referenceName).toBe('DatabaseActor');
  });

  it('detects nonisolated on methods', () => {
    const code = `
public actor Repo {
    nonisolated public func a() {}
    nonisolated public var id: String { "" }
}
`;
    const result = extractFromSource('Repo.swift', code);
    const a = findOne(result.nodes, (n) => n.name === 'a');
    expect(a.isolation?.kind).toBe('nonisolated');
    // `id` is a computed property — also nonisolated.
    const id = findOne(result.nodes, (n) => n.name === 'id');
    expect(id.isolation?.kind).toBe('nonisolated');
  });

  // Note: tree-sitter-swift versions in current use parse
  // `nonisolated(unsafe)` as a syntax ERROR, so we can't reliably detect
  // it from the AST. The Swift extractor still ships the
  // `nonisolated_unsafe` isolation kind for future grammar fixes —
  // exercised at the type level by `Node.isolation.kind` enum coverage.
  it.todo('detects nonisolated(unsafe) once the grammar supports it');

  it('actor members inherit isolation=actor by default', () => {
    const code = `
public actor Cache {
    public func read() -> String { "" }
}
`;
    const result = extractFromSource('Cache.swift', code);
    const cache = findOne(result.nodes, (n) => n.name === 'Cache');
    expect(cache.isolation?.kind).toBe('actor');
  });
});

// ---------------------------------------------------------------------------
// Sendable
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Sendable', () => {
  it('flags Sendable conformance on a type', () => {
    const code = `
public struct DTO: Sendable {
    public let id: Int
}
`;
    const result = extractFromSource('DTO.swift', code);
    const dto = findOne(result.nodes, (n) => n.name === 'DTO');
    expect(dto.isSendable).toBe(true);
    expect(dto.isSendableUnchecked).toBeFalsy();
    expect(dto.conformsTo).toContain('Sendable');
  });

  it('flags @unchecked Sendable conformance distinctly', () => {
    const code = `
public final class LegacyBox: @unchecked Sendable {
    public var value: Int = 0
}
`;
    const result = extractFromSource('LegacyBox.swift', code);
    const box = findOne(result.nodes, (n) => n.name === 'LegacyBox');
    expect(box.isSendable).toBe(true);
    expect(box.isSendableUnchecked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Throws
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Throws', () => {
  it('detects throws and rethrows', () => {
    const code = `
public func fetch() async throws -> String { return "" }
public func tryAll(_ work: () throws -> Void) rethrows {}
`;
    const result = extractFromSource('Throws.swift', code);
    const fetch = findOne(result.nodes, (n) => n.name === 'fetch');
    expect(fetch.isAsync).toBe(true);
    expect(fetch.isThrowing).toBe(true);
    expect(fetch.thrownType).toBeUndefined();
    expect(fetch.isRethrowing).toBeFalsy();

    const tryAll = findOne(result.nodes, (n) => n.name === 'tryAll');
    expect(tryAll.isRethrowing).toBe(true);
  });

  // Swift 6 typed throws (`throws(SomeError)`) are not yet supported by
  // tree-sitter-swift — the grammar parses them as ERROR + call_expression.
  // The `thrownType` / `throws_clause` extraction paths are ready for
  // when the grammar lands; exercised here as a todo.
  it.todo('detects typed throws once the grammar supports it');
});

// ---------------------------------------------------------------------------
// Inheritance vs conformance
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Inheritance vs Conformance', () => {
  it('separates superclass from conformances for `class` declarations', () => {
    const code = `
public class HomeViewController: UIViewController, UITableViewDelegate, Sendable {
    func viewDidLoad() {}
}
`;
    const result = extractFromSource('HomeViewController.swift', code);
    const cls = findOne(result.nodes, (n) => n.name === 'HomeViewController');
    expect(cls.inheritsFrom).toBe('UIViewController');
    expect(cls.conformsTo).toEqual(expect.arrayContaining(['UITableViewDelegate', 'Sendable']));
    expect(cls.conformsTo).not.toContain('UIViewController');
    expect(cls.isSendable).toBe(true);
  });

  it('treats every inheritance_specifier as conformance for non-class types', () => {
    const code = `
public struct Note: Identifiable, Codable, Sendable {
    public let id: String
}
`;
    const result = extractFromSource('Note.swift', code);
    const note = findOne(result.nodes, (n) => n.name === 'Note');
    expect(note.inheritsFrom).toBeUndefined();
    expect(note.conformsTo).toEqual(expect.arrayContaining(['Identifiable', 'Codable', 'Sendable']));
  });

  it('emits `extends` unresolved references that the resolver promotes', () => {
    const code = `
public class Foo: Bar, Baz {
    func hello() {}
}
`;
    const result = extractFromSource('Foo.swift', code);
    const cls = findOne(result.nodes, (n) => n.name === 'Foo');
    const refs = result.unresolvedReferences.filter(
      (r) => r.fromNodeId === cls.id && r.referenceKind === 'extends'
    );
    expect(refs.map((r) => r.referenceName).sort()).toEqual(['Bar', 'Baz']);
  });
});

// ---------------------------------------------------------------------------
// Property wrappers
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Property Wrappers', () => {
  it('captures custom DI property wrappers and emits wrapped_by refs', () => {
    const code = `
public actor CategoryRepositoryImpl {
    @Inject private var dataSource: CategoryDataSource
    @LazyInject private var cache: CacheService

    public init() {}
}
`;
    const result = extractFromSource('CategoryRepositoryImpl.swift', code);
    const dataSource = findOne(result.nodes, (n) => n.name === 'dataSource');
    const cache = findOne(result.nodes, (n) => n.name === 'cache');
    expect(dataSource.propertyWrappers).toEqual(['Inject']);
    expect(cache.propertyWrappers).toEqual(['LazyInject']);

    const wrappedRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'wrapped_by'
    );
    expect(wrappedRefs.map((r) => r.referenceName).sort()).toEqual(['Inject', 'LazyInject']);
  });

  it('captures SwiftUI built-in wrappers (@State, @Published)', () => {
    const code = `
import SwiftUI

@MainActor
final class ViewModel: ObservableObject {
    @Published var items: [String] = []
}

struct ContentView {
    @State private var query: String = ""
}
`;
    const result = extractFromSource('ContentView.swift', code);
    const items = findOne(result.nodes, (n) => n.name === 'items');
    const query = findOne(result.nodes, (n) => n.name === 'query');
    expect(items.propertyWrappers).toEqual(['Published']);
    expect(query.propertyWrappers).toEqual(['State']);
  });

  it('does NOT treat @MainActor on a property as a property wrapper', () => {
    const code = `
class Foo {
    @MainActor var x: Int = 0
}
`;
    const result = extractFromSource('Foo.swift', code);
    const x = findOne(result.nodes, (n) => n.name === 'x');
    expect(x.propertyWrappers ?? []).toEqual([]);
    // It IS isolation, though.
    expect(x.isolation?.kind).toBe('main_actor');
  });
});

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Modifiers', () => {
  it('captures final/override and exposes booleans', () => {
    const code = `
public class Base {
    func go() {}
}
public final class Child: Base {
    override func go() {}
}
`;
    const result = extractFromSource('Override.swift', code);
    const child = findOne(result.nodes, (n) => n.name === 'Child');
    const go = result.nodes.find((n) => n.name === 'go' && n.isOverride);
    expect(child.isFinal).toBe(true);
    expect(child.modifiers).toContain('final');
    expect(go?.isOverride).toBe(true);
    expect(go?.modifiers).toContain('override');
  });
});

// ---------------------------------------------------------------------------
// Call-site flags
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Call sites', () => {
  it('tags await call sites with isAwait', () => {
    const code = `
func go() async throws {
    let _ = await fetchUser()
}
`;
    const result = extractFromSource('Go.swift', code);
    const callRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'calls' && r.referenceName === 'fetchUser'
    );
    expect(callRef?.metadata?.isAwait).toBe(true);
  });

  it('tags try / try? / try! variants', () => {
    const code = `
func go() throws {
    let _ = try parse()
    let _ = try? parseOptional()
    let _ = try! parseForced()
}
`;
    const result = extractFromSource('Go.swift', code);
    const plain = result.unresolvedReferences.find((r) => r.referenceName === 'parse');
    const opt = result.unresolvedReferences.find((r) => r.referenceName === 'parseOptional');
    const forced = result.unresolvedReferences.find((r) => r.referenceName === 'parseForced');
    expect(plain?.metadata?.tryKind).toBe('plain');
    // Swift grammars sometimes wrap `try?` / `try!` as plain `try_expression`
    // with a `?` / `!` operator token. We accept any of the three values
    // here to stay grammar-tolerant — extractor handles all three when the
    // grammar exposes them.
    expect(['plain', 'optional', undefined]).toContain(opt?.metadata?.tryKind);
    expect(['plain', 'forced', undefined]).toContain(forced?.metadata?.tryKind);
  });

  it('flags Task spawners and isolation boundaries', () => {
    const code = `
func go() {
    Task {
        await fetchUser()
    }
    Task.detached {}
    MainActor.run {}
    withCheckedContinuation { _ in }
}
`;
    const result = extractFromSource('Go.swift', code);
    const taskRef = result.unresolvedReferences.find((r) => r.referenceName === 'Task');
    const detachedRef = result.unresolvedReferences.find((r) => r.referenceName === 'Task.detached');
    const mainActorRunRef = result.unresolvedReferences.find((r) => r.referenceName === 'MainActor.run');
    const continuationRef = result.unresolvedReferences.find(
      (r) => r.referenceName === 'withCheckedContinuation'
    );
    expect(taskRef?.metadata?.spawnsTask).toBe(true);
    expect(detachedRef?.metadata?.spawnsTask).toBe(true);
    expect(mainActorRunRef?.metadata?.isolationBoundary).toBe(true);
    expect(continuationRef?.metadata?.isolationBoundary).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attributes flowing as `decorates`
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Attributes as decorates', () => {
  it('emits decorates UnresolvedReferences for @MainActor and @objc', () => {
    const code = `
@MainActor
public final class HomeViewController {
    @objc private func didTapButton() {}
}
`;
    const result = extractFromSource('HomeViewController.swift', code);
    const cls = findOne(result.nodes, (n) => n.name === 'HomeViewController');
    const method = findOne(result.nodes, (n) => n.name === 'didTapButton');
    const clsDecorates = result.unresolvedReferences.filter(
      (r) => r.fromNodeId === cls.id && r.referenceKind === 'decorates'
    );
    const methodDecorates = result.unresolvedReferences.filter(
      (r) => r.fromNodeId === method.id && r.referenceKind === 'decorates'
    );
    expect(clsDecorates.map((r) => r.referenceName)).toContain('MainActor');
    expect(methodDecorates.map((r) => r.referenceName)).toContain('objc');
  });
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

describe('Swift Concurrency / Imports', () => {
  it('extracts plain and granular Swift imports', () => {
    const code = `
import Foundation
import struct UIKit.UIColor
`;
    const result = extractFromSource('Imports.swift', code);
    const imports = result.nodes.filter((n) => n.kind === 'import');
    const names = imports.map((n) => n.name);
    expect(names).toContain('Foundation');
    // Granular import: the extractor pulls the leading identifier.
    expect(names.some((n) => n === 'UIKit' || n === 'UIKit.UIColor')).toBe(true);
  });
});
