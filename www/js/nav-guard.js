// /js/nav-guard.js — مُرَبِّيك | Standalone Navigation Guard (ESM)
// BUILD_ID: nav-2026-02-17-C
// الهدف: تطبيق مُرَبِّيك كـ Standalone:
// 1) حماية الصفحات الداخلية: لو المستخدم غير مسجل -> login.html (location.replace)
// 2) منع الرجوع (Back) داخل التطبيق قدر الإمكان (PWA/Standalone)
// ملاحظة: لا يمكن منع زر الرجوع 100% على كل الأجهزة، لكن هذا يمنع الرجوع داخل صفحات مُرَبِّيك.
// =====================================================================

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ✅ علامة للتأكد أنه اتحمّل
try { window.__MBK_NAV_GUARD__ = "loaded"; } catch {}

export function isAuthPage() {
  const p = (location.pathname || "").toLowerCase();
  return p.endsWith("/login.html") || p.endsWith("/register.html");
}

export function safeReplace(url) {
  try { location.replace(url); } catch { location.href = url; }
}

/**
 * protectPage({ loginUrl="login.html", rememberRedirect=true })
 */
export function protectPage(options = {}) {
  const { loginUrl = "login.html", rememberRedirect = true } = options;

  if (isAuthPage()) return;

  if (rememberRedirect) {
    try {
      const target = location.pathname + location.search + location.hash;
      localStorage.setItem("mbk_redirect_after_login", target);
    } catch {}
  }

  const auth = getAuth();
  onAuthStateChanged(auth, (user) => {
    if (!user) safeReplace(loginUrl);
  });
}

/**
 * هل التطبيق مفتوح كـ Standalone بالفعل؟
 * - Android/Chrome: display-mode: standalone
 * - iOS (Safari): navigator.standalone
 */
export function isStandalone() {
  try {
    const mq = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    const ios = !!navigator.standalone;
    return !!(mq || ios);
  } catch {
    return false;
  }
}

/**
 * lockBackButton({ onlyStandalone=true })
 * - onlyStandalone: افتراضي true (يقفل الرجوع فقط عند التشغيل Standalone)
 * - لو عايز تقفله حتى داخل المتصفح للاختبار: onlyStandalone:false
 */
export function lockBackButton(opts = {}) {
  const { onlyStandalone = true } = opts;

  // ✅ لو مطلوب Standalone فقط، وتطبيقك مش Standalone الآن، نخرج بدون قفل
  if (onlyStandalone && !isStandalone()) return;

  const arm = () => {
    try {
      // ندخل حالتين متتاليتين عشان أول Back مايمشيش خطوة حقيقية
      history.pushState({ mbkLock: 1 }, "", location.href);
      history.pushState({ mbkLock: 2 }, "", location.href);
    } catch {}
  };

  // Arm الآن + عند الرجوع من BFCache
  arm();
  window.addEventListener("pageshow", arm);

  // على popstate: نعيد إدخال الحالة فورًا
  window.addEventListener("popstate", () => {
    try { history.pushState({ mbkLock: 2 }, "", location.href); } catch {}
  });
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
