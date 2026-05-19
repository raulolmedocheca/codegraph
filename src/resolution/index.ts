/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder } from '../db/queries';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
} from './types';
import { matchReference } from './name-matcher';
import { resolveViaImport, extractImportMappings, extractReExports } from './import-resolver';
import { detectFrameworks } from './frameworks';
import { loadProjectAliases, type AliasMap } from './path-aliases';
import { logDebug } from '../errors';
import type { ReExport } from './types';

// Re-export types
export * from './types';

// Pre-built Sets for O(1) built-in lookups (allocated once, shared across all instances)
const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
]);

const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
]);

const GO_STDLIB_PACKAGES = new Set([
  'fmt', 'os', 'io', 'net', 'http', 'log', 'math', 'sort', 'sync',
  'time', 'path', 'bytes', 'strings', 'strconv', 'errors', 'context',
  'json', 'xml', 'csv', 'html', 'template', 'regexp', 'reflect',
  'runtime', 'testing', 'flag', 'bufio', 'crypto', 'encoding',
  'filepath', 'hash', 'mime', 'rand', 'signal', 'sql', 'syscall',
  'unicode', 'unsafe', 'atomic', 'binary', 'debug', 'exec', 'heap',
  'ring', 'scanner', 'tar', 'zip', 'gzip', 'zlib', 'tls', 'url',
  'user', 'pprof', 'trace', 'ast', 'build', 'parser', 'printer',
  'token', 'types', 'cgo', 'plugin', 'race', 'ioutil',
  // Kubernetes-common stdlib aliases
  'utilruntime', 'utilwait', 'utilnet',
]);

const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
]);

const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
];

/**
 * Swift built-in TYPES (not protocols). Protocols like `Sendable` / `Hashable`
 * intentionally NOT in this set — they have synthetic nodes registered by
 * `ensureSwiftBuiltins`, so the resolver finds them and emits real edges.
 *
 * Types here include the value-type primitives (`Int`, `String`, …) and
 * the most common stdlib generic types (`Array`, `Optional`, …). References
 * to them get short-circuited as external to avoid wasted resolver work.
 */
const SWIFT_BUILTIN_TYPES = new Set([
  // Numeric primitives
  'Int', 'Int8', 'Int16', 'Int32', 'Int64',
  'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Float', 'Double', 'Float16', 'Float32', 'Float64',
  'CGFloat',
  // Boolean / strings / characters
  'Bool', 'String', 'Substring', 'Character', 'StaticString', 'Unicode',
  // Collections / containers
  'Array', 'Dictionary', 'Set', 'ContiguousArray', 'ArraySlice',
  'Optional', 'Result',
  'Range', 'ClosedRange', 'PartialRangeFrom', 'PartialRangeUpTo', 'PartialRangeThrough',
  'KeyPath', 'WritableKeyPath', 'ReferenceWritableKeyPath',
  'AnyKeyPath', 'PartialKeyPath',
  // Pointers / unsafe
  'UnsafePointer', 'UnsafeMutablePointer', 'UnsafeRawPointer', 'UnsafeMutableRawPointer',
  'UnsafeBufferPointer', 'UnsafeMutableBufferPointer',
  'AutoreleasingUnsafeMutablePointer', 'OpaquePointer',
  // Misc
  'Void', 'Never', 'Any', 'AnyClass', 'Self', 'Type',
  'ObjectIdentifier', 'AnyHashable',
  // Concurrency types (the runtime types, not the protocols)
  'Task', 'TaskGroup', 'ThrowingTaskGroup', 'CheckedContinuation', 'UnsafeContinuation',
  'TaskPriority', 'TaskLocal', 'AsyncStream', 'AsyncThrowingStream',
  // Bridged
  'NSString', 'NSNumber', 'NSArray', 'NSDictionary', 'NSObject', 'NSError',
  'CGRect', 'CGSize', 'CGPoint', 'NSRange',
  // Swift literals
  'nil', 'true', 'false',
]);

/**
 * Swift modules (Foundation, UIKit, SwiftUI, …) — appear as `imports`
 * references that can never resolve to a node in user code.
 */
const SWIFT_BUILTIN_MODULES = new Set([
  'Swift',
  'Foundation',
  'Dispatch',
  'Combine',
  'CoreFoundation',
  'CoreGraphics',
  'CoreData',
  'CoreLocation',
  'CoreImage',
  'CoreText',
  'CoreServices',
  'QuartzCore',
  'OSLog',
  'os',
  'os.log',
  'Security',
  'CFNetwork',
  'CryptoKit',
  'Compression',
  'UniformTypeIdentifiers',
  'AVFoundation',
  'AVKit',
  'MediaPlayer',
  'PhotosUI',
  'Photos',
  'Contacts',
  'EventKit',
  // UI frameworks
  'UIKit', 'AppKit', 'WatchKit', 'WidgetKit', 'SwiftUI',
  'CoreAnimation', 'UserNotifications',
  // Swift Testing / XCTest
  'XCTest', 'Testing',
  // Concurrency
  '_Concurrency',
  // Networking / web
  'Network', 'WebKit',
  // Maps & location
  'MapKit',
  // ML / AR
  'CoreML', 'Vision', 'ARKit', 'RealityKit',
  // Combine adjacent
  'Observation',
]);

/**
 * Custom-attribute names that are known property wrappers / language
 * attributes commonly used in Swift codebases — when the resolver sees a
 * `decorates`/`wrapped_by` reference to one of these and there's no
 * matching user-defined wrapper in the indexed code, we leave it
 * unresolved rather than re-attempting expensive lookups.
 *
 * Note: we DON'T mark these as "external" outright because user code
 * frequently defines `Inject`, `LazyInject`, etc. as property wrappers
 * — and when it does, we want the wrapped_by edges to resolve to those
 * definitions. This set is only consulted as a tiebreaker fallback.
 */
const SWIFT_COMMON_DI_WRAPPERS = new Set([
  // Swinject / Resolver-style DI markers used in user code
  'Inject', 'LazyInject', 'Injected', 'LazyInjected', 'WeakLazyInjected',
  // SwiftUI built-in wrappers (covered separately too)
  'State', 'Binding', 'StateObject', 'ObservedObject', 'EnvironmentObject',
  'Environment', 'Published', 'AppStorage', 'SceneStorage',
  'FocusState', 'Namespace', 'GestureState',
]);

const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
]);

/**
 * Categorise a Swift-style attribute / property-wrapper name into a
 * coarse bucket the agent can filter by. Returns `undefined` when the
 * name is unknown — the resulting edge then carries no category tag.
 */
function categoriseAttribute(name: string): 'isolation' | 'di' | 'swiftui' | 'objc' | 'availability' | undefined {
  const SWIFTUI_WRAPPERS = new Set([
    'State', 'Binding', 'StateObject', 'ObservedObject', 'EnvironmentObject',
    'Environment', 'Published', 'AppStorage', 'SceneStorage',
    'FocusState', 'Namespace', 'GestureState', 'ViewBuilder',
  ]);
  if (name === 'MainActor' || name === 'preconcurrency') return 'isolation';
  if (SWIFT_COMMON_DI_WRAPPERS.has(name)) {
    // Among DI markers, SwiftUI wrappers route to 'swiftui' for clarity.
    return SWIFTUI_WRAPPERS.has(name) ? 'swiftui' : 'di';
  }
  if (name === 'objc' || name === 'objcMembers' || name === 'IBOutlet' ||
      name === 'IBAction' || name === 'IBDesignable' || name === 'IBInspectable') {
    return 'objc';
  }
  if (name === 'available' || name === 'unavailable') return 'availability';
  return undefined;
}

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  private nodeCache: Map<string, Node[]> = new Map(); // per-file node cache (bounded)
  private fileCache: Map<string, string | null> = new Map(); // per-file content cache (bounded)
  private importMappingCache: Map<string, ImportMapping[]> = new Map();
  private reExportCache: Map<string, ReExport[]> = new Map();
  private nameCache: Map<string, Node[]> = new Map(); // name → nodes cache
  private lowerNameCache: Map<string, Node[]> = new Map(); // lower(name) → nodes cache
  private qualifiedNameCache: Map<string, Node[]> = new Map(); // qualified_name → nodes cache
  private knownNames: Set<string> | null = null; // all known symbol names for fast pre-filtering
  private knownFiles: Set<string> | null = null;
  private cachesWarmed = false;
  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Treated as immutable for the
  // resolver's lifetime; callers re-create the resolver if config changes.
  private projectAliases: AliasMap | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.context = this.createContext();
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * Pre-build lightweight caches for resolution.
   * Node lookups are now handled by indexed SQLite queries instead of
   * loading all nodes into memory (which caused OOM on large codebases).
   * We cache the set of known symbol names for fast pre-filtering.
   */
  warmCaches(): void {
    if (this.cachesWarmed) return;

    // Only cache the set of known file paths (lightweight string set)
    this.knownFiles = new Set(this.queries.getAllFilePaths());

    // Cache all distinct symbol names for fast pre-filtering (just strings, not full nodes)
    this.knownNames = new Set(this.queries.getAllNodeNames());

    this.cachesWarmed = true;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    this.nodeCache.clear();
    this.fileCache.clear();
    this.importMappingCache.clear();
    this.reExportCache.clear();
    this.nameCache.clear();
    this.lowerNameCache.clear();
    this.qualifiedNameCache.clear();
    this.knownNames = null;
    this.knownFiles = null;
    this.cachesWarmed = false;
  }

  /**
   * Create the resolution context
   */
  private createContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath: string) => {
        if (!this.nodeCache.has(filePath)) {
          this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
        }
        return this.nodeCache.get(filePath)!;
      },

      getNodesByName: (name: string) => {
        const cached = this.nameCache.get(name);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByName(name);
        this.nameCache.set(name, result);
        return result;
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        const cached = this.qualifiedNameCache.get(qualifiedName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByQualifiedNameExact(qualifiedName);
        this.qualifiedNameCache.set(qualifiedName, result);
        return result;
      },

      getNodesByKind: (kind: Node['kind']) => {
        return this.queries.getNodesByKind(kind);
      },

      fileExists: (filePath: string) => {
        // Check pre-built known files set first (O(1))
        if (this.knownFiles) {
          const normalized = filePath.replace(/\\/g, '/');
          if (this.knownFiles.has(filePath) || this.knownFiles.has(normalized)) {
            return true;
          }
        }
        // Fall back to filesystem for files not yet indexed
        const fullPath = path.join(this.projectRoot, filePath);
        try {
          return fs.existsSync(fullPath);
        } catch (error) {
          logDebug('Error checking file existence', { filePath, error: String(error) });
          return false;
        }
      },

      readFile: (filePath: string) => {
        if (this.fileCache.has(filePath)) {
          return this.fileCache.get(filePath)!;
        }

        const fullPath = path.join(this.projectRoot, filePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.fileCache.set(filePath, content);
          return content;
        } catch (error) {
          logDebug('Failed to read file for resolution', { filePath, error: String(error) });
          this.fileCache.set(filePath, null);
          return null;
        }
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        return this.queries.getAllFilePaths();
      },

      listDirectories: (relativePath: string) => {
        const target = relativePath === '.' || relativePath === ''
          ? this.projectRoot
          : path.join(this.projectRoot, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch (error) {
          logDebug('Failed to list directory for resolution', {
            relativePath,
            error: String(error),
          });
          return [];
        }
      },

      getNodesByLowerName: (lowerName: string) => {
        const cached = this.lowerNameCache.get(lowerName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByLowerName(lowerName);
        this.lowerNameCache.set(lowerName, result);
        return result;
      },

      getImportMappings: (filePath: string, language) => {
        const cacheKey = filePath;
        const cached = this.importMappingCache.get(cacheKey);
        if (cached) return cached;

        const content = this.context.readFile(filePath);
        if (!content) {
          this.importMappingCache.set(cacheKey, []);
          return [];
        }

        const mappings = extractImportMappings(filePath, content, language);
        this.importMappingCache.set(cacheKey, mappings);
        return mappings;
      },

      getProjectAliases: () => {
        if (this.projectAliases === undefined) {
          this.projectAliases = loadProjectAliases(this.projectRoot);
        }
        return this.projectAliases;
      },

      getReExports: (filePath: string, language) => {
        const cached = this.reExportCache.get(filePath);
        if (cached) return cached;
        const content = this.context.readFile(filePath);
        if (!content) {
          this.reExportCache.set(filePath, []);
          return [];
        }
        const reExports = extractReExports(content, language);
        this.reExportCache.set(filePath, reExports);
        return reExports;
      },
    };
  }

  /**
   * Resolve all unresolved references
   */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    // Pre-load all nodes into memory for fast lookups
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // Convert to our internal format, using denormalized fields when available
    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    }));

    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      // Report progress every 1% to avoid too many updates
      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100);
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent;
          onProgress(i + 1, total);
        }
      }
    }

    // Final progress report
    if (onProgress && total > 0) {
      onProgress(total, total);
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Check if a reference name has any possible match in the codebase.
   * Uses the pre-built knownNames set to skip expensive resolution
   * for names that definitely don't exist as symbols.
   */
  private hasAnyPossibleMatch(name: string): boolean {
    if (!this.knownNames) return true; // no pre-filter available

    // Direct name match
    if (this.knownNames.has(name)) return true;

    // For qualified names like "obj.method" or "Class::method", check the parts
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const member = name.substring(dotIdx + 1);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
      // Also check capitalized receiver (instance-method resolution)
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (this.knownNames.has(capitalized)) return true;
    }
    const colonIdx = name.indexOf('::');
    if (colonIdx > 0) {
      const receiver = name.substring(0, colonIdx);
      const member = name.substring(colonIdx + 2);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
    }

    // For path-like references (e.g., "snippets/drawer-menu.liquid"), check the filename
    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const fileName = name.substring(slashIdx + 1);
      if (this.knownNames.has(fileName)) return true;
    }

    return false;
  }

  /**
   * Does `ref.referenceName` match an import declared in its containing
   * file? Used as a pre-filter escape so re-export chain resolution
   * still gets a chance when the name has no project-wide declaration.
   */
  private matchesAnyImport(ref: UnresolvedRef): boolean {
    const imports = this.context.getImportMappings(ref.filePath, ref.language);
    if (imports.length === 0) return false;
    for (const imp of imports) {
      if (
        imp.localName === ref.referenceName ||
        ref.referenceName.startsWith(imp.localName + '.')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a single reference
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Skip built-in/external references
    if (this.isBuiltInOrExternal(ref)) {
      return null;
    }

    // Fast pre-filter: skip if no symbol with this name exists anywhere
    // AND the name doesn't match a local import. The import escape is
    // necessary because re-export rename chains (`import { login }
    // from './barrel'` where the barrel has `export { signIn as login }
    // from './auth'`) intentionally call a name that has no
    // declaration anywhere — only the renamed upstream symbol does.
    if (!this.hasAnyPossibleMatch(ref.referenceName) && !this.matchesAnyImport(ref)) {
      return null;
    }

    const candidates: ResolvedRef[] = [];

    // Strategy 1: Try framework-specific resolution
    for (const framework of this.frameworks) {
      const result = framework.resolve(ref, this.context);
      if (result) {
        if (result.confidence >= 0.9) return result; // High confidence, return immediately
        candidates.push(result);
      }
    }

    // Strategy 2: Try import-based resolution
    const importResult = resolveViaImport(ref, this.context);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    // Strategy 3: Try name matching
    const nameResult = matchReference(ref, this.context);
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) return null;

    // Return highest confidence candidate
    return candidates.reduce((best, curr) =>
      curr.confidence > best.confidence ? curr : best
    );
  }

  /**
   * Create edges from resolved references
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.map((ref) => {
      let kind = ref.original.referenceKind;
      const isSwift = ref.original.language === 'swift';

      // Promote `extends` based on target kind:
      //
      //  Swift specifically:
      //    target protocol  → `conforms_to`
      //    target class     → `inherits_from`
      //    target actor     → `inherits_from` (rare but valid)
      //
      //  Other languages keep the historic behaviour:
      //    target interface → `implements` (JVM convention)
      //    target protocol  → `implements` (preserve prior semantics)
      //
      // This lets Swift surface protocol conformance and class inheritance
      // as distinct, queryable edges without disturbing JVM-language flows.
      if (kind === 'extends') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode) {
          if (isSwift) {
            if (targetNode.kind === 'protocol') {
              kind = 'conforms_to';
            } else if (targetNode.kind === 'class' || targetNode.kind === 'actor') {
              kind = 'inherits_from';
            }
          } else if (targetNode.kind === 'interface' || targetNode.kind === 'protocol') {
            const sourceNode = this.queries.getNodeById(ref.original.fromNodeId);
            if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
              kind = 'implements';
            }
          }
        }
      }

      // Promote "calls" to "instantiates" when the resolved target is a
      // class/struct. Languages without a `new` keyword (Python, Ruby,
      // Swift) express instantiation as `Foo()` — extraction can't tell
      // that apart from a function call without symbol info, but
      // resolution can: if `Foo` resolves to a class, the call IS an
      // instantiation. (Swift actors are also constructed with `Foo()`.)
      if (kind === 'calls') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (
          targetNode &&
          (targetNode.kind === 'class' ||
            targetNode.kind === 'struct' ||
            targetNode.kind === 'actor')
        ) {
          kind = 'instantiates';
        }
      }

      // Categorise `decorates` edges so the agent can quickly filter
      // "isolation attributes" vs "dependency-injection wrappers" vs
      // "SwiftUI state wrappers". Cheap — no extra DB lookup.
      let categoryMeta: Record<string, string> | undefined;
      if (kind === 'decorates' || kind === 'wrapped_by') {
        const cat = categoriseAttribute(ref.original.referenceName);
        if (cat) categoryMeta = { category: cat };
      }

      // Preserve any call-site / inheritance metadata propagated by the
      // language extractor (e.g. `isAwait`, `tryKind`, `spawnsTask`).
      const metadata: Record<string, unknown> = {
        ...(ref.original.metadata ?? {}),
        ...(categoryMeta ?? {}),
        confidence: ref.confidence,
        resolvedBy: ref.resolvedBy,
      };

      return {
        source: ref.original.fromNodeId,
        target: ref.targetNodeId,
        kind,
        line: ref.original.line,
        column: ref.original.column,
        metadata,
      };
    });
  }

  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs, onProgress);

    // Create edges from resolved references
    const edges = this.createEdges(result.resolved);

    // Insert edges into database
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }

    // Clean up resolved refs from unresolved_refs table so metrics are accurate
    if (result.resolved.length > 0) {
      this.queries.deleteSpecificResolvedReferences(
        result.resolved.map((r) => ({
          fromNodeId: r.original.fromNodeId,
          referenceName: r.original.referenceName,
          referenceKind: r.original.referenceKind,
        }))
      );
    }

    return result;
  }

  /**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000
  ): Promise<ResolutionResult> {
    this.warmCaches();

    const total = this.queries.getUnresolvedReferencesCount();
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };

    // Process in batches. We always read from offset 0 because resolved refs
    // are deleted after each batch, shifting the remaining rows forward.
    while (true) {
      const batch = this.queries.getUnresolvedReferencesBatch(0, batchSize);
      if (batch.length === 0) break;

      const result = this.resolveAll(batch);

      // Persist edges immediately
      const edges = this.createEdges(result.resolved);
      if (edges.length > 0) {
        this.queries.insertEdges(edges);
      }

      // Clean up resolved refs so they don't appear in the next batch
      if (result.resolved.length > 0) {
        this.queries.deleteSpecificResolvedReferences(
          result.resolved.map((r) => ({
            fromNodeId: r.original.fromNodeId,
            referenceName: r.original.referenceName,
            referenceKind: r.original.referenceKind,
          }))
        );
      }

      // Delete unresolvable refs from this batch to avoid re-processing them
      if (result.unresolved.length > 0) {
        this.queries.deleteSpecificResolvedReferences(
          result.unresolved.map((r) => ({
            fromNodeId: r.fromNodeId,
            referenceName: r.referenceName,
            referenceKind: r.referenceKind,
          }))
        );
      }

      // Aggregate stats
      aggregateStats.total += result.stats.total;
      aggregateStats.resolved += result.stats.resolved;
      aggregateStats.unresolved += result.stats.unresolved;
      for (const [method, count] of Object.entries(result.stats.byMethod)) {
        aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
      }

      processed += batch.length;
      onProgress?.(processed, total);

      // Yield so progress UI can render between batches
      await new Promise(resolve => setImmediate(resolve));

      // If nothing was resolved or removed in this batch, we'd loop forever
      // on the same rows. Break to avoid infinite loop.
      if (result.resolved.length === 0 && result.unresolved.length === batch.length) {
        break;
      }
    }

    return {
      resolved: [],
      unresolved: [],
      stats: aggregateStats,
    };
  }

  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /**
   * Check if reference is to a built-in or external symbol
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;
    const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
      || ref.language === 'tsx' || ref.language === 'jsx';

    // JavaScript/TypeScript built-ins
    if (isJsTs && JS_BUILT_INS.has(name)) {
      return true;
    }

    // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
    if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
      return true;
    }

    // React hooks from React itself
    if (isJsTs && REACT_HOOKS.has(name)) {
      return true;
    }

    // Python built-ins (bare calls only — dotted calls like console.print are method calls)
    if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
      return true;
    }

    // Python built-in method calls (e.g., list.extend, dict.update)
    if (ref.language === 'python') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        const method = name.substring(dotIdx + 1);
        // Filter calls on built-in types (list.append, dict.update, etc.)
        if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
          return true;
        }
        // Filter built-in methods on non-class receivers
        // (e.g., items.append where items is a local list variable)
        // But allow if the capitalized receiver matches a known codebase class
        if (PYTHON_BUILT_IN_METHODS.has(method)) {
          const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
          if (!this.knownNames?.has(capitalized)) {
            return true;
          }
        }
      }
      if (PYTHON_BUILT_IN_METHODS.has(name)) {
        return true;
      }
    }

    // Go standard library packages — refs like "fmt.Println", "http.ListenAndServe", etc.
    if (ref.language === 'go') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const pkg = name.substring(0, dotIdx);
        if (GO_STDLIB_PACKAGES.has(pkg)) {
          return true;
        }
      }
      if (GO_BUILT_INS.has(name)) {
        return true;
      }
    }

    // Pascal/Delphi built-ins and standard library units
    if (ref.language === 'pascal') {
      if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) {
        return true;
      }
      if (PASCAL_BUILT_INS.has(name)) {
        return true;
      }
    }

    // Swift built-in types and modules.
    // Stdlib PROTOCOLS (Sendable, Hashable, Codable, …) intentionally NOT
    // listed here — they have synthetic nodes registered via
    // `ensureSwiftBuiltins`, so we WANT the resolver to find them and
    // emit `conforms_to` edges instead of marking them external.
    if (ref.language === 'swift') {
      if (SWIFT_BUILTIN_TYPES.has(name)) {
        return true;
      }
      // Imports: `import Foundation`, `import UIKit`. The reference name
      // is the module path; `Foo.Bar` granular imports are also handled.
      if (ref.referenceKind === 'imports') {
        const root = name.split('.')[0];
        if (root && SWIFT_BUILTIN_MODULES.has(root)) {
          return true;
        }
      }
      // Member accesses on built-in types (`Int.max`, `String.UTF8View`,
      // `Optional.none`). Receiver-only check so a user-defined extension
      // on `Int` (`extension Int { var displayName: ... }`) still resolves.
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        if (SWIFT_BUILTIN_TYPES.has(receiver)) {
          // Don't short-circuit when the user has a node by that name —
          // they may have extended the type.
          if (!this.knownNames?.has(name)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
