// /js/track-nutrition.js
import { track } from '/js/track-core.js';

export function onNutritionPrefill(meta = {}) {
  track('nutrition_prefill', meta);
}
export function onNutritionSave(meta = {}) {
  track('nutrition_save', meta);
}
