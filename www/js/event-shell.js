// /js/event-shell.js — Murabbik Event Shell (v1)
// هدفه: توحيد (Header + Sysbar + Prefill + Scroll + Tracking) لكل صفحات الأحداث
// ملاحظة: لا يفرض شكل جديد — لو الصفحة فيها هيدر/sysbar موجودين سيستخدمهم كما هم.

function _toISODate(s){
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d)) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,10);
}

function _normDigitsOnly(s){
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
               '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  return String(s || "")
    .split("")
    .map(ch => (map[ch] ?? ch))
    .join("")
    .replace(/[^\d]/g, "");
}

function _qs(){
  return new URLSearchParams(location.search);
}

function _getEl(id){
  return document.getElementById(id);
}

function _ensureDataLayer(){
  window.dataLayer = window.dataLayer || [];
  // واجهة t.event لو مش موجودة
  if (!window.t || typeof window.t.event !== "function"){
    window.t = { event: (name, data={}) => window.dataLayer.push({ event: name, ...data }) };
  }
}

function _findOrCreateSysbar(){
  // الأفضل: sysbar الموجود
  let bar = document.getElementById("sysbar");

  // بديل: أي infobar في الصفحة
  if (!bar) bar = document.querySelector(".infobar");

  // لو مفيش خالص: ننشئ واحد تحت الهيدر مباشرة
  if (!bar){
    bar = document.createElement("div");
    bar.id = "sysbar";
    bar.className = "infobar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");

    const header = document.querySelector("header");
    if (header && header.parentNode){
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else {
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  return bar;
}

function _scrollToSysbar(sysbar){
  try{ sysbar?.scrollIntoView({ behavior: "smooth", block: "start" }); }catch(_){}
}

function _setSysbarClass(sysbar, kind){
  // kind: "info" | "success" | "error"
  sysbar.classList.remove("info", "success", "error", "show");
  if (kind) sysbar.classList.add(kind);
  sysbar.classList.add("show");
  sysbar.style.display = "block";
}

function _renderActions(sysbar, actions){
  if (!Array.isArray(actions) || !actions.length) return;
  const wrap = document.createElement("div");
  wrap.className = "sys-actions";

  actions.forEach((a)=>{
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sys-btn" + (a.primary ? " primary" : "");
    btn.textContent = a.label || "إجراء";
    btn.addEventListener("click", ()=>{ try{ a.onClick && a.onClick(); }catch(_){ } });
    wrap.appendChild(btn);
  });

  sysbar.appendChild(wrap);
}

/**
 * initEventShell(options)
 * options:
 *  - pageId: "calving" | "abortion" | ...
 *  - title: عنوان الصفحة (للتتبع فقط)
 *  - logoSrc: "/images/logo.png" (اختياري)
 *  - backHref: "add-event.html" (اختياري)
 *  - prefill: { numberId:"animalNumber", dateId:"eventDate" } (اختياري)
 */
export function initEventShell(options = {}){
  const {
    pageId = document.documentElement?.dataset?.page || "",
    title  = document.title || "",
    logoSrc = "/images/logo.png",
    backHref = "add-event.html",
    prefill = { numberId: "animalNumber", dateId: "eventDate" },
  } = options;

  _ensureDataLayer();

  // 1) sysbar موحد
  const sysbar = _findOrCreateSysbar();

  // 2) زر الرجوع (لو موجود في الصفحة)
  const back = document.querySelector(".mbk-back");
  if (back && backHref) back.setAttribute("href", backHref);

  // 3) اللوجو (لو موجود في الصفحة)
  const logo = document.querySelector(".mbk-logo");
  if (logo && logoSrc) logo.setAttribute("src", logoSrc);

  // 4) API عامة للرسائل — بدل تكرار showSysbar في كل صفحة
  const api = {
    sysbar,
    show(msg, { kind="info", actions=[] } = {}){
      const safe = String(msg || "").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      _setSysbarClass(sysbar, kind);
      sysbar.innerHTML = `<div class="sys-msg">${safe}</div>`;
      _renderActions(sysbar, actions);
      _scrollToSysbar(sysbar);
    },
    info(msg, opts={}){ api.show(msg, { ...opts, kind:"info" }); },
    success(msg, opts={}){ api.show(msg, { ...opts, kind:"success" }); },
    error(msg, opts={}){ api.show(msg, { ...opts, kind:"error" }); },
    scroll(){ _scrollToSysbar(sysbar); }
  };

  // نعلّقها عالميًا عشان الصفحات تستخدمها فورًا لو أحبّينا
  window.mbkShell = api;

  // 5) Prefill مركزي (number/date) — بدون لمس منطق الصفحة لو موجود
  try{
    const qs = _qs();
    const n = qs.get("number") || qs.get("animalNumber") || qs.get("animal") || "";
    const d = qs.get("date") || qs.get("dt") || qs.get("eventDate") || qs.get("Date") || "";

    const nEl = prefill?.numberId ? _getEl(prefill.numberId) : null;
    const dEl = prefill?.dateId ? _getEl(prefill.dateId) : null;

    if (n && nEl && !String(nEl.value || "").trim()){
      nEl.value = _normDigitsOnly(n);
      nEl.dispatchEvent(new Event("input", { bubbles:true }));
      nEl.dispatchEvent(new Event("change", { bubbles:true }));
    }

    if (d && dEl && !String(dEl.value || "").trim()){
      dEl.value = _toISODate(d);
      dEl.dispatchEvent(new Event("input", { bubbles:true }));
      dEl.dispatchEvent(new Event("change", { bubbles:true }));
    }
  }catch(_){}

  // 6) تتبع موحد
  try{
    window.t?.event?.("page_view", {
      page: pageId || location.pathname,
      title: title || document.title,
      path: location.pathname
    });
  }catch(_){}

  return api;
}
