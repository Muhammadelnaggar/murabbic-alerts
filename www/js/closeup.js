// /js/closeup.js
import { initEventPage, Q } from '/js/events-core.js';
import { onCloseupPrefill, onCloseupSave } from '/js/track-closeup.js';

function ensureAnimalOrRedirect(ctx){
  const a = Q('#animalId')?.value?.trim() || ctx.animalId;
  if (!a){ alert('❗ رقم الحيوان مفقود'); location.href = 'add-event.html'; return false; }
  return true;
}

initEventPage({
  eventType: 'تحضير للولادة',
  formSelector: '#closeupForm, form[data-event="closeup"], form',
  animalSel: ['#animalId','[name="animalId"]', '#animal-id'],
  dateSel: ['#closeupDate','[name="closeupDate"]', '#eventDate','[name="eventDate"]', '#date'],
  onPrefill: (ctx) => {
    if (!ensureAnimalOrRedirect(ctx)) return;
    onCloseupPrefill({ animalId: ctx.animalId, date: ctx.eventDate, source: location.pathname.slice(1) });
  },
  buildDetails: () => ({
    closeupDate: (Q('#closeupDate')?.value || Q('[name="closeupDate"]')?.value || Q('#date')?.value || '').trim(),
    ration: (document.querySelector('input[name="ration"]:checked')||{}).value,
    anionicSalts: (document.querySelector('input[name="anionicSalts"]:checked')||{}).value,
    isSmartAlert: true,
    alertRule: 'close-up-preparation',
  }),
  onSaved: ({ payload, mode }) => onCloseupSave({ animalId: payload.animalId, date: payload.eventDate, mode, source: payload.source })
});
