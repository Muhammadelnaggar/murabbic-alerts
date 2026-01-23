// /js/forms-init.js — Murabbik Central Gate (ESM)
// ✅ يمنع أي تسجيل لحيوان غير موجود/Inactive عبر: submit + onclick + tool buttons (مركزي)

import { db } from "./firebase-config.js";
import { uniqueAnimalNumber } from "./form-rules.js";
import {
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Helpers ---------- */
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
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
               '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  return String(s||"").trim().replace(/[^\d٠-٩۰-۹]/g,'').replace(/[٠-٩۰-۹]/g, d=>map[d]);
}

function getNumberFromCtx(){
  return normDigits(firstNonEmpty(
    qs("number"), qs("animalNumber"), qs("animalId"),
    localStorage.getItem("lastAnimalId"),
    localStorage.getItem("currentAnimalId"),
    localStorage.getItem("lastAnimalNumber"),
    localStorage.getItem("animalNumber"),
    localStorage.getItem("animalId")
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

function pageHasSaveTargets(){
  return !!document.querySelector(SAVE_TARGETS);
}

function pageHasAnimalNumberField(){
  return !!document.querySelector(ANIMAL_FIELDS);
}

/* ---------- UI ---------- */
function ensureInfoBar(){
  // يفضّل الموجود أصلاً
  let bar = document.getElementById("info") || document.querySelector(".infobar");
  if (bar) return bar;

  // لو فيه فورم حطها فوقه
  const host = document.querySelector("form") || document.body;
  bar = document.createElement("div");
  bar.id = "info";
  bar.className = "infobar";
  bar.style.cssText = `
    margin:8px 0; padding:10px 12px; border-radius:10px;
    font:14px/1.4 system-ui,'Cairo',Arial; display:none;
    background:#fff7ed; border:1px solid #fed7aa; color:#9a3412;
    font-weight:700; text-align:center;
  `;
  host.prepend(bar);
  return bar;
}

function show(msg, ok=false){
  const bar = ensureInfoBar();
  bar.style.display = "block";
  bar.style.borderColor = ok ? "#bbf7d0" : "#fed7aa";
  bar.style.background   = ok ? "#ecfdf5" : "#fff7ed";
  bar.style.color        = ok ? "#065f46" : "#9a3412";
  bar.textContent = msg;
}

function hide(){
  const bar = ensureInfoBar();
  bar.style.display = "none";
}

function animalLabel(doc){
  const sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "").trim();
  if (/جاموس/i.test(sp) || sp === "جاموس") return "هذه الجاموسة";
  if (/بقر/i.test(sp)   || sp === "أبقار")  return "هذه البقرة";
  return "هذا الحيوان";
}

/* ---------- Gate Targets ---------- */
const ANIMAL_FIELDS =
  "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']";

const SAVE_TARGETS =
  "#saveBtn,.btn-save,.save,#bulkSaveBtn,button[type='submit'],input[type='submit'],[data-validate],.tool[data-page]";

/* ---------- Fetch animal doc (no assumptions) ---------- */
async function fetchAnimalDoc(uid, number){
  const key = `${uid}#${number}`;

  // 1) userId_number
  let qy = query(collection(db,"animals"), where("userId_number","==", key), limit(1));
  let snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  // 2) userId + number
  qy = query(collection(db,"animals"), where("userId","==", uid), where("number","==", String(number)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  // 3) ownerUid + number
  qy = query(collection(db,"animals"), where("ownerUid","==", uid), where("number","==", String(number)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  return null;
}

/* ---------- Central Gate Core ---------- */
async function runGateOnce(){
  // بوابة لا تعمل إلا لو الصفحة “تنفّذ تسجيل”
  if (!pageHasSaveTargets() && !pageHasAnimalNumberField() && !getNumberFromCtx()) {
    window.__mbkGate = { ok:true, skip:true };
    return window.__mbkGate;
  }

  const uid = getUid();
  if (!uid){
    window.__mbkGate = { ok:false, reason:"no_uid" };
    show("تعذّر تحديد المستخدم.");
    return window.__mbkGate;
  }

  // رقم الحيوان: من الحقل لو موجود، وإلا من الكونتكست
  const field = document.querySelector(ANIMAL_FIELDS);
  let number = normDigits(field?.value || getNumberFromCtx());

  // ✅ لا تجميد: لو مفيش رقم، امنع الحفظ فقط وخلّي المستخدم يكتب
  if (!number){
    if (field){
      field.removeAttribute("readonly");
      field.disabled = false;
      try{ field.focus(); }catch{}
    }
    window.__mbkGate = { ok:false, reason:"no_number" };
    show("أدخل رقم الحيوان أولًا.");
    return window.__mbkGate;
  }

  // لو فيه تاريخ وحقل، prefll اختياري
  const dt = getDateFromCtx();
  const dtEl = document.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");
  if (dtEl && !String(dtEl.value||"").trim() && dt) dtEl.value = dt;

  show("جارِ التحقق…", true);

  const doc = await fetchAnimalDoc(uid, number);
  if (!doc){
    if (field){
      field.removeAttribute("readonly");
      field.disabled = false;
      try{ field.focus(); field.select?.(); }catch{}
    }
    window.__mbkGate = { ok:false, reason:"not_found" };
    show("هذا الحيوان غير موجود بالقطيع.");
    return window.__mbkGate;
  }

  const st = String(doc.status || "").trim().toLowerCase();
  if (st === "inactive"){
    if (field){
      field.removeAttribute("readonly");
      field.disabled = false;
      try{ field.focus(); field.select?.(); }catch{}
    }
    window.__mbkGate = { ok:false, reason:"inactive" };
    show(`${animalLabel(doc)} غير موجودة بالقطيع.`);
    return window.__mbkGate;
  }

  hide();
  window.__mbkGate = { ok:true, doc };
  return window.__mbkGate;
}

/* ---------- Hard Block (submit + onclick + tools) ---------- */
function installUniversalBlocker(){
  if (window.__MBK_BLOCKER_INSTALLED) return;
  window.__MBK_BLOCKER_INSTALLED = true;

  // 1) منع submit لو gate مش ok
  document.addEventListener("submit", async (e)=>{
    if (!pageHasSaveTargets() && !pageHasAnimalNumberField() && !getNumberFromCtx()) return;

    const g = window.__mbkGate?.ok ? window.__mbkGate : await runGateOnce();
    if (!g.ok){
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // 2) منع أي click على أزرار/أدوات الحفظ لو gate مش ok
  document.addEventListener("click", async (e)=>{
    const hit = e.target.closest(SAVE_TARGETS);
    if (!hit) return;

    // لو ده زر/لينك تنقّل صِرف سِيبُه
    if (hit.dataset && hit.dataset.nav === "1") return;

    const g = window.__mbkGate?.ok ? window.__mbkGate : await runGateOnce();
    if (!g.ok){
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

/* ---------- add-animal unique check (كما كان) ---------- */
function attachUniqueAnimalNumberWatcher() {
  const form = document.getElementById("animalForm");
  const input = form?.querySelector("#animalNumber");
  if (!form || !input) return;

  const bar = ensureInfoBar();
  let timer = null;
  let lastValue = "";

  input.addEventListener("input", () => {
    const num = normDigits(input.value);
    form.dataset.numberOk = "";

    if (!num) { bar.style.display = "none"; lastValue = ""; return; }
    if (num === lastValue) return;
    lastValue = num;

    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const userId = localStorage.getItem("userId");
      if (!userId) return;

      try {
        const r = await uniqueAnimalNumber({ userId, number: num });
        if (!r.ok) show(r.msg || "هذا الرقم مستخدم بالفعل.");
        else show("✅ رقم الحيوان متاح.", true);
      } catch {}
    }, 400);
  });
}

/* ---------- Boot ---------- */
function boot(){
  installUniversalBlocker();

  // تشغيل gate عند التحميل لو الصفحة “تنفّذ”
  if (pageHasSaveTargets() || pageHasAnimalNumberField() || getNumberFromCtx()){
    runGateOnce();
  }

  // إعادة تشغيل gate عند تغيير الرقم
  const numEl = document.querySelector(ANIMAL_FIELDS);
  if (numEl){
    const rerun = ()=>{ clearTimeout(window.__mbkGateT); window.__mbkGateT = setTimeout(runGateOnce, 180); };
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
