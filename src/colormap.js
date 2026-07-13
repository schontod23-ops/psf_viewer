// colormap.js — the single source of truth for PSF colour ramps (roadmap R3).
// Shared by the 2-D contour renderer (psfplot.js) and the 3-D mesh colouring of
// a loaded STL model (geometry3d.js), so a map and the model painted from it
// always agree.

import {
  interpolateTurbo,
  interpolateViridis,
  interpolateMagma,
  interpolateInferno,
  interpolateCividis,
  interpolateGreys,
} from "d3-scale-chromatic";

// Keyed by the value used in the UI/state.
const COLORMAPS = {
  turbo: interpolateTurbo,
  viridis: interpolateViridis,
  magma: interpolateMagma,
  inferno: interpolateInferno,
  cividis: interpolateCividis,
  greys: interpolateGreys,
};

/** The d3 interpolator for a colormap name (`t` ∈ [0,1] → CSS colour string). */
export function interpFor(name) {
  return COLORMAPS[name] || interpolateTurbo;
}

/**
 * Map a level in dB (≤ 0, peak-referenced) to a normalised ramp position in
 * [0,1], where 0 is the bottom of the dynamic range and 1 is the 0 dB peak.
 */
export function dbToUnit(db, dynamicDb) {
  const t = (db + dynamicDb) / dynamicDb;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * A 256-entry RGB lookup table for a colormap, as floats in [0,1] — the form
 * three.js vertex colours want. Built by sampling the d3 interpolator and
 * parsing its `rgb(r, g, b)` output once.
 */
export function rgbLut(name, size = 256) {
  const interp = interpFor(name);
  const lut = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = parseRgb(interp(i / (size - 1)));
    lut[i * 3] = r / 255;
    lut[i * 3 + 1] = g / 255;
    lut[i * 3 + 2] = b / 255;
  }
  return lut;
}

/** Look up the [r,g,b] (0..1) for a dB level against a LUT from `rgbLut`. */
export function lutColor(lut, db, dynamicDb) {
  const size = lut.length / 3;
  const i = Math.min(size - 1, Math.max(0, Math.round(dbToUnit(db, dynamicDb) * (size - 1))));
  return [lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]];
}

// d3-scale-chromatic returns "rgb(r, g, b)" for these ramps.
function parseRgb(css) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
