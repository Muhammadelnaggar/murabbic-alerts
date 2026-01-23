// /js/forms-init.js — Murabbik Central Gate (ESM)
// ✅ بوابة قطيع مركزية: تمنع أي حفظ/تسجيل لحيوان غير موجود أو inactive
// ✅ تعمل على الصفحات بدون <form> (saveBtn / data-validate / tool buttons)
// ✅ لا تُجمّد الصفحة: تترك إدخال رقم الحيوان متاح دائمًا وتمنع "الحفظ فقط"

import { db } from "./firebase-config.js";
import { uniqueAnimalNumber } from "./form-rules.js";
import { collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

/* ----------------- UI: Infobar ----------------- */
function ensureBar(){
  const host = document.querySelector(".mbk-form") || document.querySelector("main") || document.body;
  let bar = document.getElementById("info") || host.querySelector(".infobar");
  if (!bar){
    bar = document.createElement("div");
    bar.id = "info";
    bar.className = "infobar";
    bar.style.cssText =
      "margin:8px 0;padding:10px 12px;border-radius:10px;font:14px/1.4 system-ui,'Cairo',Arial;display:none;" +
      "background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-weight:700;text-align:center;";
    host.prepend(bar);
  }
  return bar;
}
function show(msg, ok=false){
  const bar = ensureBar();
  bar.style.display = "block";
  bar.style.borderColor = ok ? "#bbf7d0" : "#fed7aa";
  bar.style.background   = ok ? "#ecfdf5" : "#fff7ed";
  bar.style.color        = ok ? "#065f46" : "#9a3412";
  bar.textContent = msg;
}
function hide(){
  const bar = ensureBar();
  bar.style.display = "none";
}

/* ----------------- Gate Targets ----------------- */
const SAVE_SEL = "#saveBtn,.save,.btn-save,#bulkSaveBtn,[data-validate],button[type='submit'],input[type='submit']";
const TOOL_SEL = ".tool[data-page]";

/* بوابة تطبّق فقط لو الصفحة فيها زر حفظ/أداة تسجل */
function shouldGateThisPage(){
  return !!document.querySelector(SAVE_SEL + "," + TOOL_SEL);
}

function setSaveEnabled(on){
  // لا نقفل إدخال الرقم أبداً
  document.querySelectorAll(SAVE_SEL).forEach(el=>{
    // استثناء أزرار التنقل لو عندك data-nav=1
    if (el?.dataset?.nav === "1") return;
    el.disabled = !on;
    if (el.id === "saveBtn" || el.classList.contains("btn-save") || el.hasAttribute("data-validate")) {
      el.style.opacity = on ? "" : "0.55";
    }
  });

  // أدوات الكاميرا الذكية (tool buttons)
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
    show(window.__MBK_GATE_MSG || "لا يمكن الحفظ.");
  }, true);

  document.addEventListener("submit", (e)=>{
    if (window.__MBK_GATE_OK) return;
    e.preventDefault(); e.stopImmediatePropagation();
    show(window.__MBK_GATE_MSG || "لا يمكن الحفظ.");
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

/* ----------------- Run Gate ----------------- */
async function runGate(){
  if (!shouldGateThisPage()) return;

  installHardBlock();
  prefillCtx();

  const uid = getUid();
  if (!uid){
    // لو مفيش مستخدم: ما نغيّرش سلوك صفحات غير التسجيل
    window.__MBK_GATE_OK = true;
    hide();
    return;
  }

  const number = getNumberFromDom() || getNumberFromCtx();

  // ✅ لو الصفحة بتسجل بس الرقم فاضي: امنع الحفظ فقط، واترك الإدخال مفتوح
  if (!number){
    window.__MBK_GATE_OK = false;
    window.__MBK_GATE_MSG = "اكتب رقم الحيوان أولاً.";
    setSaveEnabled(false);
    show(window.__MBK_GATE_MSG);
    return;
  }

  // تحقق
  window.__MBK_GATE_OK = false;
  window.__MBK_GATE_MSG = "جارِ التحقق…";
  setSaveEnabled(false);
  show("جارِ التحقق…", true);

  try{
    const doc = await fetchAnimalDoc(uid, number);

    if (!doc){
      window.__MBK_GATE_OK = false;
      window.__MBK_GATE_MSG = "هذا الحيوان غير موجود بالقطيع.";
      setSaveEnabled(false);
      show(window.__MBK_GATE_MSG);
      return;
    }

    const st = String(doc.status || "").trim().toLowerCase();
    if (st === "inactive"){
      window.__MBK_GATE_OK = false;
      window.__MBK_GATE_MSG = `${animalLabel(doc)} غير موجودة بالقطيع.`;
      setSaveEnabled(false);
      show(window.__MBK_GATE_MSG);
      return;
    }

    // ✅ OK
    window.__MBK_GATE_OK = true;
    window.__MBK_GATE_MSG = "";
    hide();
    setSaveEnabled(true);
  } catch (e){
    window.__MBK_GATE_OK = false;
    window.__MBK_GATE_MSG = "تعذّر التحقق الآن.";
    setSaveEnabled(false);
    show(window.__MBK_GATE_MSG);
  }
}

/* ---------- add-animal unique check (كما هو) ---------- */
function attachUniqueAnimalNumberWatcher(){
  const form = document.getElementById("animalForm");
  const input = form?.querySelector("#animalNumber");
  if (!form || !input) return;

  const bar = ensureBar();
  let timer=null, lastValue="";

  input.addEventListener("input", ()=>{
    const num = normDigits(input.value);
    form.dataset.numberOk = "";

    if (!num){ bar.style.display="none"; lastValue=""; return; }
    if (num === lastValue) return;
    lastValue = num;

    if (timer) clearTimeout(timer);
    timer = setTimeout(async ()=>{
      const userId = localStorage.getItem("userId");
      if (!userId) return;

      try{
        const r = await uniqueAnimalNumber({ userId, number: num });
        if (!r.ok){
          show(r.msg || "هذا الرقم مستخدم بالفعل.");
          form.dataset.numberOk="0";
        } else {
          show("✅ رقم الحيوان متاح.", true);
          form.dataset.numberOk="1";
        }
      } catch {}
    }, 400);
  });
}

/* ----------------- Boot ----------------- */
function boot(){
  // أول تشغيل
  runGate();

  // إعادة التحقق عند تغيير الرقم
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
