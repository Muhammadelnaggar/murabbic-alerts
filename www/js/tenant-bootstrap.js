// www/js/tenant-bootstrap.js
(function () {
  // خزّن الـUID وبلّغ الصفحة إنه جاهز
  function setUID(uid) {
    if (!uid) return;
    localStorage.setItem('userId', uid);
    window.__tenantUID = uid;
    try { document.dispatchEvent(new CustomEvent('tenant:ready', { detail: { uid } })); } catch {}
  }

  // 1) لو UID محفوظ قبل كده، استخدمه فورًا
  const cached = localStorage.getItem('userId');
  if (cached) setUID(cached);

  // 2) التقط UID من Firebase Auth (يدعم النسختين v8 / v9)
  try {
    // v8 namespaced: window.firebase.auth()
    if (window.firebase && window.firebase.auth) {
      window.firebase.auth().onAuthStateChanged(u => { if (u) setUID(u.uid); });
    }
    // v9 modular (ع المراية العالمية لو محمّل من CDN)
    else if (window.getAuth && window.onAuthStateChanged) {
      const auth = window.getAuth();
      window.onAuthStateChanged(auth, (u) => { if (u) setUID(u.uid); });
    }
  } catch (e) { /* تجاهل */ }

  // 3) رقّع fetch: أضِف X-User-Id لكل طلب داخلي تلقائيًا
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const sameOrigin = url.startsWith('/') || url.startsWith(location.origin);
    if (sameOrigin) {
      const uid = localStorage.getItem('userId') || window.__tenantUID || '';
      const headers = new Headers(init.headers || (input && input.headers) || {});
      if (uid && !headers.has('X-User-Id')) headers.set('X-User-Id', uid);
      init.headers = headers;
    }
    return origFetch(input, init);
  };
})();
