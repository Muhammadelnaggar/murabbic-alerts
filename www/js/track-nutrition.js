// /js/track-nutrition.js
import { track } from '/js/track-core.js';
export const onNutritionPrefill = (m = {}) => track('nutrition_prefill', m);
export const onNutritionSave    = (m = {}) => track('nutrition_save', m);
