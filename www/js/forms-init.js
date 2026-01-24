// /js/forms-init.js — Murabbik Central Gate (ESM)
// ✅ بوابة قطيع مركزية: تمنع أي حفظ/تسجيل لحيوان غير موجود أو خارج القطيع
// ✅ UI مركزي (Infobar) يدعم Actions بدون أعطال DOM
// ✅ لا تُجمّد الصفحة: تترك إدخال رقم الحيوان متاح دائمًا وتمنع "الحفظ فقط"

import { db, auth } from "./firebase-config.js";
import { uniqueAnimalNumber, validateEvent } from "./form-rules.js";

import {
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ----------------- Helpers ----------------- */
function qs(k){ return new URL(location.href).searchParams.get(k) || ""; }
function firstNonEmpty(...v){ return v.find(x => String(x||"").trim() !== "") || ""; }
function today(){ return new Date().toISOString().slice(0,10); }

function getUid(){
  const a = auth?.currentUser?.uid || "";
  return String(
    a ||
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
  let bar = document.getElementById("info");

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

  let infoText = bar.querySelector("#infoText");
  if (!infoText){
    infoText = document.createElement("div");
    infoText.id = "infoText";
    infoText.className = "msg-text";
    bar.appendChild(infoText);
  }

  let infoActions = bar.querySelector("#infoActions");
  if (!infoActions){
    infoActions = document.createElement("div");
    infoActions.id = "infoActions";
    infoActions.className = "msg-actions";
    bar.appendChild(infoActions);
  }

  let infoClose = bar.querySelector("#infoClose");
  if (!infoClose){
    infoClose = document.createElement("button");
    infoClose.id = "infoClose";
    infoClose.type = "button";
    infoClose.textContent = "×";
    infoClose.className = "msg-close";
    bar.appendChild(infoClose);
  }

  if (!bar.__closeBound){
    bar.__closeBound = true;
    infoClose.addEventListener("click", ()=> mbkHideBar());
  }

  return bar;
}

function clearActions(){
  const bar = ensureBar();
  const box = bar.querySelector("#infoActions");
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
}

function mbkShowBar(msg, isError=false, actions=[]){
  const bar = ensureBar();
  const text = bar.querySelector("#infoText");
  const box  = bar.querySelector("#infoActions");

  bar.style.display = "block";
  bar.classList.toggle("show", true);
  bar.classList.toggle("error", !!isError);

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
  const text = bar.querySelector("#infoText");
  if (text) text.textContent = "";
}

window.mbkShowBar = mbkShowBar;
window.mbkHideBar = mbkHideBar;

window.showBar = function(msg, isError=false, actions=[]){
  try{ window.mbkShowBar?.(msg, !!isError, actions || []); } catch {}
};
window.hideBar = function(){
  try{ window.mbkHideBar?.(); } catch {}
};

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
  const st = String(doc?.status ?? "").trim().toLowerCase();
  if (st === "inactive") return true;
  if (st && st !== "active") return true;
  if (doc?.isActive === false || doc?.active === false) return true;
  return false;
}

/* ----------------- Page -> Event Type ----------------- */
function pageToEventType(){
  const p = String(document.documentElement?.dataset?.page || document.body?.dataset?.page || "").trim().toLowerCase();
  const map = {
    "calving": "ولادة",
    "abortion": "إجهاض",
    "insemination": "تلقيح",
    "pregnancy-diagnosis": "تشخيص حمل",
    "dry-off": "تجفيف",
    "daily-milk": "لبن يومي",
    "mastitis": "التهاب ضرع",
    "lameness": "عرج",
    "heat": "شياع",
    "vaccination": "تحصين"
  };
  return map[p] || "";
}

/* ----------------- Payload Collector ----------------- */
function collectPayload(){
  const payload = {};

  document.querySelectorAll("[data-field]").forEach(el=>{
    const k = String(el.getAttribute("data-field") || "").trim();
    if (!k) return;
    payload[k] = (el.type === "checkbox") ? !!el.checked : String(el.value || "").trim();
  });

  const nEl = document.querySelector("#animalNumber,#animalId,[name='animalNumber'],[name='animalId']");
  const dEl = document.querySelector("#eventDate,[name='eventDate']");
  const sEl = document.querySelector("#species,[name='species']");

  if (!payload.animalNumber && !payload.animalId) payload.animalNumber = normDigits(nEl?.value || "") || "";
  if (!payload.eventDate) payload.eventDate = String(dEl?.value || "").trim() || getDateFromCtx();
  if (!payload.species) payload.species = String(sEl?.value || "").trim();

  payload.documentData = window.__MBK_ANIMAL_DOC || null;
  return payload;
}

function dispatchValid(payload){
  const ev = new CustomEvent("mbk:valid", { detail: payload });
  window.dispatchEvent(ev);
  document.dispatchEvent(ev);
}

/* ----------------- Quick Validation (show early, without save) ----------------- */
function quickValidateCalving(){
  const eventType = pageToEventType();
  if (eventType !== "ولادة") return;

  const doc = window.__MBK_ANIMAL_DOC || null;
  if (!doc) return;

  // ✅ اعرض "غير عشار" فورًا (بدون انتظار ملء باقي الحقول)
  const rs = String(doc.reproductiveStatus || doc.reproStatus || "").trim();
  if (rs && rs !== "عشار"){
    mbkShowBar(`❌ لا يمكن تسجيل الولادة: الحالة التناسلية الحالية (${rs}).`, true);
    return;
  }

  // لو لسه البيانات ناقصة، متزعّجش المستخدم برسائل "مطلوب" بدري
  const dEl  = document.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");
  const lfEl = document.querySelector("[data-field='lastFertileInseminationDate'],[name='lastFertileInseminationDate'],#lastFertileInseminationDate,#lastFertile");

  const eventDate = String(dEl?.value || "").trim();
  const lastFert  = String(lfEl?.value || "").trim();

  if (!eventDate || !lastFert) return;

  const payload = collectPayload();
  const r = validateEvent("ولادة", payload);

  if (!r.ok){
    mbkShowBar((r.errors && r.errors[0]) ? r.errors[0] : "لا يمكن الحفظ.", true);
  } else {
    mbkHideBar();
  }
}

/* ----------------- Run Gate ----------------- */
async function runGate(){
  if (!shouldGateThisPage()) return;

  installHardBlock();
  prefillCtx();

  const uid = getUid();
  if (!uid){
    window.__MBK_GATE_OK = false;
    window.__MBK_GATE_MSG = "سجّل الدخول أولاً.";
    setSaveEnabled(false);
    mbkShowBar(window.__MBK_GATE_MSG, true);
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

    window.__MBK_UID = uid;
    window.__MBK_ANIMAL_NUMBER = String(number);
    window.__MBK_ANIMAL_DOC = doc;

    // تعبئة الحقول المخفية المطلوبة
    const idEl = document.querySelector("#animalId,[data-field='animalId']");
    const spEl = document.querySelector("#species,[data-field='species']");

    if (idEl && !idEl.value) idEl.value = String(number);
    if (spEl && !spEl.value) spEl.value = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "");

    // ✅ فعّل الحفظ (الفاليديشن المركزي سيمنع عند الحاجة)
    setSaveEnabled(true);

    // ✅ اعرض رسالة "غير عشار" فورًا إن وجدت
    quickValidateCalving();

    // لو مفيش رسالة، اخفي
    if (!document.getElementById("info")?.style?.display || document.getElementById("info")?.style?.display === "none"){
      mbkHideBar();
    }

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

    if (!num){ mbkHideBar(); lastValue=""; return; }
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

/* ================== Validation Dispatcher (Central) ================== */
function installValidationDispatcher(){
  if (window.__MBK_VALID_DISPATCHER) return;
  window.__MBK_VALID_DISPATCHER = true;

  const doValidate = (e)=>{
    if (!window.__MBK_GATE_OK) return;

    const eventType = pageToEventType();
    if (!eventType) return;

    const hit = e.target?.closest?.(SAVE_SEL);
    if (!hit) return;

    e.preventDefault(); e.stopImmediatePropagation();

    const payload = collectPayload();
    const r = validateEvent(eventType, payload);

    if (!r.ok){
      mbkShowBar((r.errors && r.errors[0]) ? r.errors[0] : "لا يمكن الحفظ.", true);
      return;
    }

    dispatchValid(payload);
  };

  document.addEventListener("click", doValidate, true);
  document.addEventListener("submit", doValidate, true);
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
    numEl.addEventListener("keyup", rerun);
  }

  // ✅ اظهار رسالة الولادة بدري عند تغيير التاريخ/آخر تلقيح مخصّب
  const dEl  = document.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");
  const lfEl = document.querySelector("[data-field='lastFertileInseminationDate'],[name='lastFertileInseminationDate'],#lastFertileInseminationDate,#lastFertile");

  const rerunQuick = ()=>{ clearTimeout(window.__mbkQV); window.__mbkQV = setTimeout(quickValidateCalving, 150); };
  dEl?.addEventListener("input", rerunQuick);
  dEl?.addEventListener("change", rerunQuick);
  lfEl?.addEventListener("input", rerunQuick);
  lfEl?.addEventListener("change", rerunQuick);

  attachUniqueAnimalNumberWatcher();
  installValidationDispatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export { boot };
