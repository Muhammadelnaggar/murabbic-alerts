// /js/tenant-bootstrap.js
(() => {
  const UID = localStorage.userId || '';

  // نستخدم URL عشان نضمن إضافة userId مرة واحدة فقط
  const sameOrigin = (u) => {
    try { return new URL(u, location.href).origin === location.origin; }
    catch { return false; }
  };
  const addUserIdParam = (u) => {
    try {
      const url = new URL(u, location.href);
      if (UID && url.pathname.startsWith('/api/') && !url.searchParams.has('userId')) {
        url.searchParams.append('userId', UID);
      }
      return url.toString();
    } catch { return u; }
  };

  // Helper متاح لو حبيت تستخدمه يدويًا (اختياري)
  window.API = (p) => addUserIdParam(p);

  // Patch لـ fetch: يضيف الهيدر + باراميتر userId تلقائيًا لكل /api/*
  const _fetch = window.fetch;
  window.fetch = (input, init = {}) => {
    try {
      let url = typeof input === 'string' ? input : (input?.url || '');
      if (UID && sameOrigin(url) && url.startsWith('/api/')) {
        // 1) أضف الهيدر
        init.headers = new Headers(init.headers || {});
        if (!init.headers.has('X-User-Id')) init.headers.set('X-User-Id', UID);
        // 2) أضف ?userId= لو مش موجود
        url = addUserIdParam(url);
        input = typeof input === 'string' ? url : new Request(url, input);
      }
    } catch {}
    return _fetch(input, init);
  };
})();
