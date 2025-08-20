// /js/health-check.js
function health() {
  const ok = {
    dataLayer: Array.isArray(window.dataLayer),
    t: typeof window.t?.event === 'function',
    timeline: typeof window.timeline?.init === 'function',
    smart: typeof window.smart?.startAlertsWatcher === 'function',
    userId: !!localStorage.getItem('userId'),
    tenantId: !!localStorage.getItem('tenantId'),
    apiBase: localStorage.getItem('API_BASE') || 'relative',
    online: navigator.onLine,
    sw: !!navigator.serviceWorker?.controller,          // PWA عامل؟
    manifest: !!document.querySelector('link[rel="manifest"]'), // فيه manifest؟
  };

  // تليمِتري:
  try {
    t.event('health_check', {
      page: location.pathname,
      ok: Object.values(ok).every(Boolean),
      ...ok
    });
  } catch {}

  // لوج واضح في الكونسول:
  try { console.table(ok); } catch { console.log('[health_check]', ok); }

  return ok;
}

// تشغيل تلقائي + إتاحة كدالة يدوية:
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', health);
} else {
  health();
}
window.mbkHealth = health; // تقدر تكتب mbkHealth() في الكونسول
