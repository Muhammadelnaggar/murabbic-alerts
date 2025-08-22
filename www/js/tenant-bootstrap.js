// /www/js/tenant-bootstrap.js
(() => {
  // اقرأ الـUID من التخزين (تم وضعه أثناء تسجيل الدخول)
  const uid = (localStorage.getItem('userId') || '').trim();

  // دالة تبني هل نضيف الهيدر ولا لأ
  function shouldAttachHeader(url) {
    try {
      const u = new URL(url, location.href);
      const sameOrigin = u.origin === location.origin;
      const hitsApi = u.pathname.startsWith('/api') || u.pathname === '/ingest';
      return sameOrigin && hitsApi;
    } catch { return false; }
  }

  // لفّة fetch لإضافة X-User-Id تلقائيًا لطلبات /api فقط
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    const req = (input instanceof Request) ? input : new Request(input, init || {});
    const headers = new Headers(req.headers || {});
    if (uid && shouldAttachHeader(req.url)) {
      // لا تكتب فوق الهيدر إن كان مُرسل يدويًا
      if (!headers.has('X-User-Id')) headers.set('X-User-Id', uid);
    }
    const nextReq = new Request(req, { headers });
    return _fetch(nextReq);
  };

  // مِساعدة خفيفة لتوحيد بناء روابط الـAPI إن احتجتها
  window.API = (path) => path.startsWith('/') ? path : ('/' + path);

  // تشخيص خفيف
  console.debug('[tenant-bootstrap] X-User-Id =', uid || '(مفقود)');
})();
  // مِساعدة خفيفة لتوحيد بناء روابط الـAPI إن احتجتها
  window.API = (path) => path.startsWith('/') ? path : ('/' + path);

  // تشخيص خفيف
  console.debug('[tenant-bootstrap] X-User-Id =', uid || '(مفقود)');
})();

// إضافة دالة getContext لإرجاع سياق موحّد
window.getContext = function () {
  return {
    userId: localStorage.getItem("userId") || null,
    tenantId: localStorage.getItem("tenantId") || null,
    animalId: localStorage.getItem("currentAnimalId") 
              || localStorage.getItem("lastAnimalId") 
              || null,
    animalNumber: localStorage.getItem("currentAnimalNumber") || null,
    eventDate: localStorage.getItem("lastEventDate") 
              || new Date().toISOString().slice(0,10)
  };
};
