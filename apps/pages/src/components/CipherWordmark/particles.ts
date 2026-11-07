/** Particle-plate wordmark: model, layout, and draw surface. */

export { type DrawWordmarkOpts, drawWordmark } from "./particles-draw.js";
export { layoutWordmark } from "./particles-layout.js";
export {
  ALPHA_LEVELS,
  DRAW_CALIBRATION,
  type DrawCalibration,
  FIELD_MIN_EM,
  FONT_FAMILY,
  type Layout,
  PARTICLE_SEED,
  type Particle,
  TAU,
  WORDMARK_WIDTH_EM,
  type WordSlot,
  cursorBoostFor,
  inkAlpha,
  isDarkInk,
  lcg,
  particleField,
  readInkRgb,
  readSlit,
} from "./particles-model.js";
