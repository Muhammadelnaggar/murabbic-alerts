// www/js/herd-gauges.js — ربط الداشبورد بـ /api/herd-stats مع تمرير farmId
(function(){
  // ===== Helpers =====
  function getApiBase(){
    const v = (localStorage.getItem('API_BASE')||'').trim();
    if(!/^https?:\/\//.test(v) || v.includes('localhost')) return '';
    return v;
  }
  function getSpecies(){
    // herdProfile: 'cow' أو 'buffalo' (يتحدد من ويدجت الطقس)
    return (localStorage.getItem('herdProfile') === 'cow') ? 'cow' : 'buffalo';
  }
  function getFarmId(){
    // عيّنها مرّة من الكونسول إن مش موجودة: localStorage.setItem('FARM_ID','DEFAULT')
    return localStorage.getItem('FARM_ID') || 'DEFAULT';
  }

  // ===== رسم عدّاد نصف دائري بسيط =====
  function drawGauge(container, pct){
    if (!container) return;
    const p = Math.max(0, Math.min(100, Number(pct)||0));
    const w = 200, h = 100, r = 90, cx = 100, cy = 100;
    const toXY = (angleRad) => ({
      x: cx + r * Math.cos(angleRad),
      y: cy - r * Math.sin(angleRad)
    });
    const start = toXY(Math.PI);                   // يسار
    const angle = Math.PI - (Math.PI * p / 100);   // من π إلى 0
    const end   = toXY(angle);
    const largeArc = p > 50 ? 1 : 0;

    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" aria-label="Gauge ${p}%">
        <!-- مسار الخلفية -->
        <path d="M ${cx-r} ${cy} A ${r} ${r} 0 1 1 ${cx+r} ${cy}"
              fill="none" stroke="#e5e7eb" stroke-width="14" stroke-linecap="round"/>
        <!-- المسار الفعّال -->
        <path d="M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}"
              fill="none" stroke="#10b981" stroke-width="14" stroke-linecap="round"/>
      </svg>
      <div class="val">${p.toFixed(1)}%</div>
    `;
  }

  // ===== تحديث النصوص تحت العدّادات =====
  function setLine(id, txt){
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  // ===== جلب ملخص القطيع =====
  async function fetchHerdStats(){
    const API_BASE = getApiBase();
    const qs = new URLSearchParams({
      species: getSpecies(),
      farmId:  getFarmId()
    });
    const url = (API_BASE ? `${API_BASE}/api/herd-stats` : `/api/herd-stats`) + `?${qs.toString()}`;
    const opts = API_BASE ? { mode: 'cors' } : {};
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('herd-stats http error');
    return await r.json();
  }

  // ===== ربط البيانات بالواجهة =====
  function renderHerdStats(data){
    if (!data || !data.ok) return;

    const total = Number(data.totals?.totalActive || 0);

    // القيم الأساسية
    const pregC = Number(data.totals?.pregnant?.count || 0);
    const pregP = Number(data.totals?.pregnant?.pct   || 0);

    const insC  = Number(data.totals?.inseminated?.count || 0);
    const insP  = Number(data.totals?.inseminated?.pct   || 0);

    const openC = Number(data.totals?.open?.count || 0);
    const openP = Number(data.totals?.open?.pct   || 0);

    const concP = Number(data.fertility?.conceptionRatePct || 0);
    const avgSPC= Number(data.fertility?.avgServicesPerConception || 0);

    // رسم العدّادات
    drawGauge(document.querySelector('.gauge[data-key="pregnant"]'),   pregP);
    drawGauge(document.querySelector('.gauge[data-key="inseminated"]'),insP);
    drawGauge(document.querySelector('.gauge[data-key="open"]'),       openP);
    drawGauge(document.querySelector('.gauge[data-key="conception"]'), concP);

    // السطور أسفل كل عدّاد
    setLine('line-pregnant',   `${pregC} من ${total} (${pregP.toFixed(1)}%)`);
    setLine('line-inseminated',`${insC} من ${total} (${insP.toFixed(1)}%)`);
    setLine('line-open',       `${openC} من ${total} (${openP.toFixed(1)}%)`);
    setLine('line-conception', `${concP.toFixed(1)}% • متوسط خدمات/حمل: ${avgSPC.toFixed(2)}`);

    // ملخص الأرقام (مساعد)
    const denIns = Number(data.fertility?.denominators?.inseminationsInWindow || 0);
    const denPreg= Number(data.fertility?.denominators?.pregnanciesInWindow   || 0);
    const box = document.getElementById('herd-numbers');
    if (box){
      box.innerHTML = `
        إجمالي نشط: <b>${total}</b><br/>
        تلقيحات في نافذة التحليل: <b>${denIns}</b> — اختبارات حمل موجبة في النافذة: <b>${denPreg}</b><br/>
        Conception%: <b>${concP.toFixed(1)}%</b> — خدمات/حمل: <b>${avgSPC.toFixed(2)}</b>
      `;
    }
  }

 async function refresh(){
  try{
    const API_BASE = (localStorage.getItem('API_BASE')||'').trim();
    const url = (API_BASE && !API_BASE.includes('localhost'))
      ? `${API_BASE}/api/herd-stats?species=${getSpecies()}`
      : `/api/herd-stats?species=${getSpecies()}`;

    const r = await fetch(url, { mode: API_BASE ? 'cors' : 'same-origin' });
    if(!r.ok){ throw new Error('herd-stats http error'); }

    const j = await r.json();
    renderGauges(j); // الدالة اللي ترسم المقاييس
  }catch(e){
    console.warn('herd-gauges refresh failed:', e.message);
    // قيم افتراضية هادئة علشان ما تبانش أخطاء للمستخدم
    renderGauges({
      ok:false,
      totals:{ totalActive:0, pregnant:{count:0,pct:0}, inseminated:{count:0,pct:0}, open:{count:0,pct:0} },
      fertility:{ conceptionRatePct:0, avgServicesPerConception:0, denominators:{ inseminationsInWindow:0, pregnanciesInWindow:0 } }
    });
  }
}


  document.addEventListener('DOMContentLoaded', ()=>{
    // تعديل: لو عندك تعريف قديم لـ const species داخل هذا الملف، احذفه.
    // إحنا بنقرأها بدالة getSpecies() من localStorage.
    if (!localStorage.getItem('FARM_ID')) {
      // افتراضي للتجربة الأولى
      localStorage.setItem('FARM_ID','DEFAULT');
    }
    refresh();
    // تحديث كل 5 دقائق
    setInterval(refresh, 5 * 60 * 1000);
  });
})();
