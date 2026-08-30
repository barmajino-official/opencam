/**
 * @opencam/client - realtime computer vision for the browser.
 *
 * The React bindings live at `@opencam/client/react` so that a non-React
 * consumer never pulls React into their bundle.
 */

export { OpenCam, createOpenCam } from './opencam.js';
export { drawSnapshot, computeFit } from './overlay.js';
export { EMPTY_SNAPSHOT, select, snapshotFrom, SELECTORS } from './snapshot.js';
export { resolveSource, isServerOnlyUrl } from './sources.js';
export { exchangeSdp, waitForIceGathering } from './signalling.js';
export { MetadataSocket } from './socket.js';
export type * from './types.js';
