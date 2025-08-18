// www/js/cow-kpis.js
(function () {
  const elDim    = document.getElementById('kpi-dim');
  const elIns    = document.getElementById('kpi-last-ins');
  const elStatus = document.getElementById('kpi-status');
  if (!elDim || !elIns || !elStatus) return;

  const qs = new URLSearchParams(location.search);

  // 1) استخراج معرف/رقم الحيوان من أكثر من مصدر
  const qsAnimalId = qs.get('animalId') || qs.get('id') || '';
  const qsNumber   = qs.get('number')   || '';

  // رقم من العنوان "بطاقة البقرة رقم (2)"
  function readNumberFromHeader() {
    try {
      const h = document.querySelector('h1, header h1, .title');
      if (!h) return '';
      const m = (h.textContent || '').match(/\((\d+)\)/);
      return m ? m[1] : '';
    } catch { return ''; }
  }

  // اعتبر القيمة رقم لو كلّها أرقام وطولها قصير
  const isShortNumeric = (v) => /^\d+$/.test(v) && v.length <= 6;

  // API BASE (لو أنت مش مفعّل متغيّر API_BASE هيفضل فاضي ويستخدم نفس الدومين)
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

  async function fetchJSON(url) {
    const r = await fetch(url, corsOpt);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function resolveAnimalId({ qsAnimalId, qsNumber }) {
    // أولوية: animalId صريح
    if (qsAnimalId) return String(qsAnimalId);

    // لو number موجود:
    if (qsNumber) {
      // لو قصير ورقمي → اعتبره رقم حيوان (نحوّل لـ id من /api/animals)
      if (isShortNumeric(qsNumber)) {
        const url = API_BASE ? `${API_BASE}/api/animals` : '/api/animals';
        const arr = await fetchJSON(url);
        const hit = arr.find(a => String(a.number ?? a.id) === String(qsNumber));
        if (hit) {
          const id = String(hit.id ?? hit.animalId ?? hit.number);
          localStorage.setItem('currentAnimalId', id);
          localStorage.setItem('currentAnimalNumber', String(hit.number ?? hit.id));
          return id;
        }
        return ''; // لم نجد
      }
      // لو طويل/غير رقمي → اعتبره animalId مباشرة
      return String(qsNumber);
    }

    // بديل: من LocalStorage
    const lsId = localStorage.getItem('currentAnimalId');
    if (lsId) return String(lsId);

    // بديل أخير: اقرأ الرقم من العنوان وحوّله عبر /api/animals
    const hdrNum = readNumberFromHeader();
    if (isShortNumeric(hdrNum)) {
      const url = API_BASE ? `${API_BASE}/api/animals` : '/api/animals';
      const arr = await fetchJSON(url);
      const hit = arr.find(a => String(a.number ?? a.id) === String(hdrNum));
      if (hit) {
        const id = String(hit.id ?? hit.animalId ?? hit.number);
        localStorage.setItem('currentAnimalId', id);
        localStorage.setItem('currentAnimalNumber', String(hit.number ?? hit.id));
        return id;
      }
    }

    return '';
  }

  async function init() {
    try {
      let animalId = await resolveAnimalId({ qsAnimalId, qsNumber });

      if (!animalId) {
        console.warn('Cow KPIs: لا يوجد animalId مناسب (تحقّق من معلمات الرابط أو قائمة الحيوانات).');
        return;
      }

      const turl = (API_BASE ? `${API_BASE}/api/animal-timeline` : '/api/animal-timeline')
                 + `?animalId=${encodeURIComponent(animalId)}&limit=200`;
      const j = await fetchJSON(turl);
      const items = Array.isArray(j?.items) ? j.items : [];

      const findFirst = (pred) => items.find(pred);
      const reBirth = /(birth|ولادة)/i;
      const reIns   = /(insemination|تلقيح)/i;
      const rePreg  = /(pregnancy|حمل)/i;

      const lastBirth = findFirst(it => it.kind === 'event' && reBirth.test(String(it.title || '')));
      const lastIns   = findFirst(it => it.kind === 'event' && reIns.test(String(it.title  || '')));
      const lastPregAlert = findFirst(it => it.kind === 'alert' && String(it.code || '') === 'pregnancy_positive');
      const lastPregEvent = findFirst(
        it => it.kind === 'event' && rePreg.test(String(it.title || '')) && /positive|ايجاب/i.test(String(it.summary || ''))
      );
      const lastPreg = lastPregAlert || lastPregEvent || null;

      // قيَم العرض
      elDim.textContent    = lastBirth ? `${daysSince(lastBirth.ts)} يوم` : '—';
      elIns.textContent    = lastIns   ? fmtDate(lastIns.ts) : '—';
      elStatus.textContent = (lastPreg && (!lastBirth || lastPreg.ts > lastBirth.ts))
                              ? 'حامل'
                              : (lastBirth && daysSince(lastBirth.ts) <= 7 ? 'ح
