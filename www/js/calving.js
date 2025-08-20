// ترحيل calving إلى /api/events مع حفظ سياق animalId/date وFallback تلقائي إلى Firestore عند الحاجة
import { onCalvingSave, onCalvingPrefill } from '/js/track-calving.js';


const Q = (sel) => document.querySelector(sel);
const val = (ids = []) => {
for (const id of ids) {
const el = document.getElementById(id) || document.querySelector(`[name="${id}"]`);
if (el && (el.value ?? '').toString().trim() !== '') return el.value.trim();
}
return '';
};


function readCtxFromURL() {
const p = new URLSearchParams(location.search);
const pick = (...keys) => {
for (const k of keys) { const v = p.get(k); if (v) return v; }
return '';
};
const animalId = pick('animalId','number','animalNumber','id');
const eventDate = pick('eventDate','date','dt','Date');
return { animalId, eventDate };
}


function persistCtx({ animalId, eventDate }) {
if (animalId) {
localStorage.setItem('lastAnimalId', animalId);
localStorage.setItem('currentAnimalId', animalId);
localStorage.setItem('ctxAnimalId', animalId);
}
if (eventDate) {
localStorage.setItem('lastEventDate', eventDate);
localStorage.setItem('eventDate', eventDate);
localStorage.setItem('Date', eventDate);
localStorage.setItem('dt', eventDate);
}
}


function deriveCtx() {
const urlCtx = readCtxFromURL();
const animalId = urlCtx.animalId || localStorage.getItem('currentAnimalId') || localStorage.getItem('lastAnimalId') || '';
let eventDate = urlCtx.eventDate || localStorage.getItem('eventDate') || localStorage.getItem('lastEventDate') || '';
if (!eventDate) {
const d = new Date();
eventDate = d.toISOString().slice(0,10);
}
persistCtx({ animalId, eventDate });
return { animalId, eventDate };
}


function prefillForm(ctx) {
const a = Q('#animalId') || Q('[name="animalId"]');
if (a && !a.value) a.value = ctx.animalId || '';
const d = Q('#eventDate') || Q('[name="eventDate"]') || Q('#calvingDate') || Q('[name="calvingDate"]');
if (d && !d.value) d.value = ctx.eventDate || '';
onCalvingPrefill({ animalId: ctx.animalId, date: ctx.eventDate, source: location.pathname.slice(1) });
}


function buildPayload(ctx) {
const eventDate = val(['eventDate','calvingDate']);
bind();
