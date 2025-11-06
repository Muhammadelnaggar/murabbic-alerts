// KPI Engine v1.0 — Species Filter Enabled (Cow/Buffalo/All)
// DIM>=3 filter applied for production KPIs
// Dynamic thresholds using last 14-21 days rolling window
// Based on Firestore events: daily_milk, insemination, calving, pregnancy-diagnosis, abortion

// /www/js/herd-gauges.js
(() => {
  const qs = (sel, el = document) => el.querySelector(sel);
  const qsa = (sel, el = document) => [...el.querySelectorAll(sel)];
  const fmtPct = (x) => Number.isFinite(x) ? Math.round(x) + '%' : '—';

  function ensureGauge(el) {
    if (el.__wired) return;
    el.__wired = true;
    el.innerHTML = `
      <svg viewBox="0 0 100 50" aria-hidden="true">
        <path d="M10,50 A40,40 0 0 1 90,50" fill="none" stroke="#eee" stroke-width="10" />
        <path class="bar" d="M10,50 A40,40 0 0 1 90,50" fill="none" stroke="#2e7d32" stroke-width="10" stroke-linecap="round" stroke-dasharray="0 250"/>
      </svg>
      <div class="val">—</div>
    `;
  }
  function setGauge(el, pct) {
    ensureGauge(el);
    const dash = Math.max(0, Math.min(100, +pct || 0)) * 1.57; // قوس نصف دائرة
    qs('.bar', el).setAttribute('stroke-dasharray', `${dash} 250`);
    qs('.val', el).textContent = fmtPct(pct);
  }

  // كتابة سطر الوصف تحت كل عداد
  function setLine(id, text) {
    const el = qs('#' + id);
    if (el) el.textContent = text;
  }

  async function getJSON(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  async function load() {
    // النوع المختار (جاموس/أبقار)
    const species = (localStorage.getItem('herdProfile') || 'buffalo').toLowerCase();

    // 1) اقرأ الحيوانات (للتأكد من ظهورها للمستخدم)
    const animals = await getJSON(API('/api/animals')) || [];
    const totalAnimals = Array.isArray(animals) ? animals.length
                       : Array.isArray(animals.items) ? animals.items.length : 0;

    // 2) إحصاءات القطيع
    const stats = await getJSON(API(`/api/herd-stats?species=${encodeURIComponent(species)}&analysisDays=90`));

    // إعداد القيم الافتراضية (لو حصل خطأ، ما نرميش 500 للواجهة)
    const S = {
      totalActive: 0,
      pregnantCnt: 0, pregnantPct: 0,
      inseminatedCnt: 0, inseminatedPct: 0,
      openCnt: 0, openPct: 0,
      conceptionPct: 0
    };

    if (stats && stats.ok && stats.totals) {
      S.totalActive     = +stats.totals.totalActive || 0;
      S.pregnantCnt     = +(stats.totals.pregnant?.count || 0);
      S.pregnantPct     = +(stats.totals.pregnant?.pct || 0);
      S.inseminatedCnt  = +(stats.totals.inseminated?.count || 0);
      S.inseminatedPct  = +(stats.totals.inseminated?.pct || 0);
      S.openCnt         = +(stats.totals.open?.count || 0);
      S.openPct         = +(stats.totals.open?.pct || 0);
      S.conceptionPct   = +(stats.fertility?.conceptionRatePct || 0);
    } else {
      // fallback: لو السيرفر رجّع خطأ، استخدم عدد الحيوانات على الأقل للعرض
      S.totalActive = totalAnimals;
    }

    // رسم العدادات
    setGauge(qs('.gauge[data-key="pregnant"]'),    S.pregnantPct);
    setGauge(qs('.gauge[data-key="inseminated"]'), S.inseminatedPct);
    setGauge(qs('.gauge[data-key="open"]'),        S.openPct);
    setGauge(qs('.gauge[data-key="conception"]'),  S.conceptionPct);

    // السطور التوضيحية
    setLine('line-pregnant',    `عِشار: ${S.pregnantCnt} من ${S.totalActive}`);
    setLine('line-inseminated', `ملقّحات: ${S.inseminatedCnt} من ${S.totalActive}`);
    setLine('line-open',        `مفتوحة: ${S.openCnt} من ${S.totalActive}`);
    setLine('line-conception',  `Conception: ${fmtPct(S.conceptionPct)}`);

    const numbersEl = qs('#herd-numbers');
    if (numbersEl) {
      numbersEl.textContent =
        `إجمالي نشِط: ${S.totalActive} • عِشار: ${S.pregnantCnt} • ملقّحات: ${S.inseminatedCnt} • مفتوحة: ${S.openCnt}`;
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
