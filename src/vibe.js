// vibe.js — the per-channel CRT/VHS look (L-V1).
//
// V1 is the NO-SHADER tier, and it ships everywhere today: 4:3 cropping,
// scanlines, vignette, grain and dead pixels are all overlay work, so the
// browser TV and the Pi get them with no change to the video pipeline. The
// shader tier (V2) needs a Metal rework on Apple and is parked in P5 — nothing
// here anticipates it beyond leaving the door open.
//
// ── the one structural decision ──────────────────────────────────────────────
// A vibe is stored as a SELF-CONTAINED JSON DOCUMENT, not as a spread of
// columns. That is deliberate: the open question is whether Vibe eventually
// supports PER-ITEM overrides (a tape in Track M carrying its own worn look),
// and the phase notes are explicit that retrofitting that later is much worse
// than allowing for it now.
//
// With a document, per-item support is "put the same shape somewhere else and
// add one step to resolve()" — a media column, or a field in a pack manifest.
// With columns it would be a schema redesign every time a new scope appears.
// So the MODEL is scope-agnostic from day one while the UI exposes only the
// global default and per-channel, which is all anyone has asked for.
//
// Resolution order (first non-null wins, field by field):
//     item (not yet exposed) → channel → global default → OFF

/** Every knob, with the value that means "do nothing". */
export const VIBE_OFF = {
  crop43: false,      // pillarbox to 4:3 — the biggest single "it looks right" win
  scanlines: 0,       // 0–1, opacity of the line pattern
  vignette: 0,        // 0–1, corner darkening
  grain: 0,           // 0–1, how MUCH static — density, not size
  grainSize: 1,       // 1–4, how COARSE that static is (1 = fine film grain, 4 = chunky VHS)
  deadPixels: 0,      // count of fixed stuck pixels, 0–12
  bleed: 0,           // 0–1, chroma bleed (saturation lift)
  bars: 0,            // 0–1, rolling hum bar — the band that drifts up a badly-earthed set
  chromaShift: 0,     // 0–1, colour fringing (RGB offset). NOT RENDERED ON APPLE — see below.
};

// ── knobs the platforms disagree about ──────────────────────────────────────
// Everything above is an overlay EXCEPT the two that need the decoded pixels:
// `bleed` and `chromaShift`. The browser can do both with CSS filters on the
// video element; Apple cannot, because VLCKit owns its output surface, and
// touching it is the V2/Metal tier (P5).
//
// This is exported rather than hardcoded in the UI so the control panel can say
// "not on Apple TV yet" next to the exact knobs that mean it, instead of
// offering a slider that silently does nothing on the device you are watching.
export const VIBE_PIXEL_KNOBS = ['bleed', 'chromaShift'];

/** Presets, so nobody has to dial six numbers to get somewhere good. */
export const VIBE_PRESETS = {
  off: { ...VIBE_OFF },
  // A tidy set in good condition — the look most people mean by "CRT".
  crt: { crop43: true, scanlines: 0.22, vignette: 0.35, grain: 0.05, grainSize: 1,
         deadPixels: 0, bleed: 0.15, bars: 0, chromaShift: 0.1 },
  // A tape that has been through the machine a few hundred times. Coarser grain
  // and a slow hum bar are most of what separates "tape" from "tube".
  vhs: { crop43: true, scanlines: 0.14, vignette: 0.3, grain: 0.16, grainSize: 2.5,
         deadPixels: 2, bleed: 0.35, bars: 0.25, chromaShift: 0.35 },
  // A set in the corner of a bar with a bent aerial.
  rough: { crop43: true, scanlines: 0.3, vignette: 0.5, grain: 0.3, grainSize: 3.5,
           deadPixels: 6, bleed: 0.45, bars: 0.5, chromaShift: 0.5 },
};

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** Coerce anything into a valid vibe, dropping unknown keys. */
export function normalizeVibe(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    crop43: !!input.crop43,
    scanlines: clamp01(input.scanlines),
    vignette: clamp01(input.vignette),
    grain: clamp01(input.grain),
    // Size is a MULTIPLIER, not a 0–1 intensity, so it gets its own clamp.
    // Defaults to 1 rather than 0: a grain size of zero is not a look, it is an
    // invisible bug, and an older document that predates this knob must come
    // back as fine grain rather than none.
    grainSize: Math.max(1, Math.min(4, Number(input.grainSize) || 1)),
    deadPixels: Math.max(0, Math.min(12, Math.round(Number(input.deadPixels) || 0))),
    bleed: clamp01(input.bleed),
    bars: clamp01(input.bars),
    chromaShift: clamp01(input.chromaShift),
  };
}

/**
 * Merge the scopes, most specific first. Each is a full document or null.
 * Kept as a plain reduce so adding an `item` scope later is one more argument.
 */
export function resolveVibe(...scopes) {
  const out = { ...VIBE_OFF };
  for (const s of scopes.filter(Boolean).reverse()) Object.assign(out, normalizeVibe(s));
  return out;
}

/** Is this vibe doing anything at all? Lets the player skip the whole layer. */
export const vibeIsActive = (v) =>
  !!v && (v.crop43 || v.scanlines > 0 || v.vignette > 0 || v.grain > 0
          || v.deadPixels > 0 || v.bleed > 0 || v.bars > 0 || v.chromaShift > 0);

export function parseVibe(json) {
  if (!json) return null;
  try { return normalizeVibe(typeof json === 'string' ? JSON.parse(json) : json); }
  catch { return null; }
}
