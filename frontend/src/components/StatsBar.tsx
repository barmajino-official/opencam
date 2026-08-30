import type { Capabilities, ConnectionState, InferenceMessage } from '../types';

interface StatsBarProps {
  inference: InferenceMessage | null;
  capabilities: Capabilities | null;
  socketState: ConnectionState;
}

const LATENCY_BUDGET_MS = 150;

function Metric({
  label,
  value,
  unit,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-accent'
      : tone === 'warn'
        ? 'text-amber-400'
        : tone === 'bad'
          ? 'text-rose-400'
          : 'text-slate-200';

  return (
    <div className="flex min-w-[84px] flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className={`font-mono text-base leading-none ${toneClass}`}>
        {value}
        {unit && <span className="ml-0.5 text-[10px] text-slate-500">{unit}</span>}
      </span>
    </div>
  );
}

export function StatsBar({ inference, capabilities, socketState }: StatsBarProps) {
  const stats = inference?.stats;
  const latency = inference?.end_to_end_ms ?? 0;

  // The <150 ms design target, made visible rather than documented.
  const latencyTone = !inference
    ? 'default'
    : latency <= LATENCY_BUDGET_MS
      ? 'good'
      : latency <= LATENCY_BUDGET_MS * 2
        ? 'warn'
        : 'bad';

  const dropRate =
    stats && stats.frames_in > 0 ? (stats.frames_dropped / stats.frames_in) * 100 : 0;

  const audioLevel = inference?.audio.level ?? 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Pipeline telemetry</span>
        <span className="chip">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              socketState === 'connected'
                ? 'animate-pulse-dot bg-accent'
                : socketState === 'error'
                  ? 'bg-rose-500'
                  : 'bg-amber-400'
            }`}
          />
          {socketState}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-4 px-4 py-3.5">
        <Metric label="End-to-end" value={latency.toFixed(0)} unit="ms" tone={latencyTone} />
        <Metric label="Model" value={(stats?.inference_ms ?? 0).toFixed(0)} unit="ms" />
        <Metric label="Capture" value={(stats?.capture_fps ?? 0).toFixed(0)} unit="fps" />
        <Metric label="Inference" value={(stats?.inference_fps ?? 0).toFixed(0)} unit="fps" />
        <Metric label="OCR" value={(stats?.ocr_ms ?? 0).toFixed(0)} unit="ms" />
        <Metric
          label="Dropped"
          value={dropRate.toFixed(0)}
          unit="%"
          tone={dropRate > 80 ? 'warn' : 'default'}
        />
        <Metric label="Objects" value={inference?.objects.length ?? 0} />
        <Metric label="Faces" value={inference?.faces.length ?? 0} />
        <Metric label="Text" value={inference?.texts.length ?? 0} />

        <div className="flex min-w-[120px] flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Mic level</span>
          <div className="h-2 w-full overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-accent-dim transition-[width] duration-100"
              // Amplitude is perceptually compressed; a square-root curve makes
              // normal speech occupy the visible middle of the meter.
              style={{ width: `${Math.min(100, Math.sqrt(audioLevel) * 160)}%` }}
            />
          </div>
        </div>
      </div>

      {capabilities && (
        <div className="flex flex-wrap gap-1.5 border-t border-ink-700 px-4 py-2.5">
          {Object.entries(capabilities).map(([name, enabled]) => (
            <span
              key={name}
              className={`chip ${
                enabled
                  ? 'border-accent-dim/40 text-accent'
                  : 'border-ink-600 text-slate-600 line-through'
              }`}
            >
              {name.replace('_', ' ')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
