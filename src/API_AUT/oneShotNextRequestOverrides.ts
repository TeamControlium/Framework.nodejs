import { APIUtils, JsonUtils, Log, LogLevels, Utils, ValueExpression } from '@controlium/utils';

/**
 * Resolves a one-shot override's raw `dataTableValueExpressions` source text (unresolved
 * `ValueExpression.parse` input, staged below) into actual values — `file:` source
 * included, same as `@controlium/cucumber`'s own session-level DataTable handling, just
 * resolved here, at consumption time, instead of at step-definition time. Cast verbs
 * (`number:`/`boolean:`/`json:`) are deliberately disabled (`allowCastVerbs: false`) — a
 * header/query-param value only ever ends up as text on the wire regardless, so a cast
 * either buys nothing (`number:42` and plain `42` produce identical wire text) or actively
 * forbids something with no valid wire representation at all (`json:`'s object/array
 * result). Disabling them removes the one real cost instead: a value that happens to start
 * with a recognised verb's name (e.g. literally wanting the text `json:hello`) is no longer
 * misread as a cast attempt.
 *
 * `undefined` (no `dataTableValueExpressions` was ever staged for this override) resolves
 * to `{}` — nothing to merge in.
 */
async function resolveStagedDataTableExpressions(raw: Record<string, string> | undefined): Promise<Record<string, unknown>> {
  if (Utils.isUndefined(raw)) return {};
  const resolvedEntries = await Promise.all(
    Object.entries(raw).map(async ([key, value]) => [key, await ValueExpression.parse(value, { useJson5: true, allowCastVerbs: false })] as const)
  );
  return Object.fromEntries(resolvedEntries);
}

/**
 * The one-shot header/query-param overrides staged via `API_AUTWrapper.setNextRequestHeaders`/
 * `mergeNextRequestHeaders`/`setNextRequestQueryParams`/`mergeNextRequestQueryParams` — applied
 * to whichever AUT's `request()` fires next, across the whole test, regardless of which AUT
 * that turns out to be. Genuinely global state (not scoped to one instance), because there's
 * no AUT to target when a test stages one — it's staged without naming an instance at all.
 *
 * `dataTableValueExpressions` — raw, **unresolved** `ValueExpression.parse` source text from a
 * table/config cell's `Value` column — is carried separately from the literal `values`
 * themselves, rather than pre-resolved and merged in at staging time: a one-shot override's
 * whole point is reflecting the freshest possible state at the moment it's actually consumed,
 * and resolving such a cell's verb-grammar eagerly, at staging time, would silently defeat
 * that for exactly the entries sourced this way. Resolved lazily by {@link takeStagedRequestHeaders}/
 * {@link takeStagedRequestQueryParams}, at the moment `request()` actually consumes it.
 */
interface PendingHeaderOverride {
  mode: 'replace' | 'merge';
  headers: APIUtils.HTTPHeaders;
  dataTableValueExpressions?: Record<string, string>;
}

let pendingHeaderOverride: PendingHeaderOverride | undefined;

/** Stages a one-shot header override — `mode: 'replace'`/`'merge'` matches
 * `API_AUTWrapper.setNextRequestHeaders`/`mergeNextRequestHeaders`. */
export function stageNextRequestHeaders(mode: 'replace' | 'merge', headers: APIUtils.HTTPHeaders, dataTableValueExpressions?: Record<string, string>): void {
  pendingHeaderOverride = { mode, headers, dataTableValueExpressions };
}

/** Clears any staged one-shot header override without it ever being applied to a request. */
export function forgetStagedRequestHeaders(): void {
  pendingHeaderOverride = undefined;
}

/**
 * Consumes (resolves + clears) any staged one-shot header override, for `request()` to call
 * right before it builds the outgoing headers. Returns `undefined` when nothing was staged —
 * the caller's own session headers apply unchanged. Clears the staged override immediately,
 * before anything below can throw, so "used once, no exceptions" holds regardless of what
 * happens to the rest of the request this override was meant for.
 *
 * `currentSessionHeaders` is read fresh, right now, not a snapshot taken when the override was
 * originally staged — merge mode needs to see whatever this AUT's session headers are *at the
 * moment this override is actually consumed*.
 */
export async function takeStagedRequestHeaders(appName: string, currentSessionHeaders: APIUtils.HTTPHeaders): Promise<APIUtils.HTTPHeaders | undefined> {
  const pending = pendingHeaderOverride;
  forgetStagedRequestHeaders();
  if (Utils.isUndefined(pending)) return undefined;

  const resolvedDataTableHeaders = await resolveStagedDataTableExpressions(pending.dataTableValueExpressions);
  const combinedOverrideHeaders = { ...pending.headers, ...resolvedDataTableHeaders } as APIUtils.HTTPHeaders;
  APIUtils.assertPrimitiveValues(combinedOverrideHeaders, 'header');

  const resolved = JsonUtils.resolveSentinels(
    pending.mode === 'replace' ? combinedOverrideHeaders : { ...currentSessionHeaders, ...combinedOverrideHeaders }
  );
  Log.writeLine(
    LogLevels.TestDebug,
    `[${appName}] applying one-shot next-request header override (${pending.mode}):\n${Utils.safeStringify(resolved)}`,
    { suppressMultilinePreamble: true }
  );
  return resolved;
}

/** The query-params twin of {@link PendingHeaderOverride} — identical shape and lifecycle,
 * see its own doc comment for the full reasoning (not repeated here). */
interface PendingQueryParamOverride {
  mode: 'replace' | 'merge';
  queryParams: APIUtils.QueryParams;
  dataTableValueExpressions?: Record<string, string>;
}

let pendingQueryParamOverride: PendingQueryParamOverride | undefined;

/** Stages a one-shot query-params override — `mode: 'replace'`/`'merge'` matches
 * `API_AUTWrapper.setNextRequestQueryParams`/`mergeNextRequestQueryParams`. */
export function stageNextRequestQueryParams(mode: 'replace' | 'merge', queryParams: APIUtils.QueryParams, dataTableValueExpressions?: Record<string, string>): void {
  pendingQueryParamOverride = { mode, queryParams, dataTableValueExpressions };
}

/** Clears any staged one-shot query-params override without it ever being applied to a
 * request. */
export function forgetStagedRequestQueryParams(): void {
  pendingQueryParamOverride = undefined;
}

/** The query-params twin of {@link takeStagedRequestHeaders} — see its own doc comment for
 * the full reasoning (not repeated here). */
export async function takeStagedRequestQueryParams(appName: string, currentSessionQueryParams: APIUtils.QueryParams): Promise<APIUtils.QueryParams | undefined> {
  const pending = pendingQueryParamOverride;
  forgetStagedRequestQueryParams();
  if (Utils.isUndefined(pending)) return undefined;

  const resolvedDataTableQueryParams = await resolveStagedDataTableExpressions(pending.dataTableValueExpressions);
  const combinedOverrideQueryParams = { ...pending.queryParams, ...resolvedDataTableQueryParams } as APIUtils.QueryParams;
  APIUtils.assertPrimitiveValues(combinedOverrideQueryParams, 'query parameter');

  const resolved = JsonUtils.resolveSentinels(
    pending.mode === 'replace' ? combinedOverrideQueryParams : { ...currentSessionQueryParams, ...combinedOverrideQueryParams }
  );
  Log.writeLine(
    LogLevels.TestDebug,
    `[${appName}] applying one-shot next-request query-params override (${pending.mode}):\n${Utils.safeStringify(resolved)}`,
    { suppressMultilinePreamble: true }
  );
  return resolved;
}
