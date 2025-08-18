// www/js/cow-kpis.js
(function () {
  // 1) تحديد animalId من الـQS أو الـlocalStorage
  const qs = new URLSearchParams(location.search);
  const animalId =
    qs.get('animalId') ||
    localStorage.getItem('currentAnimalId') ||
    localStorage.getItem('lastAnimalId') ||
    '';

  if (!animalId) {
    console.warn('Cow KPIs: لا يوجد animalId في الرابط أو التخزين المحلي.');
    return;
  }

  // 2) عناصر العرض
  const elDim    = document.getElementById('kpi-dim');
  const elIns    = document.getElementById('kpi-last-ins');
  const elStatus = document.getElementById('kpi-status');

  // 3) تهيئة مسار API (محلي/خارجي)
  function getApiBase() {
    const v = (localStorage.getItem('API_BASE') || '').trim();
    if (!/^https?:\/\//.test(v) || v.includes('localhost')) return '';
    return v;
  }
  const API_BASE = getApiBase();
  const url =
    (API_BASE ? `${API_BASE}/api/animal-timeline` : '/api/animal-timeline') +
    `?animalId=${encodeURIComponent(animalId)}&limit=200`;
  const fetchOpts = API_BASE ? { mode: 'cors' } : {};

  // 4) Utilities
  const dayMs = 86400000;
  const daysSince = (ts) => Math.max(0, Math.floor((Date.now() - Number(ts)) / dayMs));
  const fmtDate = (ts) =>
    ts ? new Date(Number(ts)).toLocaleDateString('ar-EG') : '—';

  // 5) قراءة التايملاين وحساب KPIs
  fetch(url, fetchOpts)
    .then((r) => r.json())
    .then((j) => {
      const items = Array.isArray(j?.items) ? j.items : [];

      // الخادم يرجع العناصر بالترتيب تنازليًا (الأحدث أولًا)
      const findFirst = (pred) => items.find(pred);

      const reBirth = /(birth|ولادة)/i;
      const reIns   = /(insemination|تلقيح)/i;
      const rePreg  = /(pregnancy|حمل)/i;

      const lastBirth = findFirst((it) => it.kind === 'event' && reBirth.test(String(it.title || '')));
      const lastIns   = findFirst((it) => it.kind === 'event' && reIns.test(String(it.title || '')));

      // حمل إيجابي: إمّا Alert code من الحساسات أو حدث فحص حمل إيجابي في التطبيق
      const lastPregAlert = findFirst((it) => it.kind === 'alert' && String(it.code || '') === 'pregnancy_positive');
      const lastPregEvent = findFirst(
        (it) =>
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
    })
    .catch((e) => {
      console.error('Cow KPIs error:', e);
    });
})();
