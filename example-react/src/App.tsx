import { useCallback, useEffect, useState } from 'react';
import { OpenCamProvider } from '@opencam/client/react';
import { CodeBlock } from './components/CodeBlock';
import { MobilePicker, Shell } from './components/Shell';
import { EXAMPLES, findExample } from './registry';
import { BACKEND_URL, SESSION_ID } from './session';



/** Route = the URL hash, so every example is linkable and survives reload. */
function readHash(): string {
  const id = window.location.hash.replace(/^#\/?/, '').trim();
  return findExample(id) ? id : EXAMPLES[0]!.id;
}

export default function App() {
  const [current, setCurrent] = useState(readHash);

  useEffect(() => {
    const onChange = () => setCurrent(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((id: string) => {
    window.location.hash = `/${id}`;
  }, []);

  const example = findExample(current) ?? EXAMPLES[0]!;
  const { Component } = example;

  return (
    <Shell current={current} onNavigate={navigate}>
      {/*
        One provider wraps every example, so switching pages does not tear down
        the camera and renegotiate WebRTC. `sessionId` is fixed here; the
        multi-session example creates its own providers to show that case.

        The backend lives on another port, so its origin must be given
        explicitly and must appear in the backend's CORS_ALLOW_ORIGINS. Override
        with VITE_OPENCAM_URL to point somewhere else.
      */}
      <OpenCamProvider url={BACKEND_URL} sessionId={SESSION_ID}>
        <div className="mx-auto max-w-5xl px-5 py-8">
          <div className="mb-6 md:hidden">
            <MobilePicker current={current} onNavigate={navigate} />
          </div>

          <header className="mb-6">
            <h2 className="text-2xl font-semibold text-slate-100">{example.title}</h2>
            <p className="mt-1 text-sm text-slate-400">{example.blurb}</p>
            <p className="mt-2 text-xs text-slate-600">
              session <code className="text-slate-500">{SESSION_ID}</code> · backend{' '}
              <code className="text-slate-500">{BACKEND_URL}</code>
            </p>
          </header>

          <Component key={example.id} />

          <CodeBlock source={example.source} />
        </div>
      </OpenCamProvider>
    </Shell>
  );
}
