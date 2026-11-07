/**
 * Types for lib/consumer-imports.mjs, the published subpath export
 * `@wolffm/fleet-manager/consumer-imports` (fleet-manager#67). mgmt-api
 * imports it under strict tsc, which refuses an untyped module (TS7016).
 * Kept beside the module, the way demand-derive.d.mts is; nodenext resolves
 * it from the `.mjs` target of the `exports` entry.
 */
export declare const PKG: '@wolffm/fleet-manager';
export declare const SOURCE: RegExp;
export declare const SKIP: RegExp;

export type BindingKind = 'value' | 'type' | 'default' | 'namespace' | 'module';

/** One thing a consumer takes from the package. `name` is null when only the subpath must resolve. */
export interface Binding {
	spec: string;
	name: string | null;
	kind: BindingKind;
}

/** A binding and every file that uses it. */
export interface Use extends Binding {
	usedBy: string[];
}

export declare function extractImports(source: string, opts?: { js?: boolean }): Binding[];

/** `files`: path -> text (null for a path that could not be read, which is skipped). Keyed by spec, name and kind. */
export declare function collectUses(files: Iterable<[string, string | null]>): Map<string, Use>;
