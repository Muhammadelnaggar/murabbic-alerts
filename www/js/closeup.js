import { onCloseupSave, onCloseupPrefill } from '/js/track-closeup.js';
let eventDate=u.eventDate||localStorage.getItem('eventDate')||localStorage.getItem('lastEventDate')||''; if(!eventDate){ eventDate=new Date().toISOString().slice(0,10); }
persist({animalId,eventDate}); return {animalId,eventDate}; }


function prefill(ctx){ const a=Q('#animalId')||Q('[name="animalId"]'); if(a&&!a.value) a.value=ctx.animalId;
const d=Q('#eventDate')||Q('[name="eventDate"]')||Q('#closeupDate')||Q('[name="closeupDate"]'); if(d&&!d.value) d.value=ctx.eventDate;
onCloseupPrefill({ animalId: ctx.animalId, date: ctx.eventDate, source: location.pathname.slice(1) }); }


function payload(ctx){ const eventDate = val(['eventDate','closeupDate']);
const details = {
expectedCalvingDate: val(['expectedCalvingDate']),
diet: val(['diet','dietChange','ration']),
notes: val(['notes','remarks']) || undefined,
};
return {
type:'تحضير للولادة', eventType:'تحضير للولادة',
userId: localStorage.getItem('userId'),
tenantId: localStorage.getItem('tenantId') || 'default',
animalId: val(['animalId']) || ctx.animalId,
animalNumber: val(['animalNumber','number']) || ctx.animalId,
eventDate: eventDate || ctx.eventDate,
details,
source: location.pathname.slice(1),
};
}


async function post(payload){
const API_BASE=(localStorage.getItem('API_BASE')||'').replace(/\/$/,'');
const url=(API_BASE?API_BASE:'')+'/api/events';
const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
if(!r.ok) throw new Error('API failed: '+r.status);
return r.json().catch(()=>({}));
}


async function fb(payload){
const cfg=await import('/js/firebase-config.js');
const firebaseConfig=cfg.default||cfg.firebaseConfig||cfg.config;
const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js');
const { getFirestore, collection, addDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js');
const app=initializeApp(firebaseConfig); const db=getFirestore(app);
await addDoc(collection(db,'events'),{...payload,createdAt:serverTimestamp()});
}


function saved(detail){ document.dispatchEvent(new CustomEvent('event:saved',{detail})); }
function redirect(){ const to=(Q('form[data-redirect]')?.dataset?.redirect)||'/dashboard.html'; setTimeout(()=>location.href=to,1200); }


async function onSubmit(e){ e?.preventDefault?.(); const ctx=derive(); const p=payload(ctx); let mode='api';
try{ await post(p); }catch(err){ console.warn('API error; fallback to Firestore',err); await fb(p); mode='firestore'; }
try{ onCloseupSave({ animalId: p.animalId, date: p.eventDate, mode, source: p.source }); }catch(e){}
saved({ok:true,mode,p}); redirect(); }


(function init(){ const ctx=derive(); prefill(ctx); const form=Q('form[data-event="closeup"]')||Q('#closeupForm')||Q('form');
if(form) form.addEventListener('submit', onSubmit);
const btn=Q('#saveEvent')||Q('[data-action="save-event"]'); if(btn&&form) btn.addEventListener('click', (e)=>{ e.preventDefault(); form.requestSubmit(); }); })();
