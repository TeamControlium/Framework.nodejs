import { APIUtils, Utils } from '@controlium/utils';

/**
 * The `request()`'s `followRedirects` hop logic — deciding whether a response counts as a
 * redirect worth following, finding the `Location` header to follow, and building the next
 * hop's request from it.
 */

/** Hop cap for `RequestOptions.followRedirects` — an AUT redirecting forever is never
 * followed silently; matches the conventional browser/`fetch` limit. */
export const MAX_REDIRECTS_FOLLOWED = 20;

/** `true` for the status codes `RequestOptions.followRedirects` recognises as a redirect
 * worth following. */
export function isARedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** The `Location` header value from a (possibly repeated) response header, case-insensitive-
 * by-already-lowercased-key — `response.headers` keys are already lowercased by
 * `RawHttpResponseParser`, so a plain lookup is enough. `undefined` if absent or if the AUT
 * sent more than one and this takes the first. */
export function locationHeaderValue(headers: Record<string, string | string[]>): string | undefined {
  const value = headers['location'];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Builds the next hop's request for `request()`'s `followRedirects` loop — resolving
 * `location` (absolute or relative) against `previous`'s own URL, and applying standard
 * browser/`fetch` compatibility semantics: `301`/`302`/`303` downgrade the method to `GET` and
 * drop the body; `307`/`308` preserve both exactly. Headers are carried over unchanged on
 * every hop — this is a test framework talking to AUTs under test, not untrusted public
 * browsing, so browsers' own cross-origin header-stripping doesn't apply here.
 */
export function buildNextHopRequest(previous: APIUtils.HTTPRequest, status: number, location: string): APIUtils.HTTPRequest {
  const queryStringSuffix = Utils.isNullOrUndefined(previous.queryString)
    ? ''
    : previous.queryString.startsWith('?') ? previous.queryString : `?${previous.queryString}`;
  const previousUrl = new URL(`${previous.protocol}://${previous.host}${previous.resourcePath}${queryStringSuffix}`);
  const nextUrl = new URL(location, previousUrl);
  const preserveMethodAndBody = status === 307 || status === 308;

  return {
    ...previous,
    protocol: nextUrl.protocol === 'https:' ? 'https' : 'http',
    host: nextUrl.host,
    resourcePath: nextUrl.pathname,
    queryString: nextUrl.search === '' ? undefined : nextUrl.search,
    method: preserveMethodAndBody ? previous.method : 'GET',
    body: preserveMethodAndBody ? previous.body : undefined,
  };
}
