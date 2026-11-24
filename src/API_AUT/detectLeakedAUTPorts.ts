import net from 'node:net';

import { logAndThrow } from './requireValidArguments.js';

/**
 * Catches a teardown that silently failed to free a port — i.e. a leak: `close()` ran,
 * `isSelfManaged` flipped back to `false`, but the real OS-level socket is still bound because
 * the consumer's own `closeHandler` didn't actually do its job (or the AUT ignored its
 * shutdown signal). Deliberately checks real socket connectivity, not any of
 * `API_AUTWrapper`'s own bookkeeping — `close()` marks itself "closed" unconditionally, even
 * when the underlying `closeHandler` itself threw, so that bookkeeping alone can never answer
 * "did it genuinely stop".
 */

/**
 * Every AUT name this process has itself actually **bootstrapped** — i.e. a real `bootstrapper`
 * was supplied and genuinely invoked for it — with its resolved `host`/`port`. Additive only,
 * deliberately **never** cleared when a test ends (unlike the name registry itself), so
 * {@link assertNoManagedAUTPortsOpen} has something to check against at the start of the
 * *next* test, after this test's own teardown has already wiped the name registry clean.
 *
 * Deliberately **not** every name ever registered — only AUTs this process genuinely started
 * itself. A name registered purely to reach an already-running external target (see
 * `API_AUTWrapper.prepareApplication`'s own doc comment) was never started by this process in
 * the first place, so there is nothing for "is it still listening" to mean anything about:
 * that target being reachable is the correct, desired state, not evidence of a leaked
 * teardown. Including it here would make {@link assertNoManagedAUTPortsOpen} fail
 * permanently, every test, the moment any test ever touches such a target.
 */
const bootstrappedEndpoints = new Map<string, { host: string; port: number }>();

/**
 * Records `appName`'s resolved `host`/`port` into {@link bootstrappedEndpoints}, if `port` is
 * actually known yet — called whenever `API_AUTWrapper` genuinely invokes a real
 * `bootstrapper` for `appName` (see {@link bootstrappedEndpoints}'s own doc comment for why
 * that guard matters).
 */
export function rememberBootstrappedAddress(appName: string, host: string, port: number | undefined): void {
  if (port !== undefined) {
    bootstrappedEndpoints.set(appName, { host, port });
  }
}

/**
 * Resolves `true` if anything answers a plain TCP connect on `host:port`, `false` if the
 * attempt is refused or doesn't complete within `timeoutMS` — ground truth for "is this port
 * actually still open", independent of any in-memory bookkeeping.
 */
export function isPortStillOpen(host: string, port: number, timeoutMS = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Verifies none of this process's ever-bootstrapped AUT endpoints ({@link bootstrappedEndpoints})
 * still has anything open — meant to be called at the very start of the *next* test, before it
 * does anything else, so a previous test's teardown failure (a genuine bug, or a badly-behaved
 * AUT that ignored its own shutdown signal) is caught immediately rather than silently letting
 * the next test start against a stale, still-running instance. Deliberately scoped to
 * self-managed AUTs only — see {@link bootstrappedEndpoints}'s own doc comment for why a
 * remote AUT or an API is excluded.
 */
export async function assertNoManagedAUTPortsOpen(): Promise<void> {
  const stillOpen: string[] = [];
  for (const [appName, { host, port }] of bootstrappedEndpoints) {
    if (await isPortStillOpen(host, port)) {
      stillOpen.push(`[${appName}] ${host}:${port}`);
    }
  }
  if (stillOpen.length > 0) {
    logAndThrow(
      'AUT',
      `${stillOpen.length} managed AUT(s) still have an open port at test start — the previous test's teardown did not actually stop them:\n${stillOpen.join('\n')}`
    );
  }
}
