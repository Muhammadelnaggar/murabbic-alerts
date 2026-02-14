// /js/alerts-ui.js — Murabbik Alerts UI (v1)
// UI فقط: كروت تنبيه + زر "حسنًا" + تجميع تنبيهات البروتوكول.
// لا يعتمد على أي تعديل في التصميم العام، ويحقن CSS خفيف مرة واحدة.

(function(){
  'use strict';
  if (!window.mbk) window.mbk = {};
  if (window.mbk.alertsUI) return; //منع تحميل مزدوج

  const LS_SEEN_PREFIX = 'mbk_alert_seen__';
  const LS_SNOOZE_PREFIX = 'mbk_alert_snooze__';

  function esc(s){
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function nowTs(){ return Date.now(); }

  function injectStyleOnce(){
    if (document.getElementById('mbk-alerts-ui-style')) return;
    const st = document.createElement('style');
    st.id = 'mbk-alerts-ui-style';
    st.textContent = `
/* ===== Murabbik Alerts UI ===== */
.mbk-alerts-stack{
  position:fixed;
  top:86px;
  right:12px;
  width:340px;
  max-width: calc(100vw - 24px);
  display:flex;
  flex-direction:column;
  gap:10px;
  z-index:999999;
}
@media(max-width:420px){
  .mbk-alerts-stack{ right:10px; top:78px; width: calc(100vw - 20px); }
}
.mbk-alert{
  background:#fff;
  border:1px solid var(--border, #e2e8f0);
  border-radius:16px;
  box-shadow:0 10px 26px rgba(0,0,0,.14);
  overflow:hidden;
  transform: translateX(360px);
  opacity:0;
  transition: transform .28s ease, opacity .28s ease;
  font-family:'Cairo',Tahoma,Arial,sans-serif;
}
.mbk-alert.show{ transform: translateX(0); opacity:1; }

.mbk-alert__top{
  display:flex;
  gap:10px;
  align-items:flex-start;
  padding:12px 12px 10px;
}
.mbk-alert__icon{
  width:38px; height:38px;
  border-radius:12px;
  display:flex;
  align-items:center;
  justify-content:center;
  font-weight:900;
  flex-shrink:0;
  border:1px solid var(--border, #e2e8f0);
  background:#f7faf7;
}
.mbk-alert__body{ flex:1; min-width:0; }
.mbk-alert__title{
  font-size:13px;
  font-weight:900;
  color: var(--text, #0f172a);
  line-height:1.3;
  margin:0 0 4px;
}
.mbk-alert__msg{
  font-size:12px;
  color:#334155;
  line-height:1.55;
  margin:0;
  word-break:break-word;
}
.mbk-alert__meta{
  margin-top:6px;
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  align-items:center;
}
.mbk-chip{
  font-size:11px;
  padding:2px 8px;
  border-radius:999px;
  border:1px solid var(--border, #e2e8f0);
  background:#f8fafc;
  color:#0f172a;
  white-space:nowrap;
}
.mbk-chip.ok{ background:#ecfdf5; border-color:#bbf7d0; color:#065f46; }
.mbk-chip.warn{ background:#fff7ed; border-color:#fed7aa; color:#9a3412; }
.mbk-chip.info{ background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
.mbk-chip.danger{ background:#fef2f2; border-color:#fecaca; color:#991b1b; }

.mbk-alert__actions{
  display:flex;
  gap:10px;
  padding:10px 12px 12px;
  border-top:1px solid var(--border, #e2e8f0);
  background:#fff;
}
.mbk-btn{
  appearance:none;
  border:0;
  border-radius:12px;
  padding:10px 12px;
  cursor:pointer;
  font-weight:900;
  font-size:13px;
  flex:1;
}
.mbk-btn.primary{
  background: var(--brand, #0ea05a);
  color:#fff;
}
.mbk-btn.ghost{
  background:#fff;
  color: var(--brand-600, #0b7f47);
  border:2px solid var(--brand-600, #0b7f47);
}
.mbk-btn:active{ transform: scale(.99); }

.mbk-alert__close{
  width:32px;height:32px;
  border-radius:10px;
  border:1px solid var(--border, #e2e8f0);
  background:#fff;
  color:#0f172a;
  display:flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  flex-shrink:0;
  margin-right:2px;
}

    `;
    document.head.appendChild(st);
  }

  function ensureStack(){
    injectStyleOnce();
    let stack = document.getElementById('mbkAlertsStack');
    if (!stack){
      stack = document.createElement('div');
      stack.id = 'mbkAlertsStack';
      stack.className = 'mbk-alerts-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function severityInfo(sev){
    const s = String(sev||'info').toLowerCase();
    if (s.includes('warn'))  return { cls:'warn',  icon:'⚠️', title:'تنبيه' };
    if (s.includes('tip'))   return { cls:'ok',    icon:'✅', title:'إرشاد' };
    if (s.includes('alert')) return { cls:'danger',icon:'⛔', title:'تنبيه هام' };
    return { cls:'info', icon:'ℹ️', title:'معلومة' };
  }

  function makeKey(p){
    // مفتاح يمنع التكرار على مستوى التنبيه
    // الأفضل: taskId لو موجود - وإلا ruleId + animalId + plannedDate + plannedTime
    const rule = p?.ruleId || 'rule';
    const tid  = p?.taskId || '';
    const an   = p?.animalId || p?.animalNumber || '';
    const dt   = p?.plannedDate || p?.date || '';
    const tm   = p?.plannedTime || '';
    const g    = p?.groupId || p?.groupName || '';
    return [rule, tid, g, an, dt, tm].filter(Boolean).join('||');
  }

  function isSeen(key){
    try{ return !!localStorage.getItem(LS_SEEN_PREFIX + key); }catch{ return false; }
  }
  function markSeen(key){
    try{ localStorage.setItem(LS_SEEN_PREFIX + key, String(nowTs())); }catch{}
  }


  function snoozeUntil(key){
    try{ return Number(localStorage.getItem(LS_SNOOZE_PREFIX + key) || 0) || 0; }catch{ return 0; }
  }
  function setSnooze(key, minutes){
    try{
      const until = Date.now() + (Number(minutes||30) * 60 * 1000);
      localStorage.setItem(LS_SNOOZE_PREFIX + key, String(until));
    }catch{}
  }
  function clearSnooze(key){
    try{ localStorage.removeItem(LS_SNOOZE_PREFIX + key); }catch{}
  }


  // ===== تجميع (Aggregation) للبروتوكول =====
  // لو وصلنا payload فيه: ruleId protocol_step_due / protocol_step_tomorrow
  // وبدون groupId… هنجمّع تلقائيًا حسب: (ruleId + plannedDate + plannedTime + stepName)
  const agg = new Map(); // aggKey -> { payload0, animals:Set, timer }
  function aggKey(p){
    const rid = p?.ruleId || '';
    const dt  = p?.plannedDate || '';
    const tm  = p?.plannedTime || '';
    const step= p?.stepName || '';
    return [rid, dt, tm, step].join('__');
  }
  function shouldAggregate(p){
    const rid = String(p?.ruleId||'');
    return (rid === 'protocol_step_due' || rid === 'protocol_step_tomorrow');
  }

  function showCard(payload){
    const stack = ensureStack();

    const sev = severityInfo(payload?.severity);
    const key = makeKey(payload);

    if (isSeen(key)) return; // منع التكرار بعد "حسنًا"
    const su = snoozeUntil(key);
    if (su && Date.now() < su) return; // مؤجّل

    const title = payload?.title || sev.title;
    const msg   = payload?.message || 'تنبيه جديد';
    const planned = payload?.plannedDate || '';
    const time    = payload?.plannedTime || '';
    const step    = payload?.stepName || '';
    const animal  = payload?.animalId || payload?.animalNumber || '';
    const groupName = payload?.groupName || payload?.groupId || '';

    const metaChips = [];
    if (groupName) metaChips.push(`<span class="mbk-chip ${sev.cls}">المجموعة: ${esc(groupName)}</span>`);
    if (animal && !groupName) metaChips.push(`<span class="mbk-chip ${sev.cls}">الحيوان: ${esc(animal)}</span>`);
    if (step) metaChips.push(`<span class="mbk-chip">${esc(step)}</span>`);
    if (planned) metaChips.push(`<span class="mbk-chip">${esc(planned)}${time?(' • '+esc(time)):""}</span>`);

    const el = document.createElement('div');
    el.className = 'mbk-alert';
    el.innerHTML = `
      <div class="mbk-alert__top">
        <div class="mbk-alert__icon">${sev.icon}</div>
        <div class="mbk-alert__body">
          <div class="mbk-alert__title">${esc(title)}</div>
          <p class="mbk-alert__msg">${esc(msg)}</p>
          <div class="mbk-alert__meta">${metaChips.join('')}</div>
        </div>
        <button class="mbk-alert__close" title="إغلاق">✕</button>
      </div>
      <div class="mbk-alert__actions">
        <button class="mbk-btn primary" data-act="ok">حسنًا</button>
        <button class="mbk-btn ghost" data-act="snooze">تأجيل 30د</button>
       ${(payload?.ruleId === 'protocol_step_due' && (payload?.actionUrl || payload?.stepIndex !== undefined))
  ? `<button class="mbk-btn ghost" data-act="open">تسجيل الخطوة الآن</button>`
  : ``}

      </div>
    `;

    const kill = (ack=true)=>{
      el.classList.remove('show');
      setTimeout(()=>{ try{ el.remove(); }catch{} }, 220);
      if (ack){
        markSeen(key);
        clearSnooze(key);
        try{
          if (window.t?.event) window.t.event('smart_alert_ack', { key, ruleId: payload?.ruleId, taskId: payload?.taskId, ts:Date.now() });
        }catch{}
      }
    };

    el.querySelector('.mbk-alert__close')?.addEventListener('click', ()=> kill(true));
    el.querySelector('[data-act="ok"]')?.addEventListener('click', ()=> kill(true));
    el.querySelector('[data-act="snooze"]')?.addEventListener('click', ()=>{ setSnooze(key, 30); kill(false); });

   el.querySelector('[data-act="open"]')?.addEventListener('click', ()=>{
  try{
    // ✅ فتح التسجيل فقط في "يوم الخطوة"
    if (payload?.ruleId !== 'protocol_step_due') { kill(true); return; }

    let url = payload.actionUrl;

    // ✅ لو مفيش actionUrl لكن فيه stepIndex ابنِ الرابط
    if (!url && payload.stepIndex !== undefined) {
      url = `ovsynch.html?step=${payload.stepIndex}`;
    }

    if (url) location.href = url;
  }catch{}
  kill(true);
});


    stack.prepend(el);
    setTimeout(()=> el.classList.add('show'), 20);

    try{
      if (window.t?.event) window.t.event('smart_alert_shown', { key, ruleId: payload?.ruleId, taskId: payload?.taskId, ts:Date.now() });
    }catch{}
  }

  function show(payload){
    // Aggregation للبروتوكول
    if (shouldAggregate(payload)){
      const k = aggKey(payload);
      const rec = agg.get(k) || { payload0: payload, animals: new Set(), timer:null };
      const an = (payload?.animalId || payload?.animalNumber || '').trim();
      if (an) rec.animals.add(an);

      // خزن آخر نسخة payload كـ base
      rec.payload0 = Object.assign({}, rec.payload0, payload);

      // جدولة عرض بعد 400ms لتجميع اللي جاي بسرعة
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = setTimeout(()=>{
        agg.delete(k);

        const p0 = rec.payload0 || payload;
        const arr = Array.from(rec.animals);
        const count = arr.length;

        // لو أكتر من 1 => اعرض كـ "كتلة"
        if (count >= 2){
          const brief = arr.slice(0,8).join('، ') + (count>8 ? ' ...' : '');
          const step  = p0.stepName ? ` — ${p0.stepName}` : '';
          const when  = `${p0.plannedDate||''}${p0.plannedTime?(' '+p0.plannedTime):''}`.trim();

          showCard(Object.assign({}, p0, {
            severity: p0.severity || 'warn',
           title:
  (p0.ruleId === 'protocol_step_tomorrow')
    ? `تنبيه بروتوكول غدًا: ${esc(p0.stepName||'')}`
    : `تنبيه بروتوكول اليوم: ${esc(p0.stepName||'')}`,

            groupName: `دفعة (${count} حيوان)`,
           message:
  `📅 ${esc(p0.plannedDate||'')} | ⏰ ${esc(p0.plannedTime||'')}\n` +
  `للـبقرة/الجاموسة: ${esc(brief.replace(/،/g,'–'))}`,

          }));
          return;
        }
        // لو واحد => اعرض عادي
        showCard(p0);
      }, 400);

      agg.set(k, rec);
      return;
    }

    showCard(payload);
  }

  window.mbk.alertsUI = { show };
})();

