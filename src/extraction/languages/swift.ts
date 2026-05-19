/**
 * Swift Language Extractor
 *
 * Surfaces Swift's full concurrency and architecture model into the
 * knowledge graph: actors, `@MainActor`, custom global actors,
 * `nonisolated`, `Sendable` conformance, typed `throws`, class
 * inheritance, protocol conformance, extensions, property wrappers,
 * await/try call sites, Task spawning, and isolation boundaries.
 *
 * Grammar reference: alex-pinkus/tree-sitter-swift. Key node types used:
 *   - `class_declaration` (with field `declaration_kind`: `class | struct | enum | actor | extension`)
 *   - `protocol_declaration`
 *   - `function_declaration` (init/deinit/subscript treated as methods)
 *   - `property_declaration`, `constant_declaration`
 *   - `inheritance_specifier` (with field `inherits_from`)
 *   - `attribute` (Swift's `@…` annotations; routed via the core's
 *     `extractDecoratorsFor` once `attribute` is whitelisted there)
 *   - `modifiers`, `throws`, `throws_clause`, `where_clause`
 *
 * Concurrency edges produced (via core helpers):
 *   - `conforms_to` (after resolver promotion of `extends` → `conforms_to`)
 *   - `inherits_from` (after resolver promotion when target is a class/actor)
 *   - `wrapped_by` (from `getPropertyWrappers` → emitPropertyWrapperEdges)
 *   - `isolated_to` (from `getIsolation.actor` → emitIsolatedToEdge)
 *   - `calls` with `metadata.{isAwait, tryKind, spawnsTask, isolationBoundary}`
 *     (detected by the core's `detectCallSiteFlags`).
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// ---------------------------------------------------------------------------
// Modifier vocabulary
// ---------------------------------------------------------------------------

/**
 * Modifier keywords Swift accepts on type/function/property declarations.
 * Captured verbatim in `Node.modifiers` (with parameter-modifier variants
 * appended when applicable on parameter nodes).
 */
const SWIFT_MODIFIERS = new Set([
  // Access (visibility flows via `getVisibility`, but these literals can
  // also appear in `modifiers` and we keep them for completeness).
  'open',
  'public',
  'internal',
  'fileprivate',
  'private',
  'package',
  // Declaration modifiers
  'final',
  'static',
  'class', // `class func` / `class var`
  'override',
  'convenience',
  'required',
  'lazy',
  'weak',
  'unowned',
  'unowned(safe)',
  'unowned(unsafe)',
  'dynamic',
  'distributed',
  'indirect',
  'mutating',
  'nonmutating',
  'optional',
  // Concurrency / isolation modifiers
  'nonisolated',
  'nonisolated(unsafe)',
  // Parameter / ownership modifiers (Swift 5.9+ / 6)
  'borrowing',
  'consuming',
  'inout',
  '__shared',
  '__owned',
  // Other rare modifiers
  'prefix',
  'postfix',
  'infix',
]);

/**
 * Built-in Swift attribute names that we recognise. Anything outside this
 * set whose name is Capitalised is treated as either a custom global
 * actor (on a type/function) or a custom property wrapper (on a property).
 */
const KNOWN_ATTRIBUTE_NAMES = new Set([
  // Concurrency
  'MainActor',
  'Sendable',
  'preconcurrency',
  // Objective-C bridging
  'objc',
  'objcMembers',
  // SwiftUI / built-in property wrappers
  'State',
  'Binding',
  'StateObject',
  'ObservedObject',
  'EnvironmentObject',
  'Environment',
  'Published',
  'AppStorage',
  'SceneStorage',
  'FocusState',
  'Namespace',
  'GestureState',
  // Result builders
  'ViewBuilder',
  'resultBuilder',
  // Generic Swift attributes
  'available',
  'unavailable',
  'discardableResult',
  'inlinable',
  'usableFromInline',
  'frozen',
  'inline',
  'noreturn',
  'escaping',
  'autoclosure',
  'convention',
  'dynamicMemberLookup',
  'dynamicCallable',
  'propertyWrapper',
  'NSCopying',
  'NSManaged',
  'IBOutlet',
  'IBAction',
  'IBDesignable',
  'IBInspectable',
  'GKInspectable',
  'testable',
  'main',
  'UIApplicationMain',
  'NSApplicationMain',
]);

/**
 * SwiftUI built-in property wrappers that DO count toward `propertyWrappers`.
 * Other items in `KNOWN_ATTRIBUTE_NAMES` are attributes, not wrappers.
 */
const SWIFTUI_PROPERTY_WRAPPERS = new Set([
  'State',
  'Binding',
  'StateObject',
  'ObservedObject',
  'EnvironmentObject',
  'Environment',
  'Published',
  'AppStorage',
  'SceneStorage',
  'FocusState',
  'Namespace',
  'GestureState',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Every `attribute` belonging to a declaration. In tree-sitter-swift the
 * attribute lives INSIDE the `modifiers` child (alongside
 * `visibility_modifier`, `inheritance_modifier`, etc.) rather than as a
 * direct child of the declaration. Some grammar variants put it both
 * places, so we walk both.
 */
function attributeChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'attribute') {
      out.push(child);
    } else if (child.type === 'modifiers') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const grandchild = child.namedChild(j);
        if (grandchild && grandchild.type === 'attribute') out.push(grandchild);
      }
    }
  }
  return out;
}

/**
 * Extract the bare attribute name from an `@Name(args)` attribute node:
 * the leading identifier ("MainActor", "Inject", "available", …) without
 * the `@` and without any argument tail.
 *
 * Tree-sitter-swift's `attribute` node shape isn't always predictable —
 * some versions of the grammar emit the `@` as an unnamed terminal plus
 * a `user_type` child; older ones wrap a bare `simple_identifier`. We
 * regex the raw text first (bulletproof) and only fall back to AST
 * inspection if that somehow fails.
 */
function attributeName(attr: SyntaxNode, source: string): string | undefined {
  const txt = getNodeText(attr, source).trim();
  const m = txt.match(/^@\s*([A-Za-z_][\w]*)/);
  if (m && m[1]) return m[1];
  // AST fallback for malformed cases (shouldn't normally trigger).
  for (let i = 0; i < attr.namedChildCount; i++) {
    const child = attr.namedChild(i);
    if (!child) continue;
    if (
      child.type === 'user_type' ||
      child.type === 'simple_identifier' ||
      child.type === 'identifier' ||
      child.type === 'type_identifier' ||
      child.type === 'qualified_type'
    ) {
      const inner = child.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'simple_identifier'
      );
      const target = inner ?? child;
      const text = getNodeText(target, source).trim();
      const ident = text.split(/[<(]/)[0]?.trim();
      if (ident) return ident.replace(/^@/, '');
    }
  }
  return undefined;
}

/** Find the `modifiers` child node, if present. */
function modifiersChild(node: SyntaxNode): SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'modifiers') return child;
  }
  return undefined;
}

/**
 * Tokenize the raw text of a `modifiers` node into individual modifier
 * keywords, preserving parenthesized forms (`nonisolated(unsafe)`).
 */
function tokenizeModifiers(modifiersText: string): string[] {
  const re = /[a-zA-Z_]+(?:\([^)]*\))?/g;
  return Array.from(modifiersText.matchAll(re), (m) => m[0]);
}

/**
 * Read `declaration_kind` (Swift's discriminator for class/struct/enum/
 * actor/extension on the shared `class_declaration` node). Falls back to
 * scanning unnamed-terminal children when the field accessor returns null.
 */
function declarationKind(node: SyntaxNode): string | undefined {
  const field = getChildByField(node, 'declaration_kind');
  if (field) {
    const text = field.text || field.type;
    if (text) return text;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'class' ||
      child.type === 'struct' ||
      child.type === 'enum' ||
      child.type === 'actor' ||
      child.type === 'extension' ||
      child.type === 'protocol'
    ) {
      return child.type;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const swiftExtractor: LanguageExtractor = {
  // `class_declaration` covers structs/enums/actors/extensions too — they
  // all share the same node type in tree-sitter-swift, discriminated by
  // the `declaration_kind` field. They are NOT added to structTypes /
  // enumTypes because `classifyClassNode` routes them via the core
  // dispatcher.
  functionTypes: [
    'function_declaration',
    'init_declaration',
    'deinit_declaration',
    'subscript_declaration',
  ],
  classTypes: ['class_declaration'],
  methodTypes: [
    'function_declaration',
    'init_declaration',
    'deinit_declaration',
    'subscript_declaration',
  ],
  interfaceTypes: ['protocol_declaration'],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['typealias_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration', 'constant_declaration'],
  propertyTypes: ['property_declaration'],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',
  returnField: 'return_type',
  interfaceKind: 'protocol',

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  classifyClassNode: (node) => {
    const kind = declarationKind(node);
    if (kind === 'struct') return 'struct';
    if (kind === 'enum') return 'enum';
    if (kind === 'actor') return 'actor';
    if (kind === 'extension') return 'extension';
    return 'class';
  },

  // -------------------------------------------------------------------------
  // Signature
  // -------------------------------------------------------------------------

  getSignature: (node, source) => {
    const attrParts: string[] = [];
    for (const attr of attributeChildren(node)) {
      attrParts.push(getNodeText(attr, source).trim());
    }
    const modsNode = modifiersChild(node);
    const modText = modsNode ? getNodeText(modsNode, source).trim() : '';

    // Function-like declarations
    if (
      node.type === 'function_declaration' ||
      node.type === 'init_declaration' ||
      node.type === 'deinit_declaration' ||
      node.type === 'subscript_declaration'
    ) {
      const params = getChildByField(node, 'parameter');
      const returnType = getChildByField(node, 'return_type');
      const where = node.namedChildren.find((c: SyntaxNode) => c.type === 'where_clause');
      const isAsync = node.namedChildren.some(
        (c: SyntaxNode) => c.type === 'async' || c.text === 'async'
      );
      const throwsClause = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'throws_clause'
      );
      const hasThrows =
        throwsClause !== undefined ||
        node.namedChildren.some((c: SyntaxNode) => c.type === 'throws' || c.text === 'throws');
      const hasRethrows = node.namedChildren.some(
        (c: SyntaxNode) => c.type === 'rethrows' || c.text === 'rethrows'
      );

      const parts: string[] = [];
      if (attrParts.length > 0) parts.push(attrParts.join(' '));
      if (modText) parts.push(modText);
      parts.push(params ? getNodeText(params, source) : '()');
      if (isAsync) parts.push('async');
      if (hasRethrows) parts.push('rethrows');
      else if (hasThrows) {
        const thrownType = throwsClause ? getChildByField(throwsClause, 'type') : null;
        parts.push(thrownType ? `throws(${getNodeText(thrownType, source)})` : 'throws');
      }
      if (returnType) parts.push(`-> ${getNodeText(returnType, source).trim()}`);
      if (where) parts.push(getNodeText(where, source).trim());
      return parts.join(' ');
    }

    // Types (class/struct/enum/actor/extension/protocol)
    if (node.type === 'class_declaration' || node.type === 'protocol_declaration') {
      const parts: string[] = [];
      if (attrParts.length > 0) parts.push(attrParts.join(' '));
      if (modText) parts.push(modText);
      const dk = declarationKind(node);
      if (dk) parts.push(dk);
      const nameField = getChildByField(node, 'name');
      if (nameField) parts.push(getNodeText(nameField, source).trim());
      const inheritanceText = node.namedChildren
        .filter((c: SyntaxNode) => c.type === 'inheritance_specifier')
        .map((c: SyntaxNode) => getNodeText(c, source).trim())
        .join(', ');
      if (inheritanceText) parts.push(`: ${inheritanceText}`);
      const where = node.namedChildren.find((c: SyntaxNode) => c.type === 'where_clause');
      if (where) parts.push(getNodeText(where, source).trim());
      return parts.join(' ');
    }

    // Properties / constants
    if (node.type === 'property_declaration' || node.type === 'constant_declaration') {
      const parts: string[] = [];
      if (attrParts.length > 0) parts.push(attrParts.join(' '));
      if (modText) parts.push(modText);
      const typeAnnotation = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_annotation'
      );
      const valuePattern = node.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'pattern' || c.type === 'value_binding_pattern'
      );
      if (valuePattern) parts.push(getNodeText(valuePattern, source));
      if (typeAnnotation) parts.push(getNodeText(typeAnnotation, source).trim());
      return parts.join(' ').trim() || undefined;
    }

    return undefined;
  },

  // -------------------------------------------------------------------------
  // Visibility / boolean flags
  // -------------------------------------------------------------------------

  getVisibility: (node) => {
    const mods = modifiersChild(node);
    if (!mods) return 'internal';
    const text = mods.text;
    if (/\bopen\b/.test(text) || /\bpublic\b/.test(text)) return 'public';
    if (/\bprivate\b/.test(text)) return 'private';
    if (/\bfileprivate\b/.test(text)) return 'private';
    if (/\bpackage\b/.test(text) || /\binternal\b/.test(text)) return 'internal';
    return 'internal';
  },

  isStatic: (node) => {
    const mods = modifiersChild(node);
    if (!mods) return false;
    // `static` and `class` are both static in Swift; `class` is the
    // overridable form on classes/actors. Word boundaries avoid
    // matching `classifier`.
    return /\b(?:static|class)\b/.test(mods.text);
  },

  isAsync: (node) => {
    // tree-sitter-swift emits `async` as an UNNAMED terminal child of
    // `function_declaration`; walking `namedChildren` misses it.
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && (c.type === 'async' || c.text === 'async')) return true;
    }
    const mods = modifiersChild(node);
    return mods ? /\basync\b/.test(mods.text) : false;
  },

  // -------------------------------------------------------------------------
  // Modern-language hooks
  // -------------------------------------------------------------------------

  getModifiers: (node) => {
    const mods = modifiersChild(node);
    if (!mods) return [];
    const tokens = tokenizeModifiers(mods.text);
    return tokens.filter((tok) => {
      const bare = tok.split('(')[0];
      return bare ? SWIFT_MODIFIERS.has(tok) || SWIFT_MODIFIERS.has(bare) : false;
    });
  },

  getIsolation: (node, source) => {
    // Priority:
    //   1. `nonisolated(unsafe)` modifier  → `nonisolated_unsafe`
    //   2. `nonisolated` modifier           → `nonisolated`
    //   3. `@MainActor` attribute           → `main_actor`
    //   4. Custom global actor (e.g. `@MyActor`) → `global_actor` + actor name
    // The default `{ kind: 'actor' }` for members of an `actor` type
    // is set by the core extractor — we don't set it here.
    const mods = modifiersChild(node);
    if (mods) {
      if (/\bnonisolated\s*\(\s*unsafe\s*\)/.test(mods.text)) {
        return { kind: 'nonisolated_unsafe' };
      }
      if (/\bnonisolated\b/.test(mods.text)) {
        return { kind: 'nonisolated' };
      }
    }

    for (const attr of attributeChildren(node)) {
      const name = attributeName(attr, source);
      if (!name) continue;
      if (name === 'MainActor') return { kind: 'main_actor' };
      // Heuristic for a custom global actor: capitalised first letter,
      // not a known Swift attribute, and the node is not a property
      // (custom wrappers on properties flow via `getPropertyWrappers`).
      if (!KNOWN_ATTRIBUTE_NAMES.has(name) && /^[A-Z]/.test(name)) {
        if (node.type === 'property_declaration' || node.type === 'constant_declaration') {
          continue;
        }
        return { kind: 'global_actor', actor: name };
      }
    }

    return undefined;
  },

  isThrowing: (node) => {
    // tree-sitter-swift represents `throws` as an UNNAMED terminal child
    // of `function_declaration`, so it doesn't appear in `namedChildren`.
    // Walk the full child list and check both type and text. The same
    // terminal also carries the literal `rethrows` text for rethrowing
    // functions — guard against that here.
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c) continue;
      if (c.type === 'throws_clause') return true;
      if ((c.type === 'throws' || c.text === 'throws') && c.text !== 'rethrows') return true;
    }
    return false;
  },

  isRethrowing: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && (c.text === 'rethrows' || c.type === 'rethrows')) return true;
    }
    return false;
  },

  getThrownType: (node, source) => {
    const throwsClause = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'throws_clause'
    );
    if (!throwsClause) return undefined;
    const typeChild = getChildByField(throwsClause, 'type');
    return typeChild ? getNodeText(typeChild, source).trim() : undefined;
  },

  isOverride: (node) => {
    const mods = modifiersChild(node);
    return mods ? /\boverride\b/.test(mods.text) : false;
  },

  isFinal: (node) => {
    const mods = modifiersChild(node);
    return mods ? /\bfinal\b/.test(mods.text) : false;
  },

  getPropertyWrappers: (node, source) => {
    if (node.type !== 'property_declaration' && node.type !== 'constant_declaration') {
      return [];
    }
    const wrappers: string[] = [];
    for (const attr of attributeChildren(node)) {
      const name = attributeName(attr, source);
      if (!name) continue;
      if (name === 'MainActor') continue; // isolation, not a wrapper
      if (KNOWN_ATTRIBUTE_NAMES.has(name)) {
        if (SWIFTUI_PROPERTY_WRAPPERS.has(name)) wrappers.push(name);
        continue;
      }
      // Anything else capitalised → custom wrapper (`@Inject`, `@LazyInject`, etc.).
      if (/^[A-Z]/.test(name)) wrappers.push(name);
    }
    return wrappers;
  },

  getInheritanceClause: (node, source) => {
    const specifiers = node.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'inheritance_specifier'
    );
    if (specifiers.length === 0) return undefined;

    const names = specifiers
      .map((s: SyntaxNode) => {
        const inheritsFrom = getChildByField(s, 'inherits_from') ?? s.namedChild(0);
        if (!inheritsFrom) return '';
        const typeId = inheritsFrom.namedChildren.find(
          (c: SyntaxNode) =>
            c.type === 'type_identifier' || c.type === 'simple_identifier'
        );
        return getNodeText(typeId ?? inheritsFrom, source).trim();
      })
      .filter((n: string) => Boolean(n));

    // `@unchecked Sendable` is parsed by tree-sitter-swift as an `attribute`
    // node (with name "unchecked") sitting BETWEEN the `:` and the
    // `inheritance_specifier "Sendable"`. The attribute therefore doesn't
    // ride inside `modifiers`; we look for it as a direct child of the
    // declaration node. When found, rewrite the matching conformance
    // entry to the canonical "@unchecked Sendable" form so downstream
    // code can flag `isSendableUnchecked` without re-walking the AST.
    const directAttrs = node.namedChildren.filter((c: SyntaxNode) => c.type === 'attribute');
    const uncheckedPresent = directAttrs.some((a: SyntaxNode) => {
      const n = attributeName(a, source);
      return n === 'unchecked';
    });
    const rewritten = uncheckedPresent
      ? names.map((n: string) => (n === 'Sendable' ? '@unchecked Sendable' : n))
      : names;

    // Swift requires class inheritance to come first when present.
    // We tentatively treat the first entry on a `class` declaration as
    // the superclass; the resolver corrects this when the resolved
    // target turns out to be a protocol instead.
    const isClassDecl = declarationKind(node) === 'class';

    let inherits: string | undefined;
    let conforms: string[] = rewritten;
    if (isClassDecl && rewritten.length > 0 && rewritten[0]) {
      inherits = rewritten[0];
      conforms = rewritten.slice(1);
    }

    const whereNode = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'where_clause'
    );
    const whereClause = whereNode ? getNodeText(whereNode, source).trim() : undefined;

    return { inherits, conforms, whereClause };
  },

  // -------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // Swift `import_declaration` shape: `import [submodule_kind] Module[.Submodule]`
    let moduleName: string | undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (
        child.type === 'identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'qualified_name' ||
        child.type === 'type_identifier'
      ) {
        moduleName = getNodeText(child, source).trim();
        break;
      }
    }
    if (!moduleName) {
      const m = importText.match(
        /import\s+(?:struct|class|protocol|enum|func|var|let|typealias|actor)?\s*([A-Za-z_][\w.]*)/
      );
      if (m && m[1]) moduleName = m[1];
    }
    if (!moduleName) return null;
    return { moduleName, signature: importText };
  },
};
