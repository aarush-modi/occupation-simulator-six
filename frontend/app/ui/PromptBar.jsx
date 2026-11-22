'use client';
// The one input of the lobby, written as a sentence to finish: "Today I want to be a ___". The blank shows a
// default job in a darker tone, so it reads as something to type over; sending it empty starts that default.
// UI SDK supplies the behaviour (auto-growing textarea, Enter to send, a send button that stays pending).
import { useRef, useState } from 'react';
import { Textarea } from '@ui-sdk/react/textarea';
import { Button } from '@ui-sdk/react/button';
import { backendUrl } from '../../src/engine/config';
import { articleFor } from './promptSentence';

/** Create a room for `occupation` and return the URL of its shift page. */
export async function startShift(occupation) {
  const r = await fetch(`${backendUrl()}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occupation }),
  }).catch(() => { throw new Error('Could not reach the shift server.'); });
  if (!r.ok) throw new Error(`The shift server said ${r.status}.`);
  const { roomId } = await r.json();
  return `/shift?room=${encodeURIComponent(roomId)}&host=1&job=${encodeURIComponent(occupation)}`;
}

export default function PromptBar({ initial = '', onStarted, autoFocus = true, fallback = 'barista' }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sending = useRef(false); // Enter and the button can both fire before a re-render
  const text = value.trim() || fallback;
  const article = articleFor(value.trim() || fallback);

  const send = async () => {
    if (!text || sending.current) return;
    sending.current = true;
    setBusy(true); setError(null);
    try {
      onStarted(await startShift(text));
    } catch (e) {
      setError(e.message);
      setBusy(false);
      sending.current = false;
    }
  };

  return (
    <div className="ws-composer-wrap">
      <form className="ws-composer ws-sentence" data-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); send(); }}>
        <span className="ws-sentence-lead" aria-hidden="true">Today I want to be{article ? ` ${article}` : ''}</span>
        <Textarea
          className="ws-composer-input ws-blank"
          aria-label="Today I want to be a…"
          placeholder={fallback}
          value={value}
          onValueChange={setValue}
          autoResize
          rows={1}
          maxLength={320}
          submitShortcut="enter"
          onSubmit={send}
          autoFocus={autoFocus}
          readOnly={busy}
          spellCheck={false}
        />
        <Button className="ws-send" type="button" aria-label={`Start a shift as ${article ? `${article} ` : ''}${text}`} onClick={send} pendingAnnouncement="Starting your shift">
          <svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true" shapeRendering="crispEdges">
            <path fill="currentColor" d="M4 1h2v1h1v1h1v1h1v2H8v1H7v1H6v1H4V7h1V6H1V4h4V3H4z" />
          </svg>
        </Button>
      </form>
      {error && <p className="ws-composer-error" role="alert">{error}</p>}
    </div>
  );
}
