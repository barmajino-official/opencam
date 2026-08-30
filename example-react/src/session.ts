/**
 * Session identity for this browser tab.
 *
 * Lives in its own module for a reason: it used to be computed in `App.tsx` and
 * re-derived in the multi-session example, but `registry.ts` eagerly imports
 * every example, so the example module evaluated FIRST and read an empty
 * `sessionStorage` — producing `cam-a-x` on a cold load and the correct id only
 * after a reload. A single module both files import removes the ordering
 * question entirely.
 *
 * Scope is per tab on purpose: publishing to a session that already has a
 * publisher REPLACES it, so two tabs sharing an id silently evict each other.
 */

const KEY = 'opencam-example-session';

function derive(): string {
  const fresh = `ex-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Private mode / storage blocked. A per-load id is still better than a
    // shared one.
    return fresh;
  }
}

/** e.g. `ex-9u85ba` — stable for the lifetime of this tab. */
export const SESSION_ID = derive();

/** The random part, for deriving sibling ids like `cam-a-9u85ba`. */
export const SESSION_SUFFIX = SESSION_ID.replace(/^ex-/, '');

export const BACKEND_URL =
  (import.meta.env.VITE_OPENCAM_URL as string | undefined) ?? 'http://127.0.0.1:8081';
