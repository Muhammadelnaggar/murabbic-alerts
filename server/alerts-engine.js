// server/alerts-engine.js
// ------------------------------------------------------------
// توحيد أكواد التنبيهات: pregnancy_positive, heat_window_now,
// dryoff_due_soon, calving_due_soon
// يعمل مع حدث التطبيق (evaluateAppAlerts) + قراءات الحساسات (evaluateSensorAlerts)
// ------------------------------------------------------------

'use strict';

const DAY = 24 * 60 * 60 * 1000;

const WINDOWS = {
  heatActivityMin: 90,          // عتبة نشاط تقديرية للشياع (بدون حساسات متقدمة)
  calvingSoonDays: 21,          // قبل الولادة بـ 21 يوم
  dryoffBeforeCalvingDays: 60,  // التجفيف قبل الولادة بـ 60 يوم
  dryoffSoonWindowDays: 10      // نافذة تنبيه "قرب التجفيف"
};

function gestationDays(species) {
  return (String(species || '').toLowerCase() === 'cow') ? 280 : 310; // cow=280, buffalo=310
}

function toDate(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000);
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s + 'T00:00:00Z');
  return new Date(s);
}

function makeAlert({ farmId, subject, code, severity='info', message, ts, source='app', species, meta={} }) {
  return {
    farmId: farmId || 'DEFAULT',
    subject: subject || null,           // مثال: { animalId: '123' }
    code,                               // pregnancy_positive | heat_window_now | dryoff_due_soon | calving_due_soon
    severity,                           // info | warning | critical ...
    message,
    species: (species || 'buffalo').toLowerCase(),
    ts: ts || Date.now(),
    source,                             // 'app' | 'sensor'
    meta
  };
}

// خرائط نصوص رسائل سريعة
const MSG = {
  pregnancy_positive: 'تم تأكيد الحمل (+).',
  heat_window_now: 'نشاط مرتفع يدل على شياع (نافذة الآن).',
  dryoff_due_soon: 'قرب موعد التجفيف (استعد).',
  calving_due_soon: 'قرب موعد الولادة (استعد).'
};

// ===========================================================
// تنبيهات بالحساسات: نشاط مرتفع => heat_window_now
// ===========================================================
function evaluateSensorAlerts(ctx) {
  const out = [];
  try {
    const { now = Date.now(), farmId = 'DEFAULT', subject = {}, metricsMap = {} } = ctx || {};
    const animalId = subject?.animalId || subject?.id || null;
    if (!animalId) return out;

    // نشاط (activity/steps/motion) — حد بسيط مبدئي
    const act =
      Number(metricsMap.activity?.value ?? metricsMap.steps?.value ?? metricsMap.motion?.value ?? NaN);

    if (!Number.isNaN(act) && act >= WINDOWS.heatActivityMin) {
      out.push(makeAlert({
        farmId,
        subject: { animalId },
        code: 'heat_window_now',
        severity: 'warning',
        message: `${MSG.heat_window_now} (activity=${act})`,
        ts: now,
        source: 'sensor'
      }));
    }
  } catch {}
  return out;
}

// ===========================================================
// تنبيهات بتفعيلات التطبيق (أحداث) + استقراء من التاريخ
// ===========================================================
async function evaluateAppAlerts(db, ctx) {
  const out = [];
  const now = Number(ctx?.now || Date.now());
  const farmId = ctx?.farmId || 'DEFAULT';
  const ev = ctx?.event || {};
  const animalId = String(ev.animalId || ev?.subject?.animalId || '').trim();
  const species = (ev.species || 'buffalo').toLowerCase();

  if (!animalId) return out;

  // 1) مباشرةً من الحدث الحالي
  const typeL = String(ev.type || '').toLowerCase();

  // حمل إيجابي
  if (/(preg|حمل)/.test(typeL)) {
    const resField = String(ev.result || ev.status || ev.outcome || ev.note || '').toLowerCase();
    if (/(pos|ايجاب|positive)/.test(resField)) {
      out.push(makeAlert({
        farmId,
        subject: { animalId },
        code: 'pregnancy_positive',
        severity: 'info',
        message: MSG.pregnancy_positive,
        ts: Number(ev.ts || Date.now()),
        species,
        source: 'app',
        meta: { eventId: ev.id || null }
      }));
    }
  }

  // رصد شياع (لو جالك حدث "شياع")
  if (/(heat|شياع)/.test(typeL)) {
    out.push(makeAlert({
      farmId,
      subject: { animalId },
      code: 'heat_window_now',
      severity: 'warning',
      message: MSG.heat_window_now,
      ts: Number(ev.ts || Date.now()),
      species,
      source: 'app',
      meta: { eventId: ev.id || null }
    }));
  }

  // 2) استقراء قرب الولادة/التجفيف بناءً على آخر تلقيح (من Firestore لو متاح)
  try {
    if (db) {
      // آخر تلقيح
      const insSnap = await db.collection('events')
        .where('farmId', '==', farmId)
        .where('animalId', '==', animalId)
        .where('type', '==', 'insemination')
        .orderBy('date', 'desc')
        .limit(1)
        .get();

      if (!insSnap.empty) {
        const ins = insSnap.docs[0].data();
        const insDate = toDate(ins.date || ins.createdAt || ev.ts || Date.now());
        if (insDate) {
          const gest = gestationDays(species);
          const dueDate = new Date(insDate.getTime() + gest * DAY);

          // قرب الولادة
          const calvingSoonStart = new Date(dueDate.getTime() - WINDOWS.calvingSoonDays * DAY);
          if (now >= calvingSoonStart.getTime() && now <= dueDate.getTime()) {
            out.push(makeAlert({
              farmId,
              subject: { animalId },
              code: 'calving_due_soon',
              severity: 'warning',
              message: MSG.calving_due_soon,
              ts: now,
              species,
              source: 'app',
              meta: { inseminationDate: ins.date || null, dueDate: dueDate.toISOString().slice(0,10) }
            }));
          }

          // قرب التجفيف (60 يوم قبل الولادة) + نافذة تنبيه 10 أيام
          const dryoffDate = new Date(dueDate.getTime() - WINDOWS.dryoffBeforeCalvingDays * DAY);
          const drySoonStart = new Date(dryoffDate.getTime() - WINDOWS.dryoffSoonWindowDays * DAY);
          const drySoonEnd   = new Date(dryoffDate.getTime() + 1*DAY); // هامش يوم
          if (now >= drySoonStart.getTime() && now <= drySoonEnd.getTime()) {
            out.push(makeAlert({
              farmId,
              subject: { animalId },
              code: 'dryoff_due_soon',
              severity: 'info',
              message: MSG.dryoff_due_soon,
              ts: now,
              species,
              source: 'app',
              meta: {
                inseminationDate: ins.date || null,
                expectedDryoffDate: dryoffDate.toISOString().slice(0,10),
                expectedCalvingDate: dueDate.toISOString().slice(0,10)
              }
            }));
          }
        }
      }
    }
  } catch (e) {
    // تجاهل أي أخطاء قراءة، ونكمّل باللي قدرنا نطلعه من الحدث الحالي
  }

  // كتابة التنبيهات (لو مطلوب من هنا) تفضل من الراوتر/ingest
  // هنا فقط بنُرجع الـ array للخادم عشان يكتبها.
  return out;
}

module.exports = {
  evaluateSensorAlerts,
  evaluateAppAlerts
};
