// /js/nav-guard.js — Murabbik Navigation System (ESM)
// ✅ protectPage(): يطرد غير المسجل إلى login.html (replace)
// ✅ lockBackButton(): يعطّل زر الرجوع في dashboard فقط (اختيار B)
// ✅ bindLogout(): يفعّل زر logoutBtn (خروج نهائي)

function safeReplace(url){
  try{ location.replace(url); }catch(e){ location.href = url; }
}

function pageName(){
  const p = (location.pathname || "").toLowerCase();
  return (p.split("/").pop() || "");
}

export function lockBackButton(){
  // ✅ تعطيل الرجوع في الداش فقط
  if (pageName() !== "dashboard.html") return;

  const lock = () => {
    try{
      history.pushState({mbk:"dash_lock_1"}, "", location.href);
      history.pushState({mbk:"dash_lock_2"}, "", location.href);
    }catch(e){}
  };

  lock();

  window.addEventListener("popstate", () => lock());
  window.addEventListener("pageshow", () => lock());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) lock();
  });
}

export async function protectPage(){
  // لا تحمي صفحات الدخول
  const pg = pageName();
  if (pg === "login.html" || pg === "register.html") return;

  try{
    const { getAuth, onAuthStateChanged } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");

    const auth = getAuth();
   onAuthStateChanged(auth, (user) => {
  if (!user) {
    // منع الرجوع للداش من اللوجين
    try{ sessionStorage.setItem("mbkLoggedOut","1"); }catch(e){}
    safeReplace("login.html");
  }
});

  }catch(e){
    // لو حصل فشل تحميل auth لا نكسر الصفحة
    // (لكن غالبًا عندك Firebase شغال)
  }
}

export function bindLogout(){
  const run = async () => {
    const btn = document.getElementById("logoutBtn");
    if (!btn) return;

    btn.addEventListener("click", async () => {
      try{
        const { getAuth, signOut } =
          await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
        await signOut(getAuth());
      }catch(e){}

      try{ localStorage.clear(); }catch(e){}
      try{ sessionStorage.clear(); }catch(e){}

      safeReplace("login.html"); // ✅ خروج نهائي
    });
  };

  if (document.readyState === "loading"){
    window.addEventListener("DOMContentLoaded", run, { once:true });
  } else {
    run();
  }
}
