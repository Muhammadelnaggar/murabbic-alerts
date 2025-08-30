// /js/track-closeup.js
(function(){
  const f = document.getElementById('closeupForm');
  if (!f) return;
  f.addEventListener('change', (e)=>{
    const n = e.target?.name;
    if (!n) return;
    window.t?.event('closeup_change', { field: n, page: location.pathname });
  }, {passive:true});
})();
