// www/js/herd-gauges.js
(function(){
  // ---------- Helpers ----------
  function getSpecies(){
    const p = localStorage.getItem('herdProfile');
    return (p === 'cow') ? 'cow' : 'buffalo';
  }
  function getApiBase(){
    const v = (localStorage.getItem('API_BASE')||'').trim();
    // لو فيه دومين خارجي صالح (مش localhost) استخدمه، وإلا خليه نسبي
    if (!/^https?:\/\//.test(v) || v.includes('localhost')) return '';
    return v.replace(/\/+$/,'');
  }
  function num(v){
    // يقبل رقم مباشر أو كائن {count, pct}
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && v.count != null) return Number(v.count)||0;
    return Number(v)||0;
  }
  function pctOf(total, part){ return total>0 ? Math.round(part*100/total) : 0; }

  // ---------- رسم عدّاد نصف دائري بسفجي ----------
  const R = 40; // نصف القطر
  const C = Math.PI * R; // طول نصف المحيط (للداشارّي)
  function arcPath(){
    // قوس من (10,50) إلى (90,50) بمركز (50,50) ونصف قطر 40
    return `M 10 50 A ${R} ${R} 0 0 1 90 50`;
  }
  function renderGauge(el, valuePct, labelText){
    valuePct = Math.max(0, Math.min(100, Number(valuePct)||0));

    // أنشئ الـSVG مرة واحدة
    if (!el._svg){
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      wrap.style.width = '100%';
      wrap.style.aspectRatio = '2 / 1';

      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 100 55');
      svg.style.width = '100%';
      svg.style.height = '100%';
      svg.style.display = 'block';

      // خلفية القوس
      const bg = document.createElementNS(svg.namespaceURI,'path');
      bg.setAttribute('d', arcPath());
      bg.setAttribute('fill','none');
      bg.setAttribute('stroke','#e5e7eb'); // رمادي فاتح
      bg.setAttribute('stroke-width','10');
      bg.setAttribute('stroke-linecap','round');

      // القيمـة (تتلوّن)
      const fg = document.createElementNS(svg.namespaceURI,'path');
      fg.setAttribute('d', arcPath());
      fg.setAttribute('fill','none');
      fg.setAttribute('stroke','#10b981'); // أخضر تيـل
      fg.setAttribute('stroke-width','10');
      fg.setAttribute('stroke-linecap','round');
      fg.setAttribute('stroke-dasharray', String(C));
      fg.setAttribute('stroke-dashoffset', String(C));

      // النص بالوسط
      const val = document.createElement('div');
      val.className = 'val';
      val.textContent = '—';

      wrap.appendChild(svg);
      svg.appendChild(bg);
      svg.appendChild(fg);
      el.innerHTML = ''; // نظف
      el.appendChild(wrap);
      el.appendChild(val);

      el._svg = { svg, bg, fg, val };
    }

    // لوّن حسب القيمة (أخضر/أصفر/برتقالي/أحمر خفيف)
    let color = '#10b981';
    if (valuePct >= 85) color = '#059669';
    else if (valuePct >= 60) color = '#22c55e';
    else if (valuePct >= 35) color = '#eab308';
    else if (valuePct > 0)   color = '#f59e0b';
    if (labelText === 'Conception%'){ color = '#2563eb'; } // لون مميّز للكونسبشن

    const dash = C - (C * (valuePct/100));
    el._svg.fg.setAttribute('stroke-dashoffset', String(dash));
    el._svg.fg.setAttribute('stroke', color);
    el._svg.val.textContent = `${valuePct}%`;
    el._svg.val.setAttribute('aria-label', `${labelText}: ${valuePct}%`);
  }

  // ---------- جلب وتحديث ----------
  async function fetchHerdStats(){
    const API = getApiBase();
    const species = getSpecies(); // cow | buffalo
    const url = `${API}/api/herd-stats?species=${encodeURIComponent(species)}&analysisDays=${encodeURIComponent(localStorage.getItem('analysisDays')||'90')}`;
    const r = await fetch(url, API ? { mode:'cors' } : undefined);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function updateLines(j){
    // دعم هيكلتي الناتج
    const totalsObj = j.totals || {};
    const total = totalsObj.totalActive ?? totalsObj.total ?? totalsObj.herd ?? 0;

    const pregCount = num(totalsObj.pregnant);
    const insCount  = num(totalsObj.inseminated);
    const openCount = num(totalsObj.open);

    // لو الـAPI مرجعش pct جاهزة، احسبها
    const pregPct = totalsObj.pregnant?.pct ?? pctOf(total, pregCount);
    const insPct  = totalsObj.inseminated?.pct ?? pctOf(total, insCount);
    const openPct = totalsObj.open?.pct ?? pctOf(total, openCount);

    const conceptionPct =
      (j.fertility && typeof j.fertility.conceptionRatePct === 'number')
        ? Math.round(j.fertility.conceptionRatePct)
        : (j.rates && typeof j.rates.conception_pct === 'number')
          ? Math.round(j.rates.conception_pct)
          : 0;

    // قيّم gauges
    const gaugeMap = {
      pregnant:   { pct: pregPct, label:'Pregnant' },
      inseminated:{ pct: insPct,  label:'Inseminated' },
      open:       { pct: openPct, label:'Open' },
      conception: { pct: conceptionPct, label:'Conception%' }
    };
    document.querySelectorAll('.gauge').forEach(g => {
      const key = g.getAttribute('data-key');
      const cfg = gaugeMap[key];
      if (cfg) renderGauge(g, cfg.pct, cfg.label);
    });

    // سطور تحت كل عدّاد
    const lp = document.getElementById('line-pregnant');
    const li = document.getElementById('line-inseminated');
    const lo = document.getElementById('line-open');
    const lc = document.getElementById('line-conception');

    if (lp) lp.textContent = `${pregCount} من ${total} (${pregPct}%)`;
    if (li) li.textContent = `${insCount} من ${total} (${insPct}%)`;
    if (lo) lo.textContent = `${openCount} من ${total} (${openPct}%)`;

    const denomInsem = j.fertility?.denominators?.inseminationsInWindow ?? (j.counts?.inseminations_in_window ?? null);
    const denomPregs = j.fertility?.denominators?.pregnanciesInWindow ?? (j.counts?.pregnancy_confirms_in_window ?? null);
    if (lc) {
      lc.textContent = (denomInsem != null && denomPregs != null)
        ? `${conceptionPct}% (حمل ${denomPregs} / تلقيحات ${denomInsem})`
        : `${conceptionPct}%`;
    }

    // ملخص الأرقام
    const sum = document.getElementById('herd-numbers');
    if (sum) {
      const avgSvc = (j.fertility && typeof j.fertility.avgServicesPerConception === 'number')
        ? j.fertility.avgServicesPerConception.toFixed(2) : '—';
      sum.innerHTML =
        `<div>إجمالي نشط: <b>${total}</b></div>
         <div>عِشار: <b>${pregCount}</b> (${pregPct}%)</div>
         <div>ملقّحات (نافذة ${j.windows?.analysisDays ?? 90} يوم): <b>${insCount}</b> (${insPct}%)</div>
         <div>مفتوحة: <b>${openCount}</b> (${openPct}%)</div>
         <div>Conception%: <b>${conceptionPct}%</b> — متوسط خدمات/حمل: <b>${avgSvc}</b></div>`;
    }
  }

  async function refresh(){
    try{
      const data = await fetchHerdStats();
      if (data && (data.ok === true || data.totals)) updateLines(data);
    }catch(e){
      // في حالة الخطأ، ما نكسرش الواجهة
      console.warn('herd-gauges:', e);
    }
  }

  // ابدأ عند التحميل
  document.addEventListener('DOMContentLoaded', refresh);

  // إعادة التحميل عند التحويل بين أبقار/جاموس (إن وُجدت الأزرار)
  document.getElementById('herdCow')?.addEventListener('click', ()=> setTimeout(refresh, 50));
  document.getElementById('herdBuffalo')?.addEventListener('click', ()=> setTimeout(refresh, 50));

  // اكسبورت بسيط للاختبار اليدوي
  window._reloadGauges = refresh;
})();
