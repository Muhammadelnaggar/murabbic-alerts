// /js/tenant-bootstrap.js
(() => {
  const UID = localStorage.userId || '';

  // helper يضيف ?userId= تلقائياً لأي مسار API
  window.API = (p) => UID ? `${p}${p.includes('?') ? '&' : '?'}userId=${encodeURIComponent(UID)}` : p;

  // patch لـ fetch: يضيف X-User-Id تلقائياً لكل طلب /api/*
  const _fetch = window.fetch;
  window.fetch = (input, init = {}) => {
    try {
      const url = typeof input === 'string' ? input : (input?.url || '');
      if (UID && url.startsWith('/api/')) {
        init.headers = new Headers(init.headers || {});
        if (!init.headers.has('X-User-Id')) init.headers.set('X-User-Id', UID);
      }
    } catch {}
    return _fetch(input, init);
  };
})();
