export function onNutritionSave(meta = {}) {
try { t.event('nutrition_save', meta); } catch (e) {}
}
export function onNutritionPrefill(meta = {}) {
try { t.event('nutrition_prefill', meta); } catch (e) {}
}
