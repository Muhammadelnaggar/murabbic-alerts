// sw.js — Murabbik Minimal Service Worker (v1)
// الهدف: تفعيل وضع التثبيت (PWA) + فتح التطبيق بدون شريط عناوين عند التثبيت.
// ملاحظة: هذا SW خفيف ولا يغيّر تصميم الموقع.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-first (بدون كاش معقّد الآن)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
