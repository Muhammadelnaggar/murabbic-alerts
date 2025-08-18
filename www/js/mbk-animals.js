/* www/js/mbk-animals.js  —  قناة مرور معلومات الحيوان بين الصفحات */
(function(){
  const MBK = window.MBK = window.MBK || {};
  const A = MBK.animal = MBK.animal || {};

  function readQS(){
    const p = new URLSearchParams(location.search);
    let id = p.get('animalId') || p.get('id') || '';
    let number = p.get('number') || '';
    let species = (p.get('species') || '').toLowerCase();
    let farmId = p.get('farm') || p.get('farmId') || '';

    if (/buff|جاموس/.test(species)) species = 'buffalo';
    else if (/cow|بقر/.test(species)) species = 'cow';
    else species = '';

    return { id, number, species, farmId };
  }

  function setCurrent(info={}){
    if (info.id)     localStorage.setItem('currentAnimalId', String(info.id));
    if (info.number) localStorage.setItem('currentAnimalNumber', String(info.number || info.id));
    if (info.species){
      const s = (info.species === 'cow') ? 'cow' : 'buffalo';
      localStorage.setItem('currentAnimalSpecies', s);
      localStorage.setItem('herdProfile', s);
    }
    if (info.farmId) localStorage.setItem('farmId', info.farmId);
  }

  function getCurrent(){
    const qs = readQS();
    const id = qs.id || localStorage.getItem('currentAnimalId') || '';
    const number = qs.number || localStorage.getItem('currentAnimalNumber') || id;
    const species = qs.species || localStorage.getItem('currentAnimalSpecies')
      || ((localStorage.getItem('herdProfile') === 'cow') ? 'cow' : 'buffalo');
    const farmId = qs.farmId || localStorage.getItem('farmId') || 'DEFAULT';
    return { id: String(id), number: String(number), species, farmId };
  }

  function ensureFromQS(){
    const qs = readQS();
    if (qs.id || qs.number || qs.species || qs.farmId) setCurrent(qs);
    return getCurrent();
  }

  function withAnimalQS(url, info){
    try{
      const u = new URL(url, location.origin);
      if (info.id)     u.searchParams.set('animalId', info.id);
      if (info.number) u.searchParams.set('number', info.number);
      return u.pathname + u.search;
    }catch{
      const qs = [];
      if (info.id)     qs.push('animalId='+encodeURIComponent(info.id));
      if (info.number) qs.push('number='+encodeURIComponent(info.number));
      return url + (url.includes('?') ? '&' : '?') + qs.join('&');
    }
  }

  function enhanceAnimalList(opts={}){
    const hostSel  = opts.selector || '.animal-row, .animal-card, [data-animal-id]';
    const linksSel = opts.linksSelector
      || 'a[href*="cow-card.html"], a[href*="add-event.html"], a[href*="visual-eval.html"]';

    document.addEventListener('click', (e)=>{
      const a = e.target.closest(linksSel);
      if (!a) return;

      const host = a.closest(hostSel) || a;
      const info = {};

      // من data-attributes أولاً
      const d = host.dataset || {};
      info.id     = d.animalId || d.id || d.number || '';
      info.number = d.animalNumber || d.number || '';
      const spTxt = d.species || d.type || (host.querySelector?.('.animal-species')?.textContent||'');
      if (spTxt){
        info.species = /buff|جاموس/i.test(spTxt) ? 'buffalo'
                    : /cow|بقر/i.test(spTxt)     ? 'cow' : '';
      }
      if (d.farmId) info.farmId = d.farmId;

      // fallback من DOM
      if (!info.number){
        const n = (host.querySelector?.('.animal-number')?.textContent||'').trim();
        if (n) info.number = n;
      }
      if (!info.id) info.id = info.number;

      if (!info.id) return; // سيب الرابط من غير تعديل لو مفيش بيانات

      setCurrent(info);
      a.setAttribute('href', withAnimalQS(a.getAttribute('href'), { id: info.id, number: info.number }));
    }, true);
  }

  function populateForm(form=document){
    const cur = getCurrent();
    const ensure = (name, value)=>{
      let el = form.querySelector(`[name="${name}"]`);
      if (!el){
        el = document.createElement('input');
        el.type = 'hidden';
        el.name = name;
        form.appendChild(el);
      }
      el.value = value;
    };
    if (form.querySelector('[name="animalId"]')   || form.querySelector('[data-bind="animalId"]')) ensure('animalId', cur.id);
    if (form.querySelector('[name="number"]')     || form.querySelector('[data-bind="number"]'))   ensure('number', cur.number);
    if (form.querySelector('[name="species"]'))   ensure('species', cur.species);
    if (form.querySelector('[name="farmId"]'))    ensure('farmId', cur.farmId);
    return cur;
  }

  // API عام
  A.readQS = readQS;
  A.setCurrent = setCurrent;
  A.getCurrent = getCurrent;
  A.ensureFromQS = ensureFromQS;
  A.withAnimalQS = withAnimalQS;
  A.enhanceAnimalList = enhanceAnimalList;
  A.populateForm = populateForm;
})();
