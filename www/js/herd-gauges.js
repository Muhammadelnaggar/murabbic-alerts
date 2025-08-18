// www/js/herd-gauges.js
(function(){
  const $ = (sel)=>document.querySelector(sel);
  const $$ = (sel)=>Array.from(document.querySelectorAll(sel));
  const dayMs = 86400000;

  function drawGauge(el, pct, ranges){
    pct = Math.max(0, Math.min(100, Number(pct)||0));
    const start = Math.PI, end = 2*Math.PI, cx=100, cy=100, r=90;
    const seg=(from,to,color)=>{
      const a0=start+(from/100)*(end-start), a1=start+(to/100)*(end-start);
      const x0=cx+r*Math.cos(a0), y0=cy+r*Math.sin(a0);
      const x1=cx+r*Math.cos(a1), y1=cy+r*Math.sin(a1);
      const large=(a1-a0)>Math.PI?1:0;
      return `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}" stroke="${color}" stroke-width="16" fill="none" />`;
    };
    const pointer=(()=>{
      const a=start+(pct/100)*(end-start);
      const x=cx+(r-12)*Math.cos(a), y=cy+(r-12)*Math.sin(a);
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#111" stroke-width="3" />`;
    })();
    const palette = ranges||[
      {till:50, color:'#fde68a'},
      {till:80, color:'#86efac'},
      {till:100,color:'#22c55e'}
    ];
    let acc=0, arcs='';
    for(const rg of palette){ const next=Math.min(100,rg.till); arcs+=seg(acc,next,rg.color); acc=next; }
    el.innerHTML = `<svg viewBox="0 0 200 120" preserveAspectRatio="xMidYMin slice"><g transform="translate(0,-80)">${arcs}${pointer}</g></svg><div class="val">${pct.toFixed(1)}%</div>`;
  }

  function speciesFromLocal(){
    const herd=(localStorage.getItem('herdType')||localStorage.getItem('species')||'').toLowerCase();
    return /buffalo|جاموس/.test(herd)?'buffalo':'cow';
  }

  async function load(){
    const species = speciesFromLocal();
    const analysisDays = Number(localStorage.getItem('analysisDays')||90);
    const url = `/api/herd-stats?analysisDays=${analysisDays}&species=${species}`;
    const res = await fetch(url, {headers:{'Accept':'application/json'}});
    if(!res.ok) throw new Error(await res.text());
    const j = await res.json();

    const T = j.totals||{}, F=j.fertility||{}, total=T.totalActive||0;

    drawGauge(document.querySelector('[data-key="pregnant"]'),   T.pregnant?.pct??0);
    drawGauge(document.querySelector('[data-key="inseminated"]'),T.inseminated?.pct??0);
    drawGauge(document.querySelector('[data-key="open"]'),       T.open?.pct??0, [
      {till:50,color:'#e5e7eb'},{till:80,color:'#cbd5e1'},{till:100,color:'#94a3b8'}
    ]);
    drawGauge(document.querySelector('[data-key="conception"]'),F.conceptionRatePct??0);

    $('#line-pregnant').textContent    = `${T.pregnant?.count??0} عِشار من ${total} (${T.pregnant?.pct??0}%)`;
    $('#line-inseminated').textContent = `${T.inseminated?.count??0} ملقّحة (آخر ${j.windows.analysisDays}ي) — من ${total} (${T.inseminated?.pct??0}%)`;
    $('#line-open').textContent        = `${T.open?.count??0} مفتوحة — من ${total} (${T.open?.pct??0}%)`;
    $('#line-conception').textContent  = `Conception = ${(F.conceptionRatePct??0)}% • خدمات/حمل = ${(F.avgServicesPerConception??0)}`;
    $('#herd-numbers').innerHTML = `
      إجمالي: <b>${total}</b> • عِشار: <b>${T.pregnant?.count??0}</b> (${T.pregnant?.pct??0}%)
      • مفتوحة: <b>${T.open?.count??0}</b> (${T.open?.pct??0}%) • ملقّحة: <b>${T.inseminated?.count??0}</b> (${T.inseminated?.pct??0}%)
      • Conception: <b>${F.conceptionRatePct??0}%</b> • خدمات/حمل: <b>${F.avgServicesPerConception??0}</b>`;
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    if(document.getElementById('herd-analysis')){
      load().catch(()=>{
        document.getElementById('herd-numbers').textContent='تعذّر جلب ملخص القطيع.';
        $$('.gauge').forEach(g=>g.innerHTML='<div class="val">—</div>');
      });
    }
  });
})();
