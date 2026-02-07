// smart-checks.js — Simple • Effective • Very Smart
// لا تغيّر أي تصميم. يعمل في الخلفية على القواعد الذكية فقط.
// يعتمد على window.dataLayer / t.event لو متاحة.

(function(){
  'use strict';
  if (!window.smart) window.smart = {};

  // إعدادات افتراضية (يمكن تعديلها قبل التحميل التالي)
  window.smart.cfg = Object.assign({
    vwpDays: 60,             // نافذة انتظار ما بعد الولادة (يوم)
    placentaCheckHours: 24,  // متابعة نزول المشيمة (ساعة)
    heatStartDays: 21,       // بدء متابعة الشبق بعد الولادة (يوم)
    pregCheckDays: 35,       // تشخيص الحمل بعد التلقيح (يوم)
    dryOffMaxMilk: 10        // حد الإنتاج اليومي عند طلب التجفيف (لتر)
  }, window.smart.cfg || {});

  // ======= Helpers =======
  const dlPush = (name, props) => {
    try {
      if (window.t && typeof window.t.event === 'function') {
        window.t.event(name, props);
      } else {
        (window.dataLayer = window.dataLayer || []).push({ event:name, ts:Date.now(), ...(props||{}) });
      }
    } catch {}
  };
  const QS = new URLSearchParams(location.search);
  const pick = (k, fb=null)=> QS.get(k) || localStorage.getItem(k) || sessionStorage.getItem(k) || fb;
  const isValidDate = (d)=> d instanceof Date && !isNaN(d);
  const parse = (s)=> { if(!s) return null; try{ const d=new Date(s); return isValidDate(d)?d:null; }catch{ return null; } };
  const daysBetween  = (a,b)=> { if(!a||!b) return NaN; const ms=+parse(b)-(+parse(a)); return Math.floor(ms/86400000); };
  const hoursBetween = (a,b)=> { if(!a||!b) return NaN; const ms=+parse(b)-(+parse(a)); return Math.floor(ms/3600000); };
  const todayISO = ()=> { const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); };

  function fire(onAlert, payload){
    dlPush('smart_alert_triggered', payload);
    try { if (typeof onAlert==='function') onAlert(payload); else alert('🔔 ' + payload.message); } catch {}
  }

  // ======= Stubs يمكن للتطبيق استدعاؤها لاحقًا =======
  window.smart.beforeInsemination      = window.smart.beforeInsemination      || (async ()=> true);
  window.smart.onCalvingRecorded       = window.smart.onCalvingRecorded       || (async ()=>{});
  window.smart.onInseminationRecorded  = window.smart.onInseminationRecorded  || (async ()=>{});

  // ======= المراقب العام للقواعد =======
  // ======= المراقب العام للقواعد =======
  window.smart.startAlertsWatcher = function ({ tenantId, userId, onAlert } = {}){

    function checkAll(){
      const cfg = window.smart.cfg || {};
      const page = (location.pathname.split('/').pop() || '').toLowerCase();

      // سياق موحّد
      const animalId  = pick('animalId') || pick('number') || pick('animalNumber') || pick('currentAnimalId') || pick('lastAnimalId') || '';
      const eventDate = pick('date') || pick('eventDate') || todayISO();
      const calv      = pick('calvingDate') || pick('calvDate') || pick('calving_dt');
      const lastInsem = pick('lastInseminationDate') || pick('inseminationDate') || pick('insemination_dt');

      // --- Rule 1: انتظار 60 يوم قبل التلقيح ---
      if (page.includes('insemination')){
        const d = daysBetween(calv, eventDate);
        if (Number.isFinite(d) && d < Number(cfg.vwpDays)){
          fire(onAlert, {
            ruleId:  'wait_60_post_calving',
            severity:'warn',
            animalId, days:d, vwp:Number(cfg.vwpDays),
            message: `الحيوان ${animalId}: مر ${d} يوم فقط من الولادة — نافذة انتظار التلقيح ${cfg.vwpDays} يوم.`
          });
        }
      }

      // --- Rule 2: بعد 24h من الولادة اسأل عن المشيمة ---
      if (page.includes('calving') || page.includes('dashboard') || page.includes('add-event')){
        const h = hoursBetween(calv, eventDate);
        const key = calv ? `seen_placenta_${calv}` : '';
        if (Number.isFinite(h) && h >= Number(cfg.placentaCheckHours) && key && !localStorage.getItem(key)){
          localStorage.setItem(key,'1'); // منع التكرار لكل ولادة
          fire(onAlert, {
            ruleId:'placenta_check_24h', severity:'info', animalId, hours:h,
            message:`مر ${h} ساعة منذ الولادة للحيوان ${animalId}. هل نزلت المشيمة؟`
          });
        }
      }

      // --- Rule 3: ابدأ متابعة الشبق بعد 21 يوم من الولادة ---
      if (page.includes('dashboard') || page.includes('add-event')){
        const d = daysBetween(calv, eventDate);
        const key = calv ? `seen_heatstart_${calv}` : '';
        if (Number.isFinite(d) && d >= Number(cfg.heatStartDays) && key && !localStorage.getItem(key)){
          localStorage.setItem(key,'1');
          fire(onAlert, {
            ruleId:'start_heat_monitoring', severity:'tip', animalId, days:d,
            message:`${d} يوم منذ الولادة — ابدأ متابعة الشبق.`
          });
        }
      }

      // --- Rule 4: تشخيص الحمل بعد 35 يوم من آخر تلقيح ---
      if (page.includes('pregnancy') || page.includes('dashboard') || page.includes('add-event')){
        const d = daysBetween(lastInsem, eventDate);
        if (Number.isFinite(d)){
          if (d >= Number(cfg.pregCheckDays)){
            fire(onAlert, {
              ruleId:'preg_diagnosis_due', severity:'info', animalId, days:d,
              message:`${d} يوم منذ آخر تلقيح — وقت مناسب لتشخيص الحمل.`
            });
          } else if (page.includes('pregnancy')){
            fire(onAlert, {
              ruleId:'preg_diagnosis_too_early', severity:'warn', animalId, days:d,
              message:`${d} يوم فقط منذ التلقيح — التشخيص مبكر. الموصى ${cfg.pregCheckDays} يوم.`
            });
          }
        }
      }

      // --- Rule 5: فحص طلب التجفيف مقابل إنتاج اللبن ---
      if (page.includes('dry-off')){
        const milk = Number(pick('dailyMilk') || pick('milk') || '');
        if (!Number.isNaN(milk) && milk > Number(cfg.dryOffMaxMilk)){
          fire(onAlert, {
            ruleId:'dryoff_high_milk', severity:'warn', animalId, milk, max:Number(cfg.dryOffMaxMilk),
            message:`إنتاج ${milk} لتر/يوم — أعلى من حد التجفيف المقترح (${cfg.dryOffMaxMilk} لتر).`
          });
        }
      }

    (async function(){
  try{
    const mod = await import('/js/firebase-config.js');
    const db = mod?.db;
    const auth = mod?.auth;
    if(!db) return;

    const uid = (userId || auth?.currentUser?.uid || localStorage.getItem('userId') || '').trim();
    if(!uid) return;

    const { collection, query, where, getDocs, limit } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

    const today = todayISO();

    // ✅ نجيب شوية Tasks pending وبنفلتر محليًا (بدون تعقيد query/Indexes)
    const q = query(
      collection(db, 'tasks'),
      where('userId','==', uid),
      where('type','==','protocol_step'),
      where('status','==','pending'),
      limit(30)
    );

    const snap = await getDocs(q);
    if(snap.empty) return;

    // ✅ نحول docs لبيانات + نفلتر على plannedDate النصي
    const items = snap.docs
      .map(d => (d.data() || {}))
      .filter(x => x.plannedDate && typeof x.plannedDate === 'string')
      .sort((a,b) => String(a.plannedDate).localeCompare(String(b.plannedDate)));

    // ✅ 1) اليوم (مستحق اليوم)
    const dueToday = items.find(x => x.plannedDate === today);

    // ✅ 2) بكرة (تنبيه قبل الموعد بيوم)
    const tomorrow = (function(){
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
      return d.toISOString().slice(0,10);
    })();
    const dueTomorrow = items.find(x => x.plannedDate === tomorrow);

    // ✅ لو مفيش لا اليوم ولا بكرة، مفيش تنبيه
    if (!dueToday && !dueTomorrow) return;

    // ✅ أولوية: اليوم أولاً
    const doc0 = dueToday || dueTomorrow;

    const an = doc0.animalNumber || '';
    const step = doc0.stepName || 'خطوة بروتوكول';

    if (dueToday){
      fire(onAlert, {
        ruleId:'protocol_step_due_today',
        severity:'info',
        animalId: an,
        message: `اليوم خطوة بروتوكول للحيوان ${an}: ${step}`
      });
    } else {
      fire(onAlert, {
        ruleId:'protocol_step_due_tomorrow',
        severity:'tip',
        animalId: an,
        message: `غدًا خطوة بروتوكول للحيوان ${an}: ${step}`
      });
    }

  }catch(e){
    // صامت
  }
})();
