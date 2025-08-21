// تتبّع التغذية — بسيط ومباشر
export function track(name, meta = {}) {
  try { t.event(name, meta); } catch(e){}
}

export const onNutritionPrefill = (m={}) => track('nutrition_prefill', m);
export const onNutritionSave    = (m={}) => track('nutrition_save',   m);
