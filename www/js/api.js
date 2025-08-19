// /js/api.js
window.api = {
  async get(path){
    const r = await fetch(path.startsWith('/api/')? path : '/api'+path);
    if(!r.ok) throw new Error(`GET ${path} ${r.status}`);
    return r.json();
  },
  async post(path, body){
    const r = await fetch(path.startsWith('/api/')? path : '/api'+path, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    if(!r.ok) throw new Error(`POST ${path} ${r.status}`);
    return r.json();
  }
};
