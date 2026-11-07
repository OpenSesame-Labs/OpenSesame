/**
 * Curated duress presets — catalog labels only.
 * Security decisions come from CONTRACT compileDuressPolicy; presets do not
 * re-implement compiler rules.
 */

export { buildPresetPolicy } from "./preset-build.js";
export {
  PRESET_CATALOG,
  PRESET_IDS,
  type PresetId,
  type PresetMeta,
  type PresetScope,
  getPresetMeta,
  isPresetId,
} from "./preset-catalog.js";
