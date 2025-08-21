// تتبّع مستقل لصفحة التغذية
function todayLocal(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
function getCtx(){
  const p = new URLSearchParams(location.search);
  const pick = (...k)=>{ for(const x of k){ const v=p.get(x); if(v) return v; } return ''; };
  const animalId = pick('animalId','number','animalNumber','id') || localStorage.getItem('currentAnimalId') || localStorage.getItem('lastAnimalId') || '';
  const eventDate = pick('eventDate','date','dt','Date') || localStorage.getItem('eventDate') || localStorage.getItem('lastEventDate') || todayLocal();
  try{
    if (animalId) { localStorage.setItem('currentAnimalId', animalId); localStorage.setItem('lastAnimalId', animalId); }
    if (eventDate){ localStorage.setItem('eventDate', eventDate); localStorage.setItem('lastEventDate', eventDate); }
  }catch{}
  return { animalId, eventDate };
}

const once = new Set();
function onceKey(k){ if(once.has(k)) return false; once.add(k); setTimeout(()=>once.delete(k), 3000); return true; }

export function onNutritionSave(meta = {}) {
  try { t.event('nutrition_save', meta); } catch(e){}
}

function firePrefill(){
  const { animalId, eventDate } = getCtx();
  const key = `nutrition_prefill|${animalId}|${eventDate}|${location.pathname}`;
  if (!onceKey(key)) return;
  try { t.event('nutrition_prefill', { animalId, date: eventDate, source: location.pathname.slice(1) }); } catch(e){}
}

document.addEventListener('DOMContentLoaded', firePrefill);
