// /js/forms-init.js — Murabbik Central Gate (ESM)
// ✅ بوابة قطيع مركزية: تمنع أي حفظ/تسجيل لحيوان غير موجود أو خارج القطيع
// ✅ UI مركزي (Infobar) يدعم Actions بدون أعطال DOM
// ✅ لا تُجمّد الصفحة: تترك إدخال رقم الحيوان متاح دائمًا وتمنع "الحفظ فقط"

import { db } from "./firebase-config.js";
import { uniqueAnimalNumber } from "./form-rules.js";
import {
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ----------------- Helpers ----------------- */
function qs(k){ return new URL(location.href).searchParams.get(k) || ""; }
function firstNonEmpty(...v){ return v.find(x => String(x||"").trim() !== "") || ""; }
function today(){ return new Date().toISOString().slice(0,10); }

function getUid(){
  return String(
    window.__tenant?.userId ||
    localStorage.getItem("userId") ||
    localStorage.getItem("tenantId") ||
    localStorage.getItem("ownerUid") ||
    ""
  ).trim();
}

function normDigits(s){
  const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
             '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  return String(s||"").trim()
    .replace(/[^\d٠-٩۰-۹]/g,'')
    .replace(/[٠-٩۰-۹]/g, d=>map[d]);
}

function getNumberFromCtx(){
  return normDigits(firstNonEmpty(
    qs("number"), qs("animalNumber"), qs("animalId"),
    localStorage.getItem("lastAnimalId"),
    localStorage.getItem("currentAnimalId"),
    localStorage.getItem("lastAnimalNumber")
  ));
}

function getDateFromCtx(){
  return String(firstNonEmpty(
    qs("date"), qs("eventDate"),
    localStorage.getItem("lastEventDate"),
    localStorage.getItem("eventDate"),
    today()
  )).trim();
}

function getNumberFromDom(){
  const el = document.querySelector(
    "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']"
  );
  return normDigits(el?.value || "");
}

function prefillCtx(){
  const n = getNumberFromCtx();
  const d = getDateFromCtx();

  const numEl = document.querySelector(
    "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']"
  );
  const dtEl  = document.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");

  if (numEl && !String(numEl.value||"").trim() && n) numEl.value = n;
  if (dtEl  && !String(dtEl.value||"").trim() && d) dtEl.value  = d;
}

function animalLabel(doc){
  const sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "").trim();
  if (/جاموس/i.test(sp) || sp === "جاموس") return "هذه الجاموسة";
  if (/بقر/i.test(sp)   || sp === "أبقار")  return "هذه البقرة";
  return "هذا الحيوان";
}

/* ----------------- UI: Infobar (Central, with actions) ----------------- */
function ensureBar(){
  // لو الصفحة عاملة Infobar متقدم (زي calving) استخدمه كما هو
  let bar = document.getElementById("info");

  // fallback: أنشئ Infobar موحد إن لم يوجد
  if (!bar){
    const host = document.querySelector(".infobar-wrap")
      || document.querySelector(".mbk-form")
      || document.querySelector("main")
      || document.body;

    bar = document.createElement("div");
    bar.id = "info";
    bar.className = "infobar";
    bar.style.cssText =
      "margin:8px 0;padding:10px 12px;border-radius:12px;font:14px/1.6 system-ui,'Cairo',Arial;" +
      "display:none;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-weight:800;";

    // بنية موحدة تدعم actions
    bar.innerHTML = `
      <div class="msg-row" style="display:flex;gap:10px;align-items:flex-start;justify-content:space-between">
        <div id="infoText" class="msg-text" style="flex:1;min-width:0;word-break:break-word"></div>
        <button id="infoClose" class="msg-close" type="button" aria-label="إغلاق"
          style="border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:inherit;
                 padding:2px 6px;border-radius:8px">×</button>
      </div>
      <div id="infoActions" class="msg-actions"
        style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap"></div>
    `;
    host.prepend(bar);
  }

  // تأكد من وجود العناصر الداخلية (حتى لو HTML قديم)
  if (!document.getElementById("infoText")){
    const t = document.createElement("div");
    t.id = "infoText";
    bar.appendChild(t);
  }
  if (!document.getElementById("infoActions")){
    const a = document.createElement("div");
    a.id = "infoActions";
    bar.appendChild(a);
  }
  if (!document.getElementById("infoClose")){
    const c = document.createElement("button");
    c.id = "infoClose";
    c.type = "button";
    c.textContent = "×";
    bar.appendChild(c);
  }

  // اربط زر الإغلاق مرة واحدة
  if (!bar.__closeBound){
    bar.__closeBound = true;
    document.getElementById("infoClose")?.addEventListener("click", ()=> mbkHideBar());
  }

  return bar;
}

function clearActions(){
  const box = document.getElementById("infoActions");
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
}

function mbkShowBar(msg, isError=false, actions=[]){
  const bar = ensureBar();
  const text = document.getElementById("infoText");
  const box  = document.getElementById("infoActions");

  bar.style.display = "block";
  bar.classList.toggle("show", true);
  bar.classList.toggle("error", !!isError);

  // ألوان fallback (لو forms.css مش مديها)
  bar.style.borderColor = isError ? "#fed7aa" : "#bbf7d0";
  bar.style.background  = isError ? "#fff7ed" : "#ecfdf5";
  bar.style.color       = isError ? "#9a3412" : "#065f46";

  if (text) text.textContent = String(msg || "");

  clearActions();

  if (box && Array.isArray(actions)){
    actions.forEach(a=>{
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a?.label || "زر";
      b.className = a?.className || "btn-ghost";
      // fallback style لو الصفحة مش فيها CSS للأزرار
      if (!b.className || b.className === "btn-ghost"){
        b.style.cssText = "border:1px solid #cbd5e1;background:#eef2f7;color:#0f172a;border-radius:12px;padding:10px 12px;font-weight:900;cursor:pointer;font-size:14px";
      }
      b.addEventListener("click", ()=>{ if (typeof a?.onClick === "function") a.onClick(); });
      box.appendChild(b);
    });
  }

  bar.scrollIntoView({behavior:"smooth", block:"nearest"});
}

function mbkHideBar(){
  const bar = ensureBar();
  bar.style.display = "none";
  clearActions();
  const text = document.getElementById("infoText");
  if (text) text.textContent = "";
}

// expose globally for any page (central UI)
window.mbkShowBar = mbkShowBar;
window.mbkHideBar = mbkHideBar;

/* ----------------- Gate Targets ----------------- */
const SAVE_SEL = "#saveBtn,.save,.btn-save,#bulkSaveBtn,[data-validate],button[type='submit'],input[type='submit']";
const TOOL_SEL = ".tool[data-page]";

function shouldGateThisPage(){
  return !!document.querySelector(SAVE_SEL + "," + TOOL_SEL);
}

function setSaveEnabled(on){
  document.querySelectorAll(SAVE_SEL).forEach(el=>{
    if (el?.dataset?.nav === "1") return;
    el.disabled = !on;
    if (el.id === "saveBtn" || el.classList.contains("btn-save") || el.hasAttribute("data-validate")) {
      el.style.opacity = on ? "" : "0.55";
    }
  });

  document.querySelectorAll(TOOL_SEL).forEach(el=>{
    if (el?.dataset?.nav === "1") return;
    el.style.pointerEvents = on ? "" : "none";
    el.style.opacity = on ? "" : "0.55";
  });

  window.__MBK_GATE_OK = !!on;
}

function installHardBlock(){
  if (window.__MBK_BLOCK_INSTALLED) return;
  window.__MBK_BLOCK_INSTALLED = true;

  document.addEventListener("click", (e)=>{
    if (window.__MBK_GATE_OK) return;
    const hit = e.target.closest(SAVE_SEL + "," + TOOL_SEL);
    if (!hit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    mbkShowBar(window.__MBK_GATE_MSG || "لا يمكن الحفظ.", true);
  }, true);

  document.addEventListener("submit", (e)=>{
    if (window.__MBK_GATE_OK) return;
    e.preventDefault(); e.stopImmediatePropagation();
    mbkShowBar(window.__MBK_GATE_MSG || "لا يمكن الحفظ.", true);
  }, true);
}

/* ----------------- Firestore: fetch animal doc ----------------- */
async function fetchAnimalDoc(uid, number){
  const key = `${uid}#${number}`;

  let qy = query(collection(db,"animals"), where("userId_number","==", key), limit(1));
  let snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  qy = query(collection(db,"animals"), where("userId","==", uid), where("number","==", String(number)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  qy = query(collection(db,"animals"), where("ownerUid","==", uid), where("number","==", String(number)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  return null;
}

/* ----------------- Status: treat any non-active as out of herd ----------------- */
function isOutOfHerd(doc){
  // قواعدك: status = "active" أو "inactive"
  const st = String(doc?.status ?? "").trim().toLowerCase();

  // لو مكتوب inactive → خارج القطيع
  if (st === "inactive") return true;

  // لو مكتوب قيمة أخرى (sale/dead/cull/…) → خارج القطيع
  if (st && st !== "active") return true;

  // دعم أعلام أخرى لو موجودة
  if (doc?.isActive === false || doc?.active === false) return true;

  return false;
}

/* ----------------- Run Gate ----------------- */
async function runGate(){
  if (!shouldGateThisPage()) return;

  installHardBlock();
  prefillCtx();

  const uid = getUid();
  if (!uid){
    window.__MBK_GATE_OK = true;
    mbkHideBar();
    return;
  }

  const number = getNumberFromDom() || getNumberFromCtx();

  if (!number){
    window.__MBK_GATE_OK = false;
    window.__MBK_GATE_MSG = "اكتب رقم الحيوان أولاً.";
    setSaveEnabled(false);
    mbkShowBar(window.__MBK_GATE_MSG, true);
    return;
  }

  window.__MBK_GATE_OK = false;
  window.__MBK_GATE_MSG = "جارِ التحقق…";
  setSaveEnabled(false);
  mbkShowBar("جارِ التحقق…", false);

  try{
    const doc = await fetchAnimalDoc(uid, number);

    if (!doc){
      window.__MBK_GATE_OK = false;
      window.__MBK_GATE_MSG = "هذا الحيوان غير موجود بالقطيع.";
      setSaveEnabled(false);
      mbkShowBar(window.__MBK_GATE_MSG, true);
      return;
    }

    if (isOutOfHerd(doc)){
      window.__MBK_GATE_OK = false;
      window.__MBK_GATE_MSG = `${animalLabel(doc)} خارج القطيع (بيع/نفوق/استبعاد).`;
      setSaveEnabled(false);
      mbkShowBar(window.__MBK_GATE_MSG, true);
      return;
    }

    window.__MBK_GATE_OK = true;
    window.__MBK_GATE_MSG = "";
    mbkHideBar();
    setSaveEnabled(true);
  } catch (e){
    window.__MBK_GATE_OK = false;
    window.__MBK_GATE_MSG = "تعذّر التحقق الآن.";
    setSaveEnabled(false);
    mbkShowBar(window.__MBK_GATE_MSG, true);
  }
}

/* ---------- add-animal unique check (كما هو) ---------- */
function attachUniqueAnimalNumberWatcher(){
  const form = document.getElementById("animalForm");
  const input = form?.querySelector("#animalNumber");
  if (!form || !input) return;

  let timer=null, lastValue="";

  input.addEventListener("input", ()=>{
    const num = normDigits(input.value);
    form.dataset.numberOk = "";

    if (!num){ window.mbkHideBar?.(); lastValue=""; return; }
    if (num === lastValue) return;
    lastValue = num;

    if (timer) clearTimeout(timer);
    timer = setTimeout(async ()=>{
      const userId = localStorage.getItem("userId");
      if (!userId) return;

      try{
        const r = await uniqueAnimalNumber({ userId, number: num });
        if (!r.ok){
          mbkShowBar(r.msg || "هذا الرقم مستخدم بالفعل.", true);
          form.dataset.numberOk="0";
        } else {
          mbkShowBar("✅ رقم الحيوان متاح.", false);
          form.dataset.numberOk="1";
        }
      } catch {}
    }, 400);
  });
}

/* ----------------- Boot ----------------- */
function boot(){
  runGate();

  const numEl = document.querySelector(
    "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']"
  );
  if (numEl){
    const rerun = ()=>{ clearTimeout(window.__mbkGateT); window.__mbkGateT = setTimeout(runGate, 250); };
    numEl.addEventListener("input", rerun);
    numEl.addEventListener("change", rerun);
    numEl.addEventListener("blur", rerun);
  }

  attachUniqueAnimalNumberWatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export { boot };
