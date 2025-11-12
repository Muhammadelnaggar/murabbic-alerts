
// /www/js/tenant-bootstrap.js
// ✅ Fix API base for Render deployment (murabbic-alerts)
if (!localStorage.getItem('API_BASE')) {
  localStorage.setItem('API_BASE', 'https://murabbic-alerts.onrender.com');
}

const API_BASE = localStorage.getItem('API_BASE');
console.log("🌐 API_BASE =", API_BASE);

(() => {
  // دالة تجيب الـ UID لحظيًا (مش مرة واحدة وقت التحميل)
  function getUid() {
    try {
      return (localStorage.getItem('userId') || '').trim();
    } catch {
      return '';
    }
  }

  // نحدد هل نضيف الهيدر ولا لأ
  function shouldAttachHeader(url) {
    try {
      const u = new URL(url, location.href);
      const sameOrigin = (u.origin === location.origin);
      const hitsApi = u.pathname.startsWith('/api') || u.pathname === '/ingest';
      return sameOrigin && hitsApi;
    } catch {
      return false;
    }
  }

  // لفّة fetch لإضافة X-User-Id تلقائيًا لطلبات /api على نفس الـ origin
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const req = (input instanceof Request)
      ? input
      : new Request(input, init || {});

    const headers = new Headers(req.headers || {});
    const uid = getUid();

    if (uid && shouldAttachHeader(req.url) && !headers.has('X-User-Id')) {
      headers.set('X-User-Id', uid);
    }

    const nextReq = new Request(req, { headers });
    return _fetch(nextReq);
  };

  // أداة بسيطة لبناء مسار الـ API
  window.API = (path) => path.startsWith('/') ? path : ('/' + path);

  // تشخيص خفيف
  console.debug('[tenant-bootstrap] X-User-Id =', getUid() || '(مفقود)');
})(); // ← قفلة الـ IIFE

// getContext متاحة عالميًا للاستخدام في الصفحات الأخرى
window.getContext = function () {
  return {
    userId: localStorage.getItem('userId') || null,
    tenantId: localStorage.getItem('tenantId') || null,
    animalId:
      localStorage.getItem('currentAnimalId') ||
      localStorage.getItem('lastAnimalId') ||
      null,
    animalNumber: localStorage.getItem('currentAnimalNumber') || null,
    eventDate:
      localStorage.getItem('lastEventDate') ||
      new Date().toISOString().slice(0, 10)
  };
};
