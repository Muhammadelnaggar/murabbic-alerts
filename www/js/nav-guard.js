// /js/nav-guard.js — Murabbik Navigation + Auth Hardening (ESM)
// الهدف: جعل مُرَبِّيك "قائم بذاته" (Standalone) ومنع الرجوع لصفحات الدخول بعد التسجيل/الخروج
// ✅ protectPage(): يحمي الصفحات الداخلية ويحوّل غير المُسجّل إلى login.html باستخدام location.replace
// ✅ lockBackButton(): (اختياري) يقفل زر الرجوع داخل التطبيق (PWA/Standalone)
// ✅ safeReplace(): helper
// ملاحظة: هذا الملف لا يغيّر أي تصميم — منطق فقط.

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/** True إذا الصفحة الحالية هي صفحة دخول/تسجيل */
export function isAuthPage() {
  const p = (location.pathname || "").toLowerCase();
  return p.endsWith("/login.html") || p.endsWith("/register.html");
}

/** تحويل آمن */
export function safeReplace(url) {
  try {
    location.replace(url);
  } catch (e) {
    location.href = url;
  }
}

/**
 * حماية الصفحة الداخلية:
 * - لو الصفحة auth => لا تفعل شيئًا
 * - لو لا يوجد Firebase Auth session => تحويل لـ login.html (replace)
 *
 * options:
 *  - loginUrl: default "login.html"
 *  - rememberRedirect: default true (يحفظ الصفحة المطلوبة ليعود لها بعد الدخول لاحقًا)
 */
export function protectPage(options = {}) {
  const {
    loginUrl = "login.html",
    rememberRedirect = true,
  } = options;

  // لا نحمي صفحات auth
  if (isAuthPage()) return;

  // حفظ الهدف (اختياري)
  if (rememberRedirect) {
    try {
      const target = location.pathname + location.search + location.hash;
      localStorage.setItem("mbk_redirect_after_login", target);
    } catch {}
  }

  const auth = getAuth();

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      safeReplace(loginUrl);
    }
  });
}

/**
 * قفل زر الرجوع داخل التطبيق (اختياري):
 * - مناسب للتطبيق Standalone/PWA
 * - قد يكون مزعجًا لو فعلته في كل الصفحات
 */
export function lockBackButton() {
  try {
    history.pushState({ mbkLock: true }, "", location.href);
    window.addEventListener("popstate", () => {
      try {
        history.pushState({ mbkLock: true }, "", location.href);
      } catch {}
    });
  } catch {}
}

/**
 * استرجاع redirect المحفوظ بعد الدخول (اختياري)
 */
export function consumeRedirectAfterLogin() {
  try {
    const t = localStorage.getItem("mbk_redirect_after_login");
    if (t) localStorage.removeItem("mbk_redirect_after_login");
    return t || null;
  } catch {
    return null;
  }
}
