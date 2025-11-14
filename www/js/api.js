// ===========================================
// js/api.js  — Murabbik Unified Client Layer
// ===========================================

console.log("✅ api.js loaded");

// ------------------------------------------------------
// 🔗 1) تحديد عنوان الـ API (من tenant-bootstrap أو افتراضي)
// ------------------------------------------------------
window.API_BASE =
  window.API_BASE ||
  (window.__TENANT__ && window.__TENANT__.API_BASE) ||
  "https://murabbic-alerts.onrender.com";

// ------------------------------------------------------
// 🔐 2) الحصول على userId من أي مصدر متاح
// ------------------------------------------------------
function getUserId() {
  return (
    window.userId ||
    (window.__TENANT__ && window.__TENANT__.userId) ||
    localStorage.getItem("userId") ||
    sessionStorage.getItem("userId") ||
    null
  );
}

// ------------------------------------------------------
// 🧩 3) GET موحد للبيانات من أي endpoint
// ------------------------------------------------------
export async function apiGet(path) {
  const uid = getUserId();
  if (!uid) {
    console.warn("⚠️ لا يوجد userId — لن يتم تنفيذ apiGet");
    return { ok: false, error: "no_user" };
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        "X-User-Id": uid,
        "Cache-Control": "no-store"
      },
      cache: "no-store"
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("❌ apiGet error:", err);
    return { ok: false, error: "network_error" };
  }
}

// ------------------------------------------------------
// 🧩 4) POST موحد لحفظ الأحداث / البيانات
// ------------------------------------------------------
export async function apiPost(path, data) {
  const uid = getUserId();
  if (!uid) {
    console.warn("⚠️ لا يوجد userId — لن يتم تنفيذ apiPost");
    return { ok: false, error: "no_user" };
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "X-User-Id": uid,
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify(data)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("❌ apiPost error:", err);
    return { ok: false, error: "network_error" };
  }
}

// ------------------------------------------------------
// 🧩 5) دالة مخصصة لحفظ أحداث القطيع
// ------------------------------------------------------
export async function apiSaveEvent(evt) {
  if (!evt) return { ok: false, error: "no_event" };
  return apiPost("/api/events", evt);
}

// ------------------------------------------------------
// 🧩 6) دالة مساعدة سريعة لطباعة الهوية
// ------------------------------------------------------
export function apiWhoAmI() {
  console.log("👤 userId =", getUserId(), " | API =", window.API_BASE);
}
