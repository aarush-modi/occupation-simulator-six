'use client';
// The one input of the lobby: a chat-style composer. UI SDK supplies the behaviour (auto-growing textarea,
// Enter to send and Shift+Enter for a new line, a send button that stays pending while the shift starts).
import { useRef, useState } from 'react';
import { Textarea } from '@ui-sdk/react/textarea';
import { Button } from '@ui-sdk/react/button';
import { backendUrl } from '../../src/engine/config';

/** Create a room for `occupation` and return the URL of its shift page. */
export async function startShift(occupation) {
  const r = await fetch(`${backendUrl()}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occupation }),
  }).catch(() => { throw new Error('Could not reach the shift server.'); });
  if (!r.ok) throw new Error(`The shift server said ${r.status}.`);
  const { roomId } = await r.json();
  return `/shift?room=${encodeURIComponent(roomId)}&host=1&job=${encodeURIComponent(occupation)}`;
}

export default function PromptBar({ initial = '', onStarted, autoFocus = true, placeholder = 'What job do you want to try?' }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sending = useRef(false); // Enter and the button can both fire before a re-render
  const text = value.trim();

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
      <form className="ws-composer" data-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); send(); }}>
        <span className="ws-composer-caret" aria-hidden="true">&gt;</span>
        <Textarea
          className="ws-composer-input"
          aria-label="Job to try"
          placeholder={placeholder}
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
        <Button className="ws-send" type="button" aria-label="Start shift" disabled={!text} onClick={send} pendingAnnouncement="Starting your shift">
          <svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true" shapeRendering="crispEdges">
            <path fill="currentColor" d="M4 1h2v1h1v1h1v1h1v2H8v1H7v1H6v1H4V7h1V6H1V4h4V3H4z" />
          </svg>
        </Button>
      </form>
      {error && <p className="ws-composer-error" role="alert">{error}</p>}
    </div>
  );
}
