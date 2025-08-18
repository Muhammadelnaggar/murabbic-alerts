// www/js/herd-gauges.js
(function () {
  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function getUserId() {
    return (
      localStorage.getItem('currentUserId') ||
      localStorage.getItem('user_id') ||
      localStorage.getItem('userId') ||
      'DEFAULT'
    );
  }
  function getSpecies() {
    return localStorage.getItem('herdProfile') === 'cow' ? 'cow' : 'buffalo';
  }

  async function fetchHerdStats() {
    const userId = getUserId();
    const species = getSpecies();
    const qs = new URLSearchParams({
      species,
      analysisDays: '90',
      userId, // ← نمرّر userId كـ query
    });
    const res = await fetch(`/api/herd-stats?${qs}`, {
      headers: { 'X-User-Id': userId }, // ← ونمرّره أيضاً في الهيدر
    });
    if (!res.ok) throw new Error('herd-stats http error');
    return await res.json();
  }

  function drawGauge(el, pct) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    el.innerHTML = '';
    el.classList.add('gauge');

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 100');
    svg.setAttribute('aria-hidden', 'true');

    const track = document.createElementNS(svgNS, 'path');
    track.setAttribute('d', 'M10,100 A90,90 0 0 1 190,100');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', '#e5e7eb');
    track.setAttribute('stroke-width', '14');
    track.setAttribute('stroke-linecap', 'round');
    svg.appendChild(track);

    const val = document.createElementNS(svgNS, 'path');
    val.setAttribute('d', 'M10,100 A90,90 0 0 1 190,100');
    val.setAttribute('fill', 'none');
    val.setAttribute('stroke', '#10b981'); // أخضر
    val.setAttribute('stroke-width', '14');
    val.setAttribute('stroke-linecap', 'round');
    val.style.transition = 'stroke-dasharray .6s ease';
    svg.appendChild(val);

    el.appendChild(svg);

    const L = val.getTotalLength();
    const on = (pct / 100) * L;
    val.style.strokeDasharray = `${on} ${L - on}`;

    const lbl = document.createElement('div');
    lbl.className = 'val';
    lbl.textContent = `${Math.round(pct)}%`;
    el.appendChild(lbl);
  }

  function setLine(id, txt) {
    const el = document.getElementById(`line-${id}`);
    if (el) el.textContent = txt;
  }

  async function refresh() {
    try {
      const data = await fetchHerdStats();
      const totals = data.totals || {};
      const totalActive = Number(totals.totalActive || 0);

      const mapPct = {
        pregnant: totals.pregnant?.pct || 0,
        inseminated: totals.inseminated?.pct || 0,
        open: totals.open?.pct || 0,
        conception: data.fertility?.conceptionRatePct || 0,
      };

      $$('.gauge').forEach((g) => {
        const key = g.dataset.key;
        drawGauge(g, mapPct[key] || 0);
      });

      setLine('pregnant', `${totals.pregnant?.count || 0} من ${totalActive}`);
      setLine('inseminated', `${totals.inseminated?.count || 0} من ${totalActive}`);
      setLine('open', `${totals.open?.count || 0} من ${totalActive}`);

      const sum = document.getElementById('herd-numbers');
      if (sum) {
        const insW = data.fertility?.denominators?.inseminationsInWindow || 0;
        const pregW = data.fertility?.denominators?.pregnanciesInWindow || 0;
        sum.textContent = `إجمالي نشِط: ${totalActive} — تلقيحات في النافذة: ${insW} — حمول موجبة: ${pregW}`;
      }
    } catch (e) {
      console.error('herd-gauges', e);
    }
  }

  document.addEventListener('DOMContentLoaded', refresh);
})();
