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
  const parse = (s)=> {
    if(!s) return null;
    try{ const d=new Date(s); return isValidDate(d)?d:null; }catch{ return null; }
  };

  const daysBetween  = (a,b)=> { if(!a||!b) return NaN; const ms=+parse(b)-(+parse(a)); return Math.floor(ms/86400000); };
  const hoursBetween = (a,b)=> { if(!a||!b) return NaN; const ms=+parse(b)-(+parse(a)); return Math.floor(ms/3600000); };

  const todayISO = ()=> {
    const d=new Date();
    d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
    return d.toISOString().slice(0,10);
  };

  const tomorrowISO = ()=> {
    const d=new Date();
    d.setDate(d.getDate()+1);
    d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
    return d.toISOString().slice(0,10);
  };

  function fire(onAlert, payload){
    dlPush('smart_alert_triggered', payload);
    try { if (typeof onAlert==='function') onAlert(payload); else alert('🔔 ' + payload.message); } catch {}
  }

  // ======= Stubs =======
  window.smart.beforeInsemination      = window.smart.beforeInsemination      || (async ()=> true);
  window.smart.onCalvingRecorded       = window.smart.onCalvingRecorded       || (async ()=>{});
  window.smart.onInseminationRecorded  = window.smart.onInseminationRecorded  || (async ()=>{});

  // ======= المراقب العام للقواعد =======
  window.smart.startAlertsWatcher = function ({ tenantId, userId, onAlert } = {}){
    function checkAll(){
      const cfg  = window.smart.cfg || {};
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
          localStorage.setItem(key,'1');
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

           // --- Rule 6: بروتوكول (قبل يوم: تنبيه واحد) + (يوم التنفيذ: قبلها بساعتين ثم كل 30 دقيقة حتى تتسجل) ---
      if (page.includes('dashboard') || page.includes('add-event')){

        // ✅ ابدأ مؤقّت واحد فقط لقاعدة البروتوكول (بدون تكرار)
        if (!window.smart._proto6) window.smart._proto6 = { started:false, lastRefresh:0, tasks:[], db:null, auth:null, uid:'' };
        const P = window.smart._proto6;

        const toLocalISO = (d)=>{
          const x = new Date(d);
          x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
          return x.toISOString().slice(0,10);
        };

        const buildTaskDateTime = (plannedDate, plannedTime)=>{
          const dt = new Date(plannedDate); // plannedDate = YYYY-MM-DD
          const [hh, mm] = String(plannedTime || '00:00').split(':').map(n=>Number(n));
          dt.setHours(Number.isFinite(hh)?hh:0, Number.isFinite(mm)?mm:0, 0, 0);
          return dt;
        };

        const shouldFireEvery30m = (key)=>{
          const last = Number(localStorage.getItem(key) || 0);
          const now  = Date.now();
          if (!last || (now - last) >= 30*60*1000){
            localStorage.setItem(key, String(now));
            return true;
          }
          return false;
        };

        const fireOnceKey = (key)=>{
          if (localStorage.getItem(key)) return false;
          localStorage.setItem(key,'1');
          return true;
        };

        async function refreshTasksIfNeeded(uid){
          const now = Date.now();
          if (P.tasks.length && (now - P.lastRefresh) < 10*60*1000) return; // كل 10 دقائق فقط
          P.lastRefresh = now;

          const { collection, query, where, getDocs, limit } =
            await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

         const q = query(
  collection(P.db, 'tasks'),
  where('userId','==', uid),
  where('type','==','protocol_step'),
  where('status','==','pending'),
  where('alertEnabled','==', true),   // ✅ لا تقرأ إلا تنبيهات المجموعة/الفردي فقط
  limit(80)
);


          const snap = await getDocs(q);
          const out = [];
          snap.forEach(ds => {
            const t0 = ds.data() || {};
            out.push({ id: ds.id, ...t0 });
          });
          P.tasks = out;
        }

        async function tickProtocol(){
          try{
            // ✅ جهّز Firebase مرة واحدة
            if (!P.db){
              const mod = await import('/js/firebase-config.js');
              P.db   = mod?.db;
              P.auth = mod?.auth;
              if (!P.db) return;
            }

            // ✅ uid
            const uid = (userId || P.auth?.currentUser?.uid || localStorage.getItem('userId') || '').trim();
            if (!uid) return;
            P.uid = uid;

            // ✅ جلب/تحديث التاسكات (كل 10 دقائق)
            await refreshTasksIfNeeded(uid);
            if (!Array.isArray(P.tasks) || !P.tasks.length) return;

            const now = new Date();
            const today = toLocalISO(now);

            for (const t0 of P.tasks){
              const taskId = t0.id;
              const plannedDate = t0.plannedDate;
              if (!plannedDate || typeof plannedDate !== 'string') continue;

             // ✅ plannedTime fallback: لو مش موجود، استخرجه من plannedDateTime
let plannedTime = (t0.plannedTime || '').trim();

if (!plannedTime && t0.plannedDateTime){
  try{
    const dtx = new Date(t0.plannedDateTime);
    if (!isNaN(dtx.getTime())){
      const hh = String(dtx.getHours()).padStart(2,'0');
      const mm = String(dtx.getMinutes()).padStart(2,'0');
      plannedTime = `${hh}:${mm}`;
    }
  }catch{}
}

if (!plannedTime) plannedTime = '00:00';

// ✅ لو plannedDateTime موجودة استخدمها مباشرة (أدق)
let taskDt;
if (t0.plannedDateTime){
  const dtx = new Date(t0.plannedDateTime);
  taskDt = isNaN(dtx.getTime()) ? buildTaskDateTime(plannedDate, plannedTime) : dtx;
} else {
  taskDt = buildTaskDateTime(plannedDate, plannedTime);
}


              const taskDay = toLocalISO(taskDt);

            const scope = String(t0.scope || '').toLowerCase();
const an =
  (scope === 'group')
    ? (t0.groupName || t0.groupId || 'مجموعة')
    : (t0.animalNumber || t0.number || '');
const nCount = Number(t0.animalsCount || t0.count || 0) || 0;


              const step = t0.stepName || t0.title || 'خطوة بروتوكول';

              // ===== 1) قبل يوم: تنبيه واحد فقط =====
              const dayBefore = new Date(taskDt);
              dayBefore.setDate(dayBefore.getDate() - 1);
              const dayBeforeISO = toLocalISO(dayBefore);

              if (today === dayBeforeISO){
                const onceKey = `proto6_prev_${uid}_${taskId}_${dayBeforeISO}`;
                if (fireOnceKey(onceKey)){
                  fire(onAlert, {
                    ruleId:'protocol_step_tomorrow',
                    severity:'info',
                    taskId,
                    animalId: an,
                    plannedDate: taskDay,
                    plannedTime,
                   message: (scope === 'group')
  ? `غدًا خطوة بروتوكول للمجموعة ${an}${nCount?` (${nCount} حيوان)`:''}: ${step} (${taskDay} ${plannedTime})`
  : `غدًا خطوة بروتوكول للحيوان ${an}: ${step} (${taskDay} ${plannedTime})`

                  });
                }
                continue;
              }

              // ===== 2) يوم التنفيذ: قبلها بساعتين ثم كل 30 دقيقة حتى تسجيل الخطوة =====
              if (today !== taskDay) continue;

              const twoHoursBefore = new Date(taskDt.getTime() - 2*60*60*1000);
              if (now < twoHoursBefore) continue;

              // مفتاح تكرار كل 30 دقيقة
              const repeatKey = `proto6_repeat_${uid}_${taskId}_${today}`;
              if (shouldFireEvery30m(repeatKey)){
                fire(onAlert, {
                  ruleId:'protocol_step_due',
                  severity:'warn',
                  taskId,
                  animalId: an,
                  plannedDate: taskDay,
                  plannedTime,
                  message: (scope === 'group')
  ? `اليوم خطوة بروتوكول للمجموعة ${an}${nCount?` (${nCount} حيوان)`:''}: ${step} (الموعد ${plannedTime})`
  : `اليوم خطوة بروتوكول للحيوان ${an}: ${step} (الموعد ${plannedTime})`

                });
              }
            }
          } catch(e){
            // صامت
          }
        }

        // ✅ شغّل tick فورًا + كل دقيقة (والتكرار الحقيقي كل 30 دقيقة بالمفاتيح)
        if (!P.started){
          P.started = true;
          tickProtocol();
          setInterval(tickProtocol, 60*1000);
        } else {
          // لو checkAll اتنادى مرة ثانية، اكتفي بـ tick سريع
          tickProtocol();
        }
      }
    } // نهاية checkAll()

    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', checkAll, { once:true });
    else
      setTimeout(checkAll, 0);

    return function stop(){};
  }; // نهاية startAlertsWatcher

})(); // نهاية IIFE
