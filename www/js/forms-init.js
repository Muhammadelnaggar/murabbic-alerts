// /js/forms-init.js — Murabbik Central Gate (ESM)
// Gate مركزي يمنع الحفظ/التسجيل لأي حيوان خارج القطيع (inactive)
// يعمل مع الصفحات التي لا تحتوي <form> (زر حفظ onclick) ويعطي فرصة لتغيير الرقم بدون تجميد.

import { db } from "./firebase-config.js";
import { uniqueAnimalNumber } from "./form-rules.js";
import { collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
  return String(s||"")
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g,'')
    .replace(/[٠-٩۰-۹]/g, d=>map[d]);
}

function getNumberFromCtx(){
  return normDigits(firstNonEmpty(
    qs("number"), qs("animalNumber"), qs("animalId"),
    localStorage.getItem("currentAnimalNumber"),
    localStorage.getItem("lastAnimalNumber"),
    localStorage.getItem("currentAnimalId"),
    localStorage.getItem("lastAnimalId")
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

/* ---------- UI: Infobar / Warn ---------- */
function ensureInfoBar(){
  // يلتقط الموجود (صفحات فورم/غير فورم)
  let bar = document.querySelector(".infobar") || document.getElementById("info");

  if (!bar) {
    // لو مفيش infobar في الصفحة، ننشئ واحد بدون تغيير شكل الصفحة (نفس ستايل النسخة السابقة)
    bar = document.createElement("div");
    bar.className = "infobar";
    bar.style.cssText = `
      margin:10px 12px; padding:10px 12px; border-radius:10px;
      font:14px/1.4 system-ui,'Cairo',Arial; display:none;
      background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; font-weight:800; text-align:center;
    `;
    const main = document.querySelector("main") || document.body;
    main.prepend(bar);
  }
  return bar;
}

function showBar(msg, ok=false){
  const bar = ensureInfoBar();
  bar.style.display = "block";
  bar.style.borderColor = ok ? "#bbf7d0" : "#fed7aa";
  bar.style.background   = ok ? "#ecfdf5" : "#fff7ed";
  bar.style.color        = ok ? "#065f46" : "#9a3412";
  bar.textContent = msg;
  return bar;
}

function hideBar(){
  const bar = document.querySelector(".infobar") || document.getElementById("info");
  if (bar) bar.style.display = "none";
}

function showWarnIfExists(msg){
  const w = document.getElementById("warn");
  if (!w) return;
  w.style.display = "block";
  w.textContent = msg;
}

/* ---------- Detect number input + save targets ---------- */
function getNumberInput(){
  return document.querySelector(
    "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']"
  );
}

function getDateInput(){
  return document.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");
}

function isEventLikePage(){
  // صفحة أحداث = فيها زر حفظ/تسجيل
  return !!document.querySelector("#saveBtn,[data-validate='true'],button[type='submit'],.btn-save");
}

function guardTargets(){
  // كل ما يمكنه تنفيذ حفظ/تسجيل
  const arr = [
    ...document.querySelectorAll("#saveBtn,[data-validate='true'],.btn-save,button[type='submit']")
  ];

  // صفحات الكاميرا الذكية: الأدوات تعتبر “تنفيذ” لكن فقط لو في رقم بالحقيقة
  if (document.querySelector(".tool[data-page]")) {
    arr.push(...document.querySelectorAll(".tool[data-page]"));
  }

  // إزالة تكرارات
  return Array.from(new Set(arr));
}

function setTargetsEnabled(enabled, opts={}){
  const { keepNav=true } = opts;
  guardTargets().forEach(el=>{
    if (keepNav && el.dataset && el.dataset.nav === "1") return;
    // لا نكسر back button في smart-camera (id=backBtn)
    if (el.id === "backBtn") return;

    // لو tool buttons: نقفلها فقط عندما نقرر gate إلزامي
    el.disabled = !enabled;
    if (!enabled) el.setAttribute("aria-disabled","true");
    else el.removeAttribute("aria-disabled");
  });
}

/* ---------- Prefill ---------- */
function prefillCtx(){
  const num = getNumberFromCtx();
  const dt  = getDateFromCtx();

  const numEl = getNumberInput();
  const dtEl  = getDateInput();

  if (numEl && !String(numEl.value||"").trim() && num) numEl.value = num;
  if (dtEl  && !String(dtEl.value||"").trim()  && dt)  dtEl.value  = dt;
}

/* ---------- Animal label ---------- */
function animalLabel(doc){
  const sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "").trim();
  if (/جاموس/i.test(sp) || sp === "جاموس") return "هذه الجاموسة";
  if (/بقر/i.test(sp)   || sp === "أبقار")  return "هذه البقرة";
  return "هذا الحيوان";
}

/* ---------- Fetch animal doc (no assumptions) ---------- */
async function fetchAnimalDoc(uid, number){
  const key = `${uid}#${number}`;

  // 1) الأفضل: userId_number
  let qy = query(collection(db,"animals"), where("userId_number","==", key), limit(1));
  let snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  // 2) fallback: userId + number (string)
  qy = query(collection(db,"animals"), where("userId","==", uid), where("number","==", String(number)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  // 3) fallback: ownerUid + number (string)
  qy = query(collection(db,"animals"), where("ownerUid","==", uid), where("number","==", String(number)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  return null;
}

/* ---------- Allow editing number when blocked ---------- */
function allowNumberEdit(){
  const numEl = getNumberInput();
  if (!numEl) return;

  // حفظ حالة readonly الأصلية
  if (numEl.dataset.origReadonly == null) {
    numEl.dataset.origReadonly = numEl.hasAttribute("readonly") ? "1" : "0";
  }

  numEl.removeAttribute("readonly");
  numEl.disabled = false;

  // اختياري: نظف لو قيمته فاضية/غير صالحة
  // لا نمسح لو المستخدم كتب بالفعل
  try{ numEl.focus({preventScroll:true}); }catch{}
}

function restoreNumberReadonly(){
  const numEl = getNumberInput();
  if (!numEl) return;

  if (numEl.dataset.origReadonly === "1") numEl.setAttribute("readonly","");
  // لو الأصل كان مش readonly، لا نغيره
}

/* ---------- Gate State ---------- */
function setGate(ok, doc=null){
  window.__mbkGate = window.__mbkGate || {};
  window.__mbkGate.ok  = !!ok;
  window.__mbkGate.doc = doc || null;

  // لو صفحة أحداث: نقفل/نفتح الحفظ
  if (isEventLikePage()) {
    setTargetsEnabled(!!ok, {keepNav:true});
  } else {
    // صفحات غير أحداث: لا نقفل حاجة
    setTargetsEnabled(true, {keepNav:true});
  }
}

/* ---------- Central Gate Run ---------- */
let _gateBusy = false;
async function runGate(){
  if (_gateBusy) return;
  _gateBusy = true;

  prefillCtx();

  const uid = getUid();
  const numEl = getNumberInput();
  const number = normDigits(String(numEl?.value || getNumberFromCtx() || ""));

  // مبدئياً: لو صفحة أحداث → اقفل التنفيذ لحد ما نتحقق
  if (isEventLikePage()) setTargetsEnabled(false, {keepNav:true});

  // حالة: لا يوجد userId
  if (!uid){
    setGate(false);
    if (isEventLikePage()){
      showBar("تعذّر تحديد المستخدم.", false);
      showWarnIfExists("تعذّر تحديد المستخدم.");
    }
    _gateBusy = false;
    return;
  }

  // حالة: لا يوجد رقم
  if (!number){
    setGate(false);
    if (isEventLikePage()){
      showBar("اكتب رقم الحيوان أولًا.", false);
      allowNumberEdit();
    } else {
      // صفحات غير أحداث (مثل smart-camera) لا نجمدها
      showWarnIfExists("⚠️ لم يتم تحديد رقم الحيوان.");
      setGate(true);
    }
    _gateBusy = false;
    return;
  }

  // تحقق
  if (isEventLikePage()) showBar("جارِ التحقق…", true);

  try{
    const doc = await fetchAnimalDoc(uid, number);

    if (!doc){
      setGate(false);
      if (isEventLikePage()){
        showBar("هذا الحيوان غير موجود بالقطيع. اكتب رقمًا آخر.", false);
        allowNumberEdit();
      } else {
        showWarnIfExists("⚠️ الحيوان غير موجود بالقطيع.");
        // صفحات غير أحداث: لا نقفلها
        setGate(true);
      }
      _gateBusy = false;
      return;
    }

    const st = String(doc.status || "").trim().toLowerCase();
    if (st === "inactive"){
      setGate(false);
      const m = `${animalLabel(doc)} غير موجودة بالقطيع. اكتب رقمًا آخر.`;
      if (isEventLikePage()){
        showBar(m, false);
        allowNumberEdit();
      } else {
        showWarnIfExists(m);
        // لو عندنا أدوات camera/tool ومعها رقم: اقفلها
        setTargetsEnabled(false, {keepNav:true});
      }
      _gateBusy = false;
      return;
    }

    // ✅ OK
    hideBar();
    showWarnIfExists("");
    setGate(true, doc);
    restoreNumberReadonly();

    // خزّن آخر رقم/تاريخ لتسهيل الصفحات
    localStorage.setItem("lastAnimalNumber", String(number));
    const dt = getDateInput()?.value || getDateFromCtx();
    if (dt) localStorage.setItem("lastEventDate", String(dt).slice(0,10));

  }catch(e){
    console.error(e);
    setGate(false);
    if (isEventLikePage()){
      showBar("تعذّر التحقق الآن. حاول مرة أخرى.", false);
      allowNumberEdit();
    } else {
      // غير أحداث: لا نجمد
      setGate(true);
    }
  }finally{
    _gateBusy = false;
  }
}

/* ---------- Hard block clicks (حتى لو الصفحة بتستخدم btn.onclick) ---------- */
function installHardBlock(){
  if (document.body.dataset.mbkHardBlock === "1") return;
  document.body.dataset.mbkHardBlock = "1";

  document.addEventListener("click", (e)=>{
    const t = e.target?.closest?.("#saveBtn,[data-validate='true'],.btn-save,button[type='submit'],.tool[data-page]");
    if (!t) return;

    // Back button لا يتقفل
    if (t.id === "backBtn") return;

    // لو page مش أحداث وtool والرقم غير موجود: نسمح (smart-camera بدون رقم)
    if (t.classList?.contains("tool") && !getNumberFromCtx() && !getNumberInput()) return;

    const ok = !!window.__mbkGate?.ok;
    if (!ok){
      e.preventDefault();
      e.stopImmediatePropagation();

      // رسالة مناسبة
      if (isEventLikePage()){
        showBar("⚠️ لا يمكن الحفظ قبل إدخال رقم صحيح لحيوان داخل القطيع.", false);
        allowNumberEdit();
      } else {
        showWarnIfExists("⚠️ لا يمكن المتابعة: الحيوان خارج القطيع.");
      }
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
        if (!r.ok) {
          showBar(r.msg || "هذا الرقم مستخدم بالفعل.", false);
          form.dataset.numberOk = "0";
        } else {
          showBar("✅ رقم الحيوان متاح.", true);
          form.dataset.numberOk = "1";
        }
      } catch {}
    }, 400);
  });
}

/* ---------- Boot ---------- */
function autoAttach(){
  installHardBlock();
  // gate يشتغل فقط لما الصفحة “تشبه” صفحة أحداث (زر حفظ) أو فيها رقم حيوان فعلاً
  const hasNumEl = !!getNumberInput();
  if (isEventLikePage() || hasNumEl) {
    // اقفل الأهداف لحين تحقق (صفحات أحداث فقط)
    if (isEventLikePage()) setTargetsEnabled(false, {keepNav:true});
    runGate();

    const numEl = getNumberInput();
    const dtEl  = getDateInput();
    const rerun = () => { clearTimeout(window.__mbkGateT); window.__mbkGateT = setTimeout(runGate, 200); };

    numEl?.addEventListener("input", rerun);
    numEl?.addEventListener("change", rerun);
    dtEl?.addEventListener("change", rerun);
  } else {
    // صفحات ليست أحداث ولا رقم — لا نتدخل
    setGate(true);
  }

  attachUniqueAnimalNumberWatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", autoAttach);
} else {
  autoAttach();
}

export { autoAttach, runGate };
