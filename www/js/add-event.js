// /js/add-event.js
(() => {
  'use strict';

  // ======== أدوات عامة ========
  const $ = (sel, ctx=document) => ctx.querySelector(sel);
  const on = (el, ev, fn, opts) => el.addEventListener(ev, fn, opts);

  // شريط خطأ عام (يظهر أي JS error/unhandledrejection)
  const errbar = $('#errbar');
  function showErrorBar(msg){
    if(!errbar) return;
    errbar.textContent = String(msg || 'خطأ غير معروف');
    errbar.style.display = 'block';
  }
  window.addEventListener('error', e => showErrorBar(e.message || e.error));
  window.addEventListener('unhandledrejection', e => showErrorBar(e.reason?.message || e.reason));

  // شريط نجاح بعد الحفظ
  const okbar = $('#okbar');
  const okmsg = okbar?.querySelector('.msg');
  const okactions = okbar?.querySelector('.actions');
  function showOKBar(message, actions = []){
    if(!okbar) return;
    okmsg.textContent = message;
    okactions.innerHTML = '';
    actions.forEach(a => {
      const b = document.createElement('button');
      b.textContent = a.label;
      if(a.variant === 'secondary') b.classList.add('secondary');
      b.onclick = a.onClick;
      okactions.appendChild(b);
    });
    okbar.style.display = 'block';
    // إخفاء تلقائي بعد 6 ثواني (مع بقاء الأزرار)
    setTimeout(() => { okbar.style.display = 'none'; }, 6000);
  }

  // ======== سياق الصفحة: animalId/number/date ========
  function getQuery(){
    const p = new URLSearchParams(location.search);
    const obj = {};
    for (const [k,v] of p.entries()) obj[k]=v;
    return obj;
  }

  function getContext(){
    const q = getQuery();
    // مفاتيح شائعة كما اتفقنا
    const number = q.number || q.animalNumber || localStorage.getItem('currentAnimalNumber') || localStorage.getItem('lastAnimalNumber') || '';
    const animalId = q.animalId || localStorage.getItem('currentAnimalId') || localStorage.getItem('lastAnimalId') || '';
    const date = q.date || q.eventDate || localStorage.getItem('lastEventDate') || new Date().toISOString().slice(0,10);

    // حفظ للسريان بين الصفحات
    if(number) localStorage.setItem('currentAnimalNumber', number);
    if(animalId) localStorage.setItem('currentAnimalId', animalId);
    if(date) localStorage.setItem('lastEventDate', date);

    return { number, animalId, date };
  }

  const ctx = getContext();
  // تتبع بسيط
  try { window.dataLayer.push({event:'page_view', page:'/add-event', ctx}); } catch(e){}

  // يبني رابط الصفحة الابن مع تمرير number/date (وأي مفاتيح موجودة)
  function buildTargetUrl(page){
    const p = new URLSearchParams();
    if (ctx.animalId) p.set('animalId', ctx.animalId);
    if (ctx.number) p.set('number', ctx.number);
    if (ctx.date) p.set('date', ctx.date);
    // دعم مفاتيح إضافية إن وُجدت في الـ URL الحالي
    const curr = getQuery();
    ['demo','farmId','tenantId','userId','eventDate'].forEach(k=>{
      if (curr[k] && !p.has(k)) p.set(k, curr[k]);
    });
    return `${page}?${p.toString()}`;
  }

  // ======== حفظ "تقليم الحوافر" مباشرة في Firestore ========
  async function saveTrimming(){
    // تحميل Firebase ديناميكيًا فقط عند الحاجة (لتجنب أي Auth redirect)
    // يفترض وجود /js/firebase-config.js الذي يصدّر app جاهز أو config
    try {
      const [{ initializeApp, getApps }, { getFirestore, addDoc, collection, serverTimestamp }] =
        await Promise.all([
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
        ]);

      // استيراد إعداداتك (لا أسرار هنا—الملف عندك بالفعل)
      const { default: fb } = await import('/js/firebase-config.js'); // يصدّر {config} أو app
      let app;
      if (typeof fb?.name === 'string' || (getApps && getApps().length)) {
        // app موجود مسبقًا
        app = (getApps().length ? getApps()[0] : fb);
      } else {
        app = initializeApp(fb?.config || fb);
      }
      const db = getFirestore(app);

      const userId = localStorage.getItem('userId') || localStorage.getItem('tenantId') || 'demo-user';
      const payload = {
        userId,
        animalId: ctx.animalId || null,
        animalNumber: ctx.number || null,
        eventDate: ctx.date,
        type: 'تقليم الحوافر',
        source: location.pathname,
        createdAt: serverTimestamp()
      };

      await addDoc(collection(db, 'events'), payload);

      try { window.dataLayer.push({event:'trim_save', payload}); } catch(e){}

      showOKBar('✅ تم حفظ تقليم الحوافر فورًا.', [
        { label:'متابعة تسجيل أحداث أخرى', onClick: ()=>{ /* إبقاء المستخدم */ } },
        { label:'الرجوع للوحة التحكم', variant:'secondary', onClick: ()=>{ location.href='/dashboard.html'; } }
      ]);

    } catch (err) {
      showErrorBar('تعذّر حفظ تقليم الحوافر: ' + (err?.message || err));
    }
  }

  // ======== تفويض النقر على كل أزرار الصفحة مرة واحدة ========
  // لا نربط handlers متعددة — تفويض على document
  on(document, 'click', (ev) => {
    const btn = ev.target.closest('.evt-btn');
    if (!btn) return;

    // منع الضغط المزدوج السريع على الموبايل
    btn.disabled = true;
    setTimeout(()=>{ btn.disabled = false; }, 600);

    const action = btn.dataset.action || '';
    const page = btn.dataset.page || '';

    // استثناء: تقليم الحوافر → حفظ فوري
    if (action === 'trimming') {
      ev.preventDefault();
      saveTrimming();
      return;
    }

    // بقية الأزرار: انتقال مع تمرير number/date (وأي مفاتيح متاحة)
    if (page) {
      ev.preventDefault();
      const url = buildTargetUrl(page);
      try { window.dataLayer.push({event:'event_nav', to:page, url}); } catch(e){}
      location.href = url;
    }
  }, { passive:true });

})();
