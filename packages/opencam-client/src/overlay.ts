/**
 * Client-side canvas overlay.
 *
 * This is the zero-added-latency annotation path: the video element shows the
 * untouched stream and boxes are painted on a canvas above it, so the picture
 * never makes a round trip. Only the JSON does.
 *
 * The whole thing hinges on one alignment rule. Detection coordinates are in
 * *source-frame* pixels, but a `<video>` with `object-fit: contain` letterboxes
 * the frame inside whatever box CSS gave it. `computeFit()` reproduces exactly
 * the same letterbox maths the browser applies, which is why boxes stay glued
 * to their subjects at any element size. Change the element to `object-fit:
 * cover` and the overlay will drift — the fit function has to match the CSS.
 */

import type { OverlayOptions, Snapshot } from './types.js';

const DEFAULT_COLORS = {
  object: '#38bdf8',
  face: '#4ade80',
  person: '#c084fc',
  text: '#fbbf24',
} as const;

interface Fit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Letterbox transform from source-frame pixels to canvas pixels. */
export function computeFit(
  frameW: number,
  frameH: number,
  viewW: number,
  viewH: number,
): Fit {
  const scale = Math.min(viewW / frameW, viewH / frameH);
  return {
    scale,
    offsetX: (viewW - frameW * scale) / 2,
    offsetY: (viewH - frameH * scale) / 2,
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawPlate(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  const padding = 5;
  const metrics = ctx.measureText(text);
  const height = 18;
  const width = metrics.width + padding * 2;
  // Flip below the box when there is no room above it.
  const top = y - height - 2 < 0 ? y + 2 : y - height - 2;

  ctx.fillStyle = color;
  roundRect(ctx, x, top, width, height, 4);
  ctx.fill();

  ctx.fillStyle = '#0b0f14';
  ctx.fillText(text, x + padding, top + height - 5);
}

/**
 * Paint one snapshot onto a canvas.
 *
 * The canvas is resized to its own CSS box scaled by devicePixelRatio, so text
 * stays crisp on retina displays instead of being upscaled from CSS pixels.
 */
export function drawSnapshot(
  canvas: HTMLCanvasElement,
  snapshot: Snapshot,
  options: OverlayOptions = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;

  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const frame = snapshot.frame;
  if (!frame) return;

  const {
    objects: showObjects = true,
    faces: showFaces = true,
    people: showPeople = false,
    texts: showTexts = true,
    distance: showDistance = true,
    labels = true,
    mirrored = false,
    lineWidth = 2,
    font = '600 13px ui-sans-serif, system-ui, sans-serif',
    colors = {},
  } = options;

  const palette = { ...DEFAULT_COLORS, ...colors };
  const fit = computeFit(frame.w, frame.h, cssW, cssH);

  ctx.save();
  if (mirrored) {
    // Matches a CSS `transform: scaleX(-1)` on the video element.
    ctx.translate(cssW, 0);
    ctx.scale(-1, 1);
  }
  ctx.lineWidth = lineWidth;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';

  const toView = (box: readonly number[]): [number, number, number, number] => [
    box[0]! * fit.scale + fit.offsetX,
    box[1]! * fit.scale + fit.offsetY,
    box[2]! * fit.scale,
    box[3]! * fit.scale,
  ];

  const stroke = (box: readonly number[], color: string, caption: string | null) => {
    const [x, y, w, h] = toView(box);
    ctx.strokeStyle = color;
    roundRect(ctx, x, y, w, h, 6);
    ctx.stroke();
    if (caption && labels) {
      // Labels are drawn unmirrored so text stays readable in a selfie view.
      if (mirrored) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawPlate(ctx, caption, cssW - x - w, y, color);
        ctx.restore();
      } else {
        drawPlate(ctx, caption, x, y, color);
      }
    }
  };

  if (showObjects) {
    for (const object of snapshot.objects) {
      let caption = `${object.label} ${Math.round(object.conf * 100)}%`;
      if (showDistance && object.distance_m !== null) caption += `  ~${object.distance_m}m`;
      stroke(object.box, palette.object, caption);
    }
  }

  if (showPeople) {
    for (const person of snapshot.people) {
      let caption = person.name && person.name !== 'Unknown' ? person.name : `#${person.id}`;
      if (showDistance && person.distance_m !== null) caption += `  ${person.distance_m}m`;
      stroke(person.box, palette.person, caption);
    }
  }

  if (showFaces) {
    for (const face of snapshot.faces) {
      let caption = face.name;
      if (face.emotion) caption += ` - ${face.emotion.label}`;
      if (showDistance && face.distance_m !== null) caption += `  ${face.distance_m}m`;
      stroke(face.box, palette.face, caption);
    }
  }

  if (showTexts) {
    for (const item of snapshot.texts) {
      stroke(item.box, palette.text, item.text.slice(0, 24));
    }
  }

  ctx.restore();
}
