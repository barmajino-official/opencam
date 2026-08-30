import { memo, useMemo } from 'react';
import type { InferenceMessage } from '../types';

interface CanvasOverlayProps {
  result: InferenceMessage | null;
  showObjects: boolean;
  showFaces: boolean;
  showTexts: boolean;
  /** Set when the underlying <video> is CSS-mirrored (selfie preview). */
  mirrored?: boolean;
}

/** Same deterministic hue mapping the backend annotator uses, in HSL. */
function labelHue(label: string): number {
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

const FACE_KNOWN = '#4ade80';
const FACE_UNKNOWN = '#60a5fa';
const TEXT_COLOR = '#fbbf24';

interface PlateProps {
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  anchorBelow?: boolean;
}

/**
 * SVG has no "text with background" primitive, so the plate is a rect sized
 * from an em-based width estimate. Estimating beats measuring here: getBBox()
 * would force a synchronous layout on every one of ~20 boxes per frame.
 */
function Plate({ x, y, text, color, fontSize, anchorBelow = false }: PlateProps) {
  const paddingX = fontSize * 0.4;
  const height = fontSize * 1.5;
  const width = text.length * fontSize * 0.56 + paddingX * 2;
  const top = anchorBelow ? y + 2 : Math.max(0, y - height - 2);

  return (
    <g>
      <rect x={x} y={top} width={width} height={height} rx={fontSize * 0.28} fill={color} />
      <text
        x={x + paddingX}
        y={top + height * 0.72}
        fontSize={fontSize}
        fontFamily="ui-monospace, monospace"
        fontWeight={600}
        fill="#0b0f14"
      >
        {text}
      </text>
    </g>
  );
}

function CanvasOverlayImpl({
  result,
  showObjects,
  showFaces,
  showTexts,
  mirrored = false,
}: CanvasOverlayProps) {
  const frame = result?.frame;

  // Scale annotation stroke/label size with frame resolution so a 1080p stream
  // does not end up with hairline boxes and unreadable 4px labels.
  const scale = useMemo(() => (frame ? Math.max(frame.w, frame.h) / 640 : 1), [frame]);

  if (!result || !frame || frame.w === 0 || frame.h === 0) return null;

  const stroke = 2 * scale;
  const fontSize = 13 * scale;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${frame.w} ${frame.h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {/* One transform mirrors the whole annotation layer to match a mirrored preview. */}
      <g transform={mirrored ? `translate(${frame.w} 0) scale(-1 1)` : undefined}>
        {showObjects &&
          result.objects.map((item, index) => {
            const [x, y, width, height] = item.box;
            const color = `hsl(${labelHue(item.label)} 85% 62%)`;
            return (
              <g key={`obj-${index}-${item.label}`}>
                <rect
                  x={x}
                  y={y}
                  width={width}
                  height={height}
                  fill="none"
                  stroke={color}
                  strokeWidth={stroke}
                  rx={3 * scale}
                />
                <Plate
                  x={x}
                  y={y}
                  text={`${item.label} ${Math.round(item.conf * 100)}%`}
                  color={color}
                  fontSize={fontSize}
                />
              </g>
            );
          })}

        {showTexts &&
          result.texts.map((item, index) => (
            <g key={`txt-${index}`}>
              <polygon
                points={item.quad.map(([px, py]) => `${px},${py}`).join(' ')}
                fill="none"
                stroke={TEXT_COLOR}
                strokeWidth={stroke}
              />
              <Plate
                x={item.box[0]}
                y={item.box[1]}
                text={item.text.slice(0, 28)}
                color={TEXT_COLOR}
                fontSize={fontSize * 0.9}
              />
            </g>
          ))}

        {showFaces &&
          result.faces.map((face, index) => {
            const [x, y, width, height] = face.box;
            const known = face.name !== 'Unknown';
            const color = known ? FACE_KNOWN : FACE_UNKNOWN;
            const caption =
              known && face.similarity !== null
                ? `${face.name} ${face.similarity.toFixed(2)}`
                : face.name;

            return (
              <g key={`face-${index}`}>
                <rect
                  x={x}
                  y={y}
                  width={width}
                  height={height}
                  fill="none"
                  stroke={color}
                  strokeWidth={stroke}
                  rx={4 * scale}
                />
                <Plate x={x} y={y} text={caption} color={color} fontSize={fontSize} />
                {face.emotion && (
                  <Plate
                    x={x}
                    y={y + height}
                    text={`${face.emotion.label} ${Math.round(face.emotion.conf * 100)}%`}
                    color="#c4b5fd"
                    fontSize={fontSize * 0.9}
                    anchorBelow
                  />
                )}
              </g>
            );
          })}
      </g>
    </svg>
  );
}

// Re-render only when a genuinely new inference frame arrives or a layer is
// toggled — not on every unrelated parent state change.
export const CanvasOverlay = memo(CanvasOverlayImpl, (previous, next) => {
  return (
    previous.result?.seq === next.result?.seq &&
    previous.showObjects === next.showObjects &&
    previous.showFaces === next.showFaces &&
    previous.showTexts === next.showTexts &&
    previous.mirrored === next.mirrored
  );
});
