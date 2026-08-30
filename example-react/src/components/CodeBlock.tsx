import { useState } from 'react';

/**
 * Shows an example's own source. The text comes from Vite's `?raw` import in
 * `registry.ts`, so it is literally the file running above it and can never
 * drift out of date the way a hand-copied snippet would.
 */
export function CodeBlock({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context) - not worth surfacing */
    }
  };

  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-edge">
      <header className="flex items-center justify-between bg-panel px-4 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-sm font-medium text-slate-300 hover:text-slate-100"
        >
          {open ? '▾' : '▸'} Source for this page
        </button>
        {open && (
          <button onClick={copy} className="text-xs text-slate-400 hover:text-slate-200">
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </header>

      {open && (
        <pre className="max-h-[28rem] overflow-auto bg-[#0a0e13] p-4 text-[12px] leading-relaxed">
          <code className="text-slate-300">{source}</code>
        </pre>
      )}
    </section>
  );
}
