// Handwheel control from the webcam dial (cam.dial). The tilt held relative to the first tilt seen sets how hard the
// wheel turns, so holding a tilt keeps pushing. Clockwise as the player sees it raises the value.
export const DIAL = { dead: 0.06, full: 0.6, gain: 1.6, forgetMs: 600 };

export function dialInput(state, dial, now) {
  if (!dial) {
    if (now - state.seen > DIAL.forgetMs) state.neutral = null;
    return 0;
  }
  state.seen = now;
  if (state.neutral == null || state.side !== dial.side) { state.neutral = dial.roll; state.side = dial.side; }
  let d = dial.roll - state.neutral;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  // The image is unmirrored, so a clockwise turn in the mirrored preview lowers the image angle.
  const cw = -d;
  const mag = Math.max(0, Math.abs(cw) - DIAL.dead) / (DIAL.full - DIAL.dead);
  return mag > 0 ? Math.sign(cw) * Math.min(1, mag) : 0;
}
