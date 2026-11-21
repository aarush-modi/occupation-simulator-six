'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const configuredBackend = process.env.NEXT_PUBLIC_BACKEND_URL;

function backend() {
  if (configuredBackend) return new URL(configuredBackend);
  const url = new URL(window.location.origin);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') url.port = '3001';
  return url;
}

export async function roomRequest(path, input) {
  let response;
  try {
    response = await fetch(new URL(path, backend()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error('Could not reach the room server. Check its URL and whether it is running.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The room server did not accept the request.');
  return body;
}

export function useRoom(roomId) {
  const socket = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [lobby, setLobby] = useState(null);
  const [world, setWorld] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [playerId, setPlayerId] = useState(null);
  const current = useRef({});

  useEffect(() => {
    let closed = false;
    let retry;
    let failures = 0;
    const key = `workshift-session-${roomId}`;
    function connect() {
      const url = new URL(`/room/${encodeURIComponent(roomId)}`, backend());
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = sessionStorage.getItem(key);
      if (token) url.searchParams.set('session', token);
      const client = new WebSocket(url);
      socket.current = client;
      client.onopen = () => { if (!closed) { setStatus('connected'); failures = 0; } };
      client.onmessage = event => {
        if (closed) return;
        const message = JSON.parse(event.data);
        if (message.type === 'welcome') {
          current.current.playerId = message.playerId;
          setPlayerId(message.playerId);
          sessionStorage.setItem(key, message.token);
        }
        if (message.type === 'lobby') setLobby(message);
        if (message.type === 'world') {
          current.current.blueprint = message.blueprint;
          setWorld(message);
        }
        if (message.type === 'snapshot') {
          current.current.snapshot = message;
          current.current.player = message.players.find(item => item.id === current.current.playerId);
          setSnapshot(message);
        }
      };
      client.onclose = event => {
        if (closed) return;
        current.current.player = null;
        if ([4002, 4003, 4004].includes(event.code)) {
          setStatus(event.reason || 'This room is unavailable.');
          return;
        }
        setStatus('reconnecting');
        retry = setTimeout(connect, Math.min(6000, 650 * 2 ** failures++));
      };
    }
    connect();
    return () => { closed = true; clearTimeout(retry); socket.current?.close(); socket.current = null; };
  }, [roomId]);

  const send = useCallback(message => {
    const client = socket.current;
    if (client?.readyState === WebSocket.OPEN && client.bufferedAmount < 24_000) client.send(JSON.stringify(message));
  }, []);

  return { status, lobby, world, snapshot, playerId, current, send };
}
