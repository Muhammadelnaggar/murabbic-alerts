// /js/smart-tracker.js
import { Store, saveTask, getLastEventByType } from './store.js';

function addDays(ymd, days){
  const [y,m,d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  dt.setUTCDate(dt.getUTCDate()+days);
  const p=n=>String(n).padStart(2,'0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth()+1)}-${p(dt.getUTCDate())}`;
}

async function onEventSaved(e){
  const ev = e.detail; // { id,userId,animalNumber,eventDate,type,meta,... }
  try {
    switch (ev.type) {
      case 'insemination':
        await Store.saveTask({ animalNumber: ev.animalNumber, dueDate: addDays(ev.eventDate,30), title:'سونار حمل (بعد التلقيح)', originEventId: ev.id });
        await Store.saveTask({ animalNumber: ev.animalNumber, dueDate: addDays(ev.eventDate,45), title:'تأكيد الحمل', originEventId: ev.id });
        break;

      case 'pregnancy_diagnosis': {
        const positive = ev.meta?.result === 'positive' || ev.meta?.result === true;
        if (positive) {
          const lastAI = await Store.getLastEventByType(ev.animalNumber, 'insemination');
          if (lastAI) {
            const gest = Number(ev.meta?.gestationDays) || 280;
            const edd = addDays(lastAI.eventDate, gest);
            const dryOff = addDays(edd, -60);
            await Store.saveTask({ animalNumber: ev.animalNumber, dueDate: dryOff, title:'تجفيف قبل الولادة (Dry-off)', originEventId: ev.id });
          }
        }
        break;
      }

      case 'calving':
        await Store.saveTask({ animalNumber: ev.animalNumber, dueDate: addDays(ev.eventDate,45), title:'جاهزية للتلقيح بعد الولادة', originEventId: ev.id });
        await Store.saveTask({ animalNumber: ev.animalNumber, dueDate: addDays(ev.eventDate,60), title:'تقليم حوافر بعد الولادة', originEventId: ev.id });
        break;

      case 'vaccination': {
        const booster = Number(ev.meta?.boosterDays);
        if (Number.isFinite(booster) && booster>0) {
          await Store.saveTask({ animalNumber: ev.animalNumber, dueDate: addDays(ev.eventDate, booster), title:`جرعة معزِّزة (${ev.meta?.vaccine || 'لقاح'})`, originEventId: ev.id });
        }
        break;
      }

      case 'hoof_trim':
        await Store.saveTask({ animalNumber: ev.animalNumber, dueDate: addDays(ev.eventDate,180), title:'تقليم حوافر دوري', originEventId: ev.id });
        break;
    }
    window.showInlineMessage?.('تم ضبط مهام المتابعة تلقائيًا ✅');
  } catch (err) {
    console.error('SmartTracker:', err);
    window.showInlineMessage?.('اتسجّل الحدث، لكن في مشكلة بإنشاء المتابعة.');
  }
}

window.addEventListener('event:saved', onEventSaved);
