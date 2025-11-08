// ===============================
// js/api.js  (Murabbik Web Client)
// ===============================
console.log("✅ api.js loaded");

// 🔗 اضبط عنوان الـ API الأساسي
window.API_BASE = window.API_BASE || "https://murabbic-alerts.onrender.com";

// 🧩 دالة GET جاهزة للاستخدام عبر كل الصفحات
export async function apiGet(path) {
  const uid =
    window.userId ||
    (window.__TENANT__ && window.__TENANT__.userId) ||  // 👈 هنا الجديد
    localStorage.getItem("userId") ||
    sessionStorage.getItem("userId");

  if (!uid) {
    console.warn("⚠️ لا يوجد userId ! لن يتم جلب البيانات.");
    return {};
  }

  try {
    const r = await fetch(`${API_BASE}${path}`, {
      headers: { "X-User-Id": uid },
      cache: "no-store"
    });
    if (!r.ok) throw new Error(`API Error: ${r.status}`);
    return await r.json();
  } catch (err) {
    console.error("❌ خطأ في الاتصال بالـ API:", err);
    return {};
  }
}

// ✅ جاهز
