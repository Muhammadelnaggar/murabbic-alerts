// www/js/tenant-bootstrap.js (v2) — يضيف X-User-Id تلقائيًا لكل طلب داخلي
(function(){
  // helper: هل الـURL داخلي لنفس الدومين؟
  function isInternal(url){
    if (!url) return false;
    // relative without slash e.g. "api/animals" => داخلي
    if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) return true;
    try { return new URL(url, location.href).origin === location.origin; }
    catch { return url.startsWith('/') || url.startsWith(location.origin); }
  }
  function getUID(){ return localStorage.getItem('userId') || window.__tenantUID || ''; }

  // ---- Patch fetch ----
  const origFetch = window.fetch;
  window.fetch = function(input, init){
    init = init || {};
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (isInternal(url)) {
      const h = new Headers(init.headers || (input && input.headers) || {});
      const uid = getUID();
      if (uid && !h.has('X-User-Id')) h.set('X-User-Id', uid);
      init.headers = h;
      // قوّم الروابط النسبية بدون / (api/...) لتبقى /api/...
      if (typeof input === 'string' && !input.startsWith('/') && !/^https?:\/\//i.test(input) && !input.startsWith('//')) {
        input = '/' + input;
      }
    }
    return origFetch(input, init);
  };

  // ---- Patch axios (لو موجود) ----
  if (window.axios && window.axios.interceptors) {
    window.axios.interceptors.request.use(cfg=>{
      try{
        const url = cfg.url || '';
        if (isInternal(url)) {
          cfg.headers = cfg.headers || {};
          const uid = getUID();
          if (uid && !('X-User-Id' in cfg.headers)) cfg.headers['X-User-Id'] = uid;
          if (!/^https?:\/\//i.test(url) && !url.startsWith('//') && !url.startsWith('/')) {
            cfg.url = '/' + url; // قوّم الروابط النسبية
          }
        }
      }catch{}
      return cfg;
    });
  }

  // ---- Patch XHR (حالات قديمة) ----
  (function(){
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url){
      this.__req_url__ = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body){
      try{
        const url = this.__req_url__ || '';
        if (isInternal(url)) {
          const uid = getUID();
          if (uid) this.setRequestHeader('X-User-Id', uid);
          if (!/^https?:\/\//i.test(url) && !url.startsWith('//') && !url.startsWith('/')) {
            // لو dev بيستخدم XHR يدويًا برابط نسبي، ننبهه في الكونسول مرة
            if (!sessionStorage.getItem('xhr_rel_warn')) {
              console.warn('تنبيه: استخدم روابط تبدأ بـ / للـXHR: تم إرسال الهيدر لكن المسار نسبي:', url);
              sessionStorage.setItem('xhr_rel_warn','1');
            }
          }
        }
      }catch{}
      return origSend.apply(this, arguments);
    };
  })();

  // لوج خفيف يساعدك تتأكد مرة واحدة
  if (!sessionStorage.getItem('tenant_bootstrap_logged')) {
    sessionStorage.setItem('tenant_bootstrap_logged','1');
    console.log('%c[tenant] X-User-Id =', 'color:#28a745;font-weight:bold', getUID() || '(غير مضبوط)');
  }
})();
