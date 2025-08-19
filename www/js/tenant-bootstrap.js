// /js/tenant-bootstrap.js
(() => {
  const UID = localStorage.userId || '';
  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };
  const addUserId = (u) => { try { const x=new URL(u,location.href); if(UID && x.pathname.startsWith('/api/') && !x.searchParams.has('userId')) x.searchParams.append('userId',UID); return x.toString(); } catch { return u; } };

  const _fetch = window.fetch;
  window.fetch = (input, init={}) => {
    try{
      let url = typeof input==='string' ? input : (input?.url||'');
      if(UID && sameOrigin(url) && url.startsWith('/api/')){
        init.headers = new Headers(init.headers||{});
        if(!init.headers.has('X-User-Id')) init.headers.set('X-User-Id', UID);
        url = addUserId(url);
        input = typeof input==='string' ? url : new Request(url, input);
      }
    }catch{}
    return _fetch(input, init);
  };
})();
