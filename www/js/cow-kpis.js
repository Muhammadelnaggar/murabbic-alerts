// www/js/cow-kpis.js
(function () {
  // عناصر العرض الموجودة في cow-card.html (أضفناها في الخطوة السابقة)
  const elDim    = document.getElementById('kpi-dim');
  const elIns    = document.getElementById('kpi-last-ins');
  const elStatus = document.getElementById('kpi-status');

  // لو القسم مش موجود لسه، نخرج بهدوء
  if (!elDim || !elIns || !elStatus) return;

  const qs = new URLSearchParams(location.search);
  const qsAnimalId = qs.get('animalId') || '';
  const qsNumber   = qs.get('number')   || '';

  // ممكن يكون متخزن محليًا
  let animalId = qsAnimalId || localStorage.getItem('currentAnimalId') || '';

  function getApiBase() {
    const v = (localStorage.getItem('API_BASE') || '').trim();
    if (!/^https?:\/\//.test(v) || v.includes('localhost')) return '';
    return v;
  }
  const API_BASE = getApiBase();
  const corsOpt  = API_BASE ? { mode: 'cors' } : {};
  const dayMs = 86400000;
  const daysSince = (ts) => Math.max(0, Math.floor((Date.now() - Number(ts)) / dayMs));
  const fmtDate   = (ts) => (ts ? new Date(Number(ts)).toLocaleDateString('ar-EG') : '—');

  // لو مفيش animalId لكن فيه number، نحاول نجيبه من /api/animals
  async function resolveAnimalIdFromNumber(number) {
    try {
      const url = API_BASE ? `${API_BASE}/api/animals` : '/api/animals';
      const r = await fetch(url, corsOpt);
      const arr = await r.json();
      const hit = arr.find(
        a => String(a.number ?? a.id).trim() === String(number).trim()
      );
      if (hit) {
        const id = String(hit.id ?? hit.animalId ?? hit.number);
        localStorage.setItem('currentAnimalId', id);
        localStorage.setItem('currentAnimalNumber', String(hit.number ?? hit.id));
        return id;
      }
    } catch (e) {
      console.warn('resolveAnimalIdFromNumber failed', e);
    }
    return '';
  }

  async function init() {
    try {
      if (!animalId && qsNumber) {
        animalId = await resolveAnimalIdFromNumber(qsNumber);
      }
      if (!animalId) {
        console.warn('Cow KPIs: لا يوجد animalId يمكن استخدامه.');
        return;
      }

      const url = (API_BASE ? `${API_BASE}/api/animal-timeline` : '/api/animal-timeline')
                + `?animalId=${encodeURIComponent(animalId)}&limit=200`;

      const j = await fetch(url, corsOpt).then(r => r.json());
      const items = Array.isArray(j?.items) ? j.items : [];

      // الأحدث أولًا حسب الخادم، نسهّل البحث
      const findFirst = (pred) => items.find(pred);

      const reBirth = /(birth|ولادة)/i;
      const reIns   = /(insemination|تلقيح)/i;
      const rePreg  = /(pregnancy|حمل)/i;

      const lastBirth = findFirst(it => it.kind === 'event' && reBirth.test(String(it.title || '')));
      const lastIns   = findFirst(it => it.kind === 'event' && reIns.test(String(it.title  || '')));

      // حمل إيجابي: إمّا Alert code من الحساسات أو حدث فحص حمل إيجابي
      const lastPregAlert = findFirst(it => it.kind === 'alert' && String(it.code || '') === 'pregnancy_positive');
      const lastPregEvent = findFirst(
        it =>
          it.kind === 'event' &&
          rePreg.test(String(it.title || '')) &&
          /positive|ايجاب/i.test(String(it.summary || ''))
      );
      const lastPreg = lastPregAlert || lastPregEvent || null;

      // DIM
      elDim.textContent = lastBirth ? `${daysSince(lastBirth.ts)} يوم` : '—';

      // آخر تلقيح
      elIns.textContent = lastIns ? fmtDate(lastIns.ts) : '—';

      // الحالة
      let statusTxt = 'مفتوحة';
      if (lastPreg && (!lastBirth || lastPreg.ts > lastBirth.ts)) {
        statusTxt = 'حامل';
      } else if (lastBirth && daysSince(lastBirth.ts) <= 7) {
        statusTxt = 'حديثة الولادة';
      }
      elStatus.textContent = statusTxt;

      console.info('Cow KPIs ✓', { animalId, lastBirth, lastIns, lastPreg });
    } catch (e) {
      console.error('Cow KPIs error:', e);
    }
  }

  init();
})();
