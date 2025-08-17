// server/alerts-engine.js
// محرك قواعد التنبيهات الذكية (يُستدعى من server.js)

function v(map, name){ return map && map[name] ? Number(map[name].value) : undefined; }
function pctDrop(newV, oldV){ if(!(newV>0 && oldV>0)) return 0; return (oldV-newV)/oldV; }

/**
 * تقييم تنبيهات "بالحساسات" انطلاقًا من قراءة /ingest
 * @param {Object} p
 * @param {number} p.now
 * @param {string} p.farmId
 * @param {string} p.deviceId
 * @param {Object|null} p.subject  // { animalId } اختياري
 * @param {Object} p.metricsMap    // { name: {value, unit, ts} }
 * @param {Object|null} p.prevDoc  // وثيقة الجهاز قبل التحديث
 */
function evaluateSensorAlerts({ now, farmId, deviceId, subject, metricsMap, prevDoc }) {
  const alerts = [];
  const prev = (prevDoc && prevDoc.metrics) || {};

  // لبن
  const yieldL   = v(metricsMap,'milk.yield_l');
  const prevYield= v(prev,'milk.yield_l');
  const cond     = v(metricsMap,'milk.cond_mScm');
  const prevCond = v(prev,'milk.cond_mScm');
  const color    = v(metricsMap,'milk.color_score');

  // نشاط/شبق
  const heat     = v(metricsMap,'repro.heat_prob_pct');
  const mounts   = v(metricsMap,'repro.mounts_24h');
  const actIdx   = v(metricsMap,'activity.idx');

  // صحة/تغذية
  const bodyT    = v(metricsMap,'body.temp_c');
  const rum      = v(metricsMap,'rumination.min');
  const prevRum  = v(prev,'rumination.min');
  const water    = v(metricsMap,'water.flow_lpm');
  const feedKg   = v(metricsMap,'feed.intake_kg');

  // ===== قواعد مختصرة قابلة للضبط =====
  // 1) اشتباه التهاب ضرع: (cond مرتفع أو قفزة) + (لون غير طبيعي أو هبوط إنتاج)
  const condHigh  = typeof cond==='number' && cond >= 6.0;        // حد أولي
  const condJump  = (cond!=null && prevCond!=null) && cond >= prevCond * 1.2; // قفزة ≥20%
  const colorHigh = typeof color==='number' && color >= 70;        // 0..100
  const yieldDown = (yieldL!=null && prevYield!=null) && pctDrop(yieldL, prevYield) >= 0.2; // ↓20%
  if ((condHigh || condJump) && (colorHigh || yieldDown)) {
    alerts.push(msg('MASTITIS_SUSPECT','warn','اشتباه التهاب ضرع — راجع لون اللبن والتوصيلية والإنتاج'));
  }

  // 2) شبق محتمل
  if ((typeof heat==='number' && heat >= 70) || ((mounts||0) >= 10 && (actIdx||0) >= 60)) {
    alerts.push(msg('HEAT_POSSIBLE','info','شبق محتمل اليوم — راجع مجموعة التلقيح'));
  }

  // 3) حمّى/ارتفاع حرارة جسم
  if (typeof bodyT==='number' && bodyT >= 39.5) {
    alerts.push(msg('FEVER','alert','ارتفاع ملحوظ في حرارة الجسم'));
  }

  // 4) اجترار منخفض
  if ((typeof rum==='number' && rum < 380) || (rum!=null && prevRum!=null && pctDrop(rum, prevRum) >= 0.2)) {
    alerts.push(msg('LOW_RUMINATION','warn','انخفاض في دقائق الاجترار — راجع العليقة والصحة'));
  }

  // 5) تدفق مياه منخفض
  if (typeof water==='number' && water < 1) {
    alerts.push(msg('LOW_WATER_FLOW','info','تدفق مياه منخفض في الحظيرة'));
  }

  // 6) تناول علف منخفض
  if (typeof feedKg==='number' && feedKg < 8) {
    alerts.push(msg('LOW_FEED_INTAKE','info','تناول العلف أقل من الطبيعي'));
  }

  function msg(code, severity, message){
    return { ts:now, farmId, deviceId, subject, code, severity, message, metrics: metricsMap };
  }
  return alerts;
}

/**
 * تنبيهات "بدون حساسات" انطلاقًا من أحداث التطبيق (ولادة، حليب يومي، ...)
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Object} p { now, farmId, event }
 */
async function evaluateAppAlerts(db, { now, farmId, event }) {
  const out = [];
  if (event.type === 'ولادة') {
    out.push({ ts:now, farmId, deviceId:'-', subject:{ animalId:event.animalId }, code:'POSTPARTUM_START', severity:'info', message:'تم تسجيل ولادة — ابدأ متابعة ما بعد الولادة 0–21 يوم', metrics:{} });
  }
  if (event.type === 'حليب-يومي') {
    const y = Number(event.yield_l||0); const f = Number(event.fat_pct||0);
    if (y <= 8 || f < 3) {
      out.push({ ts:now, farmId, deviceId:'-', subject:{ animalId:event.animalId }, code:'LOW_MILK_TODAY', severity:'warn', message:'إنتاج اللبن اليوم منخفض — راجع التغذية/الصحة', metrics:{ 'milk.yield_l':{value:y,unit:'L'}, 'milk.fat_pct':{value:f,unit:'%'} } });
    }
  }
  for (const a of out) await db.collection('alerts').add({ ...a, read:false });
  return out.length;
}

// THI للجاموس (بدون حساس)
function thiBuffalo(t, rh){ const f=t*9/5+32; return Math.round(((f-(0.55-0.0055*rh)*(f-58)))*10)/10; }
function thiLevelBuffalo(thi){ if(thi<68) return ['info','مريح']; if(thi<72) return ['info','اجهاد خفيف']; if(thi<79) return ['warn','اجهاد متوسط']; if(thi<84) return ['alert','اجهاد شديد']; return ['alert','اجهاد شديد جدا']; }

module.exports = { evaluateSensorAlerts, evaluateAppAlerts, thiBuffalo, thiLevelBuffalo };
