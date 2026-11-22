// The shift builder's pixel face in the chat: a little hard hat.
const PIXELS = [
  '....aaaa....', '..aaaaaaaa..', '.aaawaaaaaa.', '.aaaaaaaaaa.', 'kkkkkkkkkkkk',
  '..cccccccc..', '..ckccccck..', '..cccccccc..', '..ccckkccc..', '...cccccc...',
];
const COLORS = { a: '#f2b233', w: '#fff3c4', k: '#2a1f18', c: '#f5e6c8' };

export default function Avatar() {
  return (
    <svg className="ws-avatar" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
      {PIXELS.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y + 1} width="1" height="1" fill={COLORS[ch]} />)))}
    </svg>
  );
}
