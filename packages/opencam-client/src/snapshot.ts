/**
 * Snapshot construction and the selector table behind `OpenCam.get()`.
 *
 * A snapshot is a frozen, plain-object view of exactly one inference pass. It
 * is replaced wholesale rather than mutated, which makes reference equality a
 * valid "did anything change?" test — the property React's `useSyncExternalStore`
 * depends on to avoid re-rendering on every frame.
 */

import type {
  InferenceMessage,
  OpenCamKey,
  OpenCamValueMap,
  Snapshot,
} from './types.js';

export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  seq: -1,
  receivedAt: 0,
  frame: null,
  objects: [],
  faces: [],
  people: [],
  texts: [],
  audioLevel: 0,
  stats: null,
  latencyMs: 0,
});

export function snapshotFrom(message: InferenceMessage): Snapshot {
  return Object.freeze({
    seq: message.seq,
    receivedAt: Date.now(),
    frame: message.frame ?? null,
    objects: message.objects ?? [],
    faces: message.faces ?? [],
    people: message.people ?? [],
    texts: message.texts ?? [],
    audioLevel: message.audio?.level ?? 0,
    stats: message.stats ?? null,
    latencyMs: message.end_to_end_ms ?? 0,
  });
}

/**
 * Selector per key. Keeping these in a table rather than a `switch` means the
 * compiler checks that every key in `OpenCamValueMap` has an implementation,
 * and that each one returns the declared type.
 */
type SelectorTable = {
  [K in OpenCamKey]: (snapshot: Snapshot) => OpenCamValueMap[K];
};

export const SELECTORS: SelectorTable = {
  objects: (s) => s.objects,
  faces: (s) => s.faces,
  people: (s) => s.people,
  persons: (s) => s.people,

  // `people` is sorted nearest-first by the backend, so element 0 is "the
  // user" in every single-subject deployment.
  distance: (s) => s.people.find((p) => p.distance_m !== null)?.distance_m ?? null,
  emotion: (s) => s.people.find((p) => p.emotion)?.emotion ?? null,

  names: (s) =>
    Array.from(
      new Set(
        s.people
          .map((p) => p.name)
          .filter((name): name is string => Boolean(name) && name !== 'Unknown'),
      ),
    ),

  text: (s) => s.texts.map((t) => t.text),
  texts: (s) => s.texts,
  audio: (s) => s.audioLevel,
  stats: (s) => s.stats,
  frame: (s) => s.frame,

  count: (s) => ({
    objects: s.objects.length,
    people: s.people.length,
    faces: s.faces.length,
    texts: s.texts.length,
  }),

  raw: (s) => s,
};

export function select<K extends OpenCamKey>(snapshot: Snapshot, key: K): OpenCamValueMap[K] {
  const selector = SELECTORS[key];
  if (!selector) {
    throw new Error(
      `unknown key '${String(key)}'. Valid keys: ${Object.keys(SELECTORS).join(', ')}`,
    );
  }
  return selector(snapshot);
}
