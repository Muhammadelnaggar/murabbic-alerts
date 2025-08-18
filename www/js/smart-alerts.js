// www/js/smart-alerts.js
// تنبيهات الواجهة (خفيف للداشبورد) — يسحب /api/alerts ويعرض Toasts بسيطة.
// يعمل بأمان حتى لو Firestore غير مفعّل (بيسكت بدون أخطاء).

(function () {
  // ==== إعدادات صغيرة ====
  const POLL_MS = 60 * 1000; // كل دقيقة
  const MAX_TOASTS = 4;

  // عناوين/أيقونات للتنبيهات الموحدة
  const TITLES = {
    pregnancy_positive: 'حمل مؤكد',
    heat_window_now: 'شبق محتمل الآن',
    dryoff_due_soon: 'قرب الجفاف',
    calving_due_soon: 'قرب الولادة'
  };
  const ICONS = {
    pregnancy_positive: '🤰',
    heat_window_now: '🔥',
    dryoff_due_soon: '🥛',
    calving_due_soon: '🐄'
  };

  // API base (يسمح بوضع نطاق مختلف في localStorage.API_BASE)
  function getApiBase() {
    const v = (localStorage.getItem('API_BASE') || '').trim();
    if (!/^https?:\/\//.test(v) || v.includes('localhost')) return '';
    return v.replace(/\/+$/, '');
  }

  // حالة آخر تنبيه
  let lastTs = Number(localStorage.getItem('alerts:lastTs') || 0);
  const seen = new Set();

  // ==== CSS للتوست ====
  const css = `
  #alertsToasts{position:fixed;left:12px;bottom:12px;display:flex;flex-direction:column;gap:8px;z-index:9999;direction:rtl}
  .toast{position:relative;background:#fff;border:1px solid #c5e1a5;border-radius:12px;padding:10px 14px;min-width:220px;max-width:84vw;
         box-shadow:0 6px 14px rgba(0,0,0,.10);color:#1b5e20}
  .toast .h{font-weight:700;margin-bottom:4px}
  .toast .m{font-size:12px;color:#2e7d32}
  .toast .x{position:absolute;inset-inline-start:8px;top:6px;cursor:pointer;color:#2e7d32}
  .toast.pregnancy_positive{border-color:#66bb6a}
  .toast.heat_window_now{border-color:#ef6c00}
  .toast.dryoff_due_soon{border-color:#1565c0}
  .toast.calving_due_soon{border-color:#8e24aa}
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // حاوية التوست
  let holder = document.getElementById('alertsToasts');
  if (!holder) { holder = document.createElement('div'); holder.id = 'alertsToasts'; document.body.appendChild(holder); }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  function toast(a) {
    if (!a) return;
    if (a.id && seen.has(a.id)) return;
    if (a.id) seen.add(a.id);

    // تقليم القديم
    while (holder.children.length >= MAX_TOASTS) holder.removeChild(holder.firstChild);

    const code = String(a.code || '').trim();
    const el = document.createElement('div');
    el.className = `toast ${code}`;
    const title = TITLES[code] || (a.title || 'تنبيه');
    const icon  = ICONS[code] || '🔔';
    const msg   = a.message || a.summary || '';
    el.innerHTML = `
      <div class="x" title="إغلاق">✕</div>
      <div class="h">${icon} ${esc(title)}</div>
      <div class="m">${esc(msg)}</div>
    `;
    el.querySelector('.x').onclick = () => el.remove();
    holder.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }

  async function fetchAlerts() {
    try {
      const base = getApiBase() || '';
      let url = (base ? `${base}/api/alerts` : '/api/alerts');
      const qs = new URLSearchParams();
      const farm = (localStorage.getItem('farmId') || '').trim();
      if (farm) qs.set('farm', farm);
      if (lastTs > 0) qs.set('since', String(lastTs)); else qs.set('days', '1');
      qs.set('limit', '100');
      url += `?${qs.toString()}`;

      const opts = base ? { mode: 'cors' } : {};
      const r = await fetch(url, opts).catch(() => null);
      if (!r) return;
      if (r.status === 503) { // Firestore غير مفعّل
        console.debug('[smart-alerts] alerts API disabled.');
        return;
      }
      if (!r.ok) return;

      const j = await r.json();
      const arr = (j.items || j.alerts || []).slice().sort((a, b) => (a.ts||0) - (b.ts||0));
      for (const it of arr) {
        if (it.ts && it.ts > lastTs) lastTs = it.ts;
        toast(it);
      }
      localStorage.setItem('alerts:lastTs', String(lastTs));
    } catch (e) {
      // صمت — لا نكسر الصفحة
    }
  }

  function tick() {
    fetchAlerts();
  }

  window.addEventListener('DOMContentLoaded', () => {
    tick();
    setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  });

  // API بسيط لو احتجته لاحقًا
  window.smartAlerts = { fetchNow: tick, get lastTs(){ return lastTs; } };
})();
