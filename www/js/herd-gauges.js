// www/js/herd-gauges.js  (نسخة مستقرة)
(function () {
  const root = document.getElementById('herd-analysis');
  if (!root) return;

  const els = {
    gPreg: root.querySelector('.gauge[data-key="pregnant"]'),
    gIns:  root.querySelector('.gauge[data-key="inseminated"]'),
    gOpen: root.querySelector('.gauge[data-key="open"]'),
    gConc: root.querySelector('.gauge[data-key="conception"]'),
    lPreg: document.getElementById('line-pregnant'),
    lIns:  document.getElementById('line-inseminated'),
    lOpen: document.getElementById('line-open'),
    lConc: document.getElementById('line-conception'),
    numbers: document.getElementById('herd-numbers')
  };

  function pctSafe(v){ v = Number(v||0); if (isNaN(v) || v<0) v=0; if (v>100) v=100; return Math.round(v); }

  // رسم نصف عدّاد بسيط بالـSVG
  function drawGauge(el, pct) {
    if (!el) return;
    const p = pctSafe(pct);
    const angle = (p / 100) * 180;         // 0..180
    const r = 45, cx = 50, cy = 50;
    // needle end
    const nx = cx + r * Math.cos((Math.PI * (180 - angle)) / 180);
    const ny = cy - r * Math.sin((Math.PI * (180 - angle)) / 180);

    el.innerHTML = `
      <svg viewBox="0 0 100 60" width="100%" height="100%">
        <!-- الخلفية -->
        <path d="M5,50 A45,45 0 0 1 95,50" fill="none" stroke="#eee" stroke-width="12"/>
        <!-- ألوان القطاعات -->
        <path d="M5,50 A45,45 0 0 1 35,10" fill="none" stroke="#90caf9" stroke-width="12"/>
        <path d="M35,10 A45,45 0 0 1 65,10" fill="none" stroke="#fff59d" stroke-width="12"/>
        <path d="M65,10 A45,45 0 0 1 95,50" fill="none" stroke="#ffcc80" stroke-width="12"/>
        <!-- المؤشر -->
        <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#000" stroke-width="2"/>
        <circle cx="${cx}" cy="${cy}" r="3" fill="#000"/>
      </svg>
      <div class="val">${p}%</div>
    `;
  }

  // عرض السطور أسفل كل عدّاد
  function setLine(el, txt){ if (el) el.textContent = txt; }

  function renderGauges(data){
    try{
      const t = data?.totals || {};
      const fert = data?.fertility || {};
      const total = Number(t.totalActive||0);

      drawGauge(els.gPreg, t.pregnant?.pct);
      drawGauge(els.gIns,  t.inseminated?.pct);
      drawGauge(els.gOpen, t.open?.pct);
      drawGauge(els.gConc, fert.conceptionRatePct);

      setLine(els.lPreg, total ? `${t.pregnant?.count||0} من ${total}` : '—');
      setLine(els.lIns,  total ? `${t.inseminated?.count||0} من ${total}` : '—');
      setLine(els.lOpen, total ? `${t.open?.count||0} من ${total}` : '—');
      setLine(els.lConc, typeof fert.conceptionRatePct==='number' ? `${pctSafe(fert.conceptionRatePct)}%` : '—');

      if (els.numbers) {
        const d = fert?.denominators || {};
        els.numbers.textContent =
          `إجمالي نشط: ${total} — تلقيحات نافذة: ${d.inseminationsInWindow||0} — حمول نافذة: ${d.pregnanciesInWindow||0}`;
      }
    }catch(e){
      console.error('renderGauges error:', e);
    }
  }

  async function refreshGauges(){
    try{
      const species = (localStorage.getItem('herdProfile')==='cow') ? 'cow' : 'buffalo';
      const farmId  = localStorage.getItem('farmId') || localStorage.getItem('FARM_ID') || 'DEFAULT';

      const r = await fetch(`/api/herd-stats?species=${encodeURIComponent(species)}&farmId=${encodeURIComponent(farmId)}`, {
        headers: { 'x-farm-id': farmId }
      });
      if (!r.ok) throw new Error('http '+r.status);
      const j = await r.json();
      renderGauges(j);
    }catch(e){
      console.error('herd-gauges refresh failed:', e);
      // فشل: صفّر العدادات بدل ما تفضل "—"
      renderGauges({
        totals:{ totalActive:0, pregnant:{count:0,pct:0}, inseminated:{count:0,pct:0}, open:{count:0,pct:0} },
        fertility:{ conceptionRatePct:0, denominators:{ inseminationsInWindow:0, pregnanciesInWindow:0 } }
      });
    }
  }

  // نعرّفها جلوبال لأن الداشبورد بيناديها
  window.renderGauges = renderGauges;
  window.refreshHerdGauges = refreshGauges;

  document.addEventListener('DOMContentLoaded', refreshGauges);
  window.addEventListener('focus', refreshGauges);
})();
