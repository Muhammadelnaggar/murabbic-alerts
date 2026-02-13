// /js/install-ui.js — Murabbik PWA Install Button (Android/Chrome)
// يظهر زر/Tile "تثبيت مُرَبِّيك" فقط عندما يصبح التثبيت متاحًا.
// لا يغيّر تصميم الصفحة؛ مجرد إظهار/إخفاء Tile داخل .tiles.
//
// متطلبات عمل زر التثبيت:
// 1) الموقع HTTPS
// 2) manifest.webmanifest صحيح + icons
// 3) Service Worker (يفضّل موجود) — عشان Chrome يعتبرها قابلة للتثبيت
//
// ملاحظة: على بعض المتصفحات لن يظهر beforeinstallprompt — ساعتها لن يظهر الزر.

(() => {
  'use strict';

  const tile = document.getElementById('mbkInstallTile');
  if (!tile) return;

  let deferredPrompt = null;

  function showTile(){
    try{ tile.style.display = ''; }catch{}
  }
  function hideTile(){
    try{ tile.style.display = 'none'; }catch{}
  }

  // Chrome/Android: يُطلق قبل تثبيت PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    // منع الشريط الافتراضي (mini-infobar)
    e.preventDefault();
    deferredPrompt = e;
    showTile();
  });

  // بعد التثبيت
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideTile();
    try{
      // تتبع بسيط لو عندك dataLayer/t.event
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event:'pwa_installed', page: location.pathname });
      if (window.t?.event) window.t.event('pwa_installed', { page: location.pathname });
    }catch{}
  });

  async function doInstall(){
    if (!deferredPrompt){
      // fallback: لو مفيش prompt، غالبًا المستخدم على متصفح لا يدعم أو already installed
      alert('لو زر التثبيت مش ظاهر في المتصفح: افتح مُرَبِّيك من Google Chrome ثم اضغط ⋮ > Install app.');
      return;
    }

    try{
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      // accepted / dismissed
      deferredPrompt = null;
      hideTile();

      try{
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event:'pwa_install_choice', outcome: choice?.outcome || 'unknown', page: location.pathname });
        if (window.t?.event) window.t.event('pwa_install_choice', { outcome: choice?.outcome || 'unknown', page: location.pathname });
      }catch{}
    }catch(e){
      // في حالة فشل غير متوقع
      alert('تعذّر فتح نافذة التثبيت. افتح القائمة ⋮ ثم Install app.');
    }
  }

  // Click + keyboard
  tile.addEventListener('click', doInstall);
  tile.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      doInstall();
    }
  });

  // لو التطبيق standalone بالفعل: اخفي زر التثبيت
  const isStandalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator.standalone === true);

  if (isStandalone) hideTile();

})();
