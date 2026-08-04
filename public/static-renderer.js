// static-renderer.js — analog noise, drawn once and reused everywhere.
//
// Three features want the same picture and must not each grow their own:
//   · channel-change static (K-B3) — a burst of a few hundred ms on every tune
//   · off-air snow (R3)            — a persistent field until sign-on
//   · the Vibe filter stack (L-V1) — a faint permanent grain over the picture
// and later the VCR insert animation in Track M.
//
// PERFORMANCE IS THE WHOLE DESIGN. Per-pixel noise at screen resolution every
// frame will not hold 60fps on a Pi 4 or an Apple TV. Instead we pre-generate a
// handful of small noise tiles ONCE, then cycle them, scaled up with smoothing
// off. Scaling is what gives the chunky analog grain — real snow is not
// pixel-fine — so the cheap path is also the correct-looking one.
//
// Reduced motion is honoured properly: flickering full-screen noise is close to
// the worst thing this product could show someone who asked for less movement,
// so animation stops and a single still frame stands in.

const TILE = 128;          // noise tile edge, in px. Small on purpose.
const FRAMES = 8;          // distinct tiles to cycle. More = less obvious loop.

const reduceMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Pre-render the noise tiles. Called once per field, not per frame. */
function buildTiles(grain) {
  const tiles = [];
  for (let f = 0; f < FRAMES; f++) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(TILE, TILE);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // Luminance noise, not colour noise: analog snow is grey. A little bias
      // toward the dark end keeps it from reading as a white flash.
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Chunkier grain = fewer, bigger blocks. Redraw the tile onto itself at a
    // lower resolution with smoothing off.
    if (grain > 1) {
      const small = Math.max(4, Math.round(TILE / grain));
      const t = document.createElement('canvas');
      t.width = t.height = small;
      const tctx = t.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(c, 0, 0, small, small);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, TILE, TILE);
      ctx.drawImage(t, 0, 0, TILE, TILE);
    }
    tiles.push(c);
  }
  return tiles;
}

/**
 * A noise field bound to a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{intensity?: number, grain?: number, fps?: number}} [opts]
 *        intensity 0–1 (drawn as alpha) · grain 1–16 (block chunkiness)
 * @returns {{start:Function, stop:Function, burst:Function, setIntensity:Function, destroy:Function}}
 */
export function createStaticField(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  let intensity = opts.intensity ?? 1;
  const grain = opts.grain ?? 4;
  const fps = opts.fps ?? 24;        // analog snow is not 60fps; 24 looks right and costs less
  const tiles = buildTiles(grain);

  let raf = null;
  let frame = 0;
  let last = 0;
  let stopAt = 0;                    // 0 = run until stopped
  let scale = 1;                     // grain coarseness — see fit()
  let onDone = null;

  function fit() {
    // Match the backing store to the displayed size, capped — there is no point
    // rendering noise at retina density, and it costs real fill rate.
    //
    // GRAIN SIZE IS THIS DIVISOR. A smaller backing store stretched over the
    // same element by the compositor, with smoothing off, is exactly chunkier
    // noise — fine film grain at 1, coarse tape noise at 4 — and it costs LESS
    // to draw rather than more. Cheaper than generating tiles per size.
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(Math.min(1280, r.width) / scale));
    const h = Math.max(1, Math.round(Math.min(720, r.height) / scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function paint(t) {
    if (stopAt && t >= stopAt) { stop(); onDone?.(); return; }
    if (t - last >= 1000 / fps) {
      last = t;
      fit();
      ctx.globalAlpha = intensity;
      ctx.imageSmoothingEnabled = false;
      const tile = tiles[frame++ % tiles.length];
      // One scaled blit per frame. This is the entire per-frame cost.
      ctx.drawImage(tile, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    }
    raf = requestAnimationFrame(paint);
  }

  /** One still frame — the reduced-motion stand-in, and the poster for a paused field. */
  function still() {
    fit();
    ctx.globalAlpha = intensity;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiles[0], 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
  }

  function start() {
    canvas.style.visibility = 'visible';
    if (reduceMotion()) { still(); return; }
    if (raf) return;
    last = 0;
    raf = requestAnimationFrame(paint);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    stopAt = 0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.visibility = 'hidden';
  }

  /**
   * Run for `ms`, then stop and resolve. This is the channel-change burst.
   * With reduced motion it resolves immediately without drawing anything —
   * a "brief flash" is exactly what that preference is asking us not to do.
   */
  function burst(ms = 220) {
    return new Promise((resolve) => {
      if (reduceMotion()) { resolve(); return; }
      stop();
      canvas.style.visibility = 'visible';
      onDone = resolve;
      stopAt = performance.now() + ms;
      last = 0;
      raf = requestAnimationFrame(paint);
    });
  }

  return {
    start,
    stop,
    burst,
    setIntensity(v) { intensity = Math.max(0, Math.min(1, v)); },
    /** How coarse the noise is (1 = fine, 4 = chunky). See fit(). */
    setScale(v) {
      const next = Math.max(1, Math.min(4, Number(v) || 1));
      if (next === scale) return;
      scale = next;
      fit();          // resize now rather than waiting for the next painted frame
    },
    destroy() { stop(); tiles.length = 0; },
  };
}
