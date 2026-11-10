/**
 * The page is drawn sideways and turned a quarter clockwise whenever the screen
 * is upright — a phone with rotation lock on, or one not turned yet. iOS gives
 * a web page no way to lock orientation, so this is the only way to get a
 * sideways table there. The turn itself is all CSS (`main` in styles.css);
 * this file is for the one thing script has to correct for.
 *
 * Must stay the same as the `@media` query in styles.css that turns `main`.
 */
export const ROTATED_QUERY = '(orientation: portrait)';

function rotated(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(ROTATED_QUERY).matches;
}

/**
 * Where to put a `position: fixed` element so it appears under a pointer.
 *
 * Pointer events report screen coordinates, and normally a fixed element is
 * placed in that same frame. When the page is turned, though, the turned `main`
 * becomes the containing block for fixed elements inside it, and its axes are
 * the screen's turned with it: its left edge runs down the screen's top, and
 * its top edge runs down the screen's right. So the point is mapped back into
 * that frame.
 *
 * Hit testing needs none of this — `elementFromPoint` works on what is drawn,
 * which is already turned.
 */
export function toPageFrame(
  inside: Element | null,
  x: number,
  y: number,
): { left: number; top: number } {
  if (!rotated()) return { left: x, top: y };
  const frame = inside?.closest('main')?.getBoundingClientRect();
  if (!frame) return { left: x, top: y };
  return { left: y - frame.top, top: frame.right - x };
}
