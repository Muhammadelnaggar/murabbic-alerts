// /js/calving.js
import { initEventPage, Q } from '/js/events-core.js';
import { onCalvingPrefill, onCalvingSave } from '/js/track-calving.js';

function ensureAnimalOrRedirect(ctx){
  const a = Q('#animalId')?.value?.trim() || ctx.animalId;
  if (!a){ alert('❗ رقم الحيوان مفقود'); location.href = 'add-event.html'; return false; }
  return true;
}

initEventPage({
  eventType: 'ولادة',
  formSelector: '#calvingForm, form[data-event="calving"], form',
  animalSel: ['#animalId','[name="animalId"]'],
  dateSel: ['#calvingDate','[name="calvingDate"]','#eventDate','[name="eventDate"]'],
  onPrefill: (ctx) => {
    if (!ensureAnimalOrRedirect(ctx)) return;
    onCalvingPrefill({ animalId: ctx.animalId, date: ctx.eventDate, source: location.pathname.slice(1) });
  },
  buildDetails: () => ({
    calvingDate: (Q('#calvingDate')?.value || Q('[name="calvingDate"]')?.value || Q('#eventDate')?.value || '').trim(),
    birthEase: (document.querySelector('input[name="birthEase"]:checked')||{}).value,
    calfGender: (document.querySelector('input[name="calfGender"]:checked')||{}).value,
    calfId: (Q('#calfId')?.value || Q('[name="calfId"]')?.value || '').trim(),
    calfFate: (document.querySelector('input[name="calfFate"]:checked')||{}).value,
  }),
  onSaved: ({ payload, mode }) =>
    onCalvingSave({ animalId: payload.animalId, date: payload.eventDate, mode, source: payload.source })
});
