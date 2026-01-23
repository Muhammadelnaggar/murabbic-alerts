// /js/forms-init.js — Murabbik Early Herd Gate (ESM)
// يمنع أي حفظ لحيوان خارج القطيع (inactive) قبل تعبئة المستخدم — مركزي 100%

import { db, auth } from "/js/firebase-config.js";
import { uniqueAnimalNumber } from "/js/form-rules.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
const page = document.documentElement.dataset.page || "";

const EVENT_PAGES = [
  // أحداث مباشرة
  "add-event",
  "insemination",
  "daily-milk",
  "lameness",
  "mastitis",
  "calving",
  "abortion",
  "pregnancy-diagnosis",
  "dry-off",
  "heat",
  "trimming",
  "vaccination",
  "sale",
  "death",

  // أدوات ذكية = أحداث
  "smart-camera",
  "nutrition",
  "pregnancy-diagnosis"
];

// -------- helpers
function normDigits(s){
  const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9','۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  return String(s||'').trim().replace(/[^\d٠-٩۰-۹]/g,'').replace(/[٠-٩۰-۹]/g, d=>map[d]);
}
function qs(k){ return new URL(location.href).searchParams.get(k) || ""; }
function firstNonEmpty(...v){ return v.find(x => String(x||"").trim() !== "") || ""; }
function today(){ return new Date().toISOString().slice(0,10); }

function getNumberAny(){
  return normDigits(firstNonEmpty(
    qs("number"), qs("animalNumber"), qs("animalId"),
    document.getElementById("animalNumber")?.value,
    document.getElementById("animalId")?.value,
    localStorage.getItem("lastAnimalId"),
    localStorage.getItem("currentAnimalId"),
    localStorage.getItem("lastAnimalNumber")
  ));
}
function getDateAny(){
  return String(firstNonEmpty(
    qs("date"), qs("eventDate"),
    localStorage.getItem("lastEventDate"),
    localStorage.getItem("eventDate"),
    today()
  )).trim();
}

function ensureBar(){
  const host = document.querySelector("form") || document.body;
  let bar = document.getElementById("info") || host.querySelector(".infobar");
  if (!bar){
    bar = document.createElement("div");
    bar.className = "infobar";
    bar.style.cssText =
      "margin:8px 0;padding:10px 12px;border-radius:10px;font:14px/1.4 system-ui,'Cairo',Arial;display:none;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-weight:700;text-align:center;";
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

function lockAll(locked){
  document.querySelectorAll("input,select,textarea,button").forEach(el=>{
    if (el.dataset && el.dataset.nav === "1") return;
    el.disabled = !!locked;
  });
  document.querySelectorAll("#saveBtn,.save,.btn-save,#bulkSaveBtn,button[type='submit'],input[type='submit']").forEach(b=>{
    if (b.dataset && b.dataset.nav === "1") return;
    b.style.display = locked ? "none" : "";
  });
}

function animalLabel(doc){
  const sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "").trim();
  if (/جاموس/i.test(sp) || sp === "جاموس") return "هذه الجاموسة";
  if (/بقر/i.test(sp)   || sp === "أبقار")  return "هذه البقرة";
  return "هذا الحيوان";
}

async function getUid(){
  const cached = String(
    window.__tenant?.userId ||
    localStorage.getItem("userId") ||
    localStorage.getItem("tenantId") ||
    localStorage.getItem("ownerUid") ||
    ""
  ).trim();
  if (cached) return cached;

  if (auth?.currentUser?.uid) return auth.currentUser.uid;
  const u = await new Promise(res => onAuthStateChanged(auth, x => res(x), () => res(null)));
  return u?.uid || "";
}

async function fetchAnimalDoc(uid, number){
  const key = `${uid}#${number}`;

  // 1) userId_number field
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

function installHardBlock(){
  if (window.__MBK_BLOCK_INSTALLED) return;
  window.__MBK_BLOCK_INSTALLED = true;

  document.addEventListener("click", (e)=>{
    if (!window.__MBK_INACTIVE) return;
    const hit = e.target.closest("#saveBtn,.save,.btn-save,#bulkSaveBtn,button[type='submit'],input[type='submit']");
    if (hit){
      e.preventDefault(); e.stopImmediatePropagation();
      show(window.__MBK_INACTIVE_MSG || "هذا الحيوان غير موجود بالقطيع.");
    }
  }, true);

  document.addEventListener("submit", (e)=>{
    if (!window.__MBK_INACTIVE) return;
    e.preventDefault(); e.stopImmediatePropagation();
    show(window.__MBK_INACTIVE_MSG || "هذا الحيوان غير موجود بالقطيع.");
  }, true);
}

async function mbkEarlyGate(){
  lockAll(true);
  show("جارِ التحقق…", true);

  // prefill
  const n = getNumberAny();
  const d = getDateAny();
  const numEl = document.getElementById("animalNumber") || document.getElementById("animalId");
  const dateEl = document.getElementById("eventDate");
  if (numEl && !numEl.value && n) numEl.value = n;
  if (dateEl && !dateEl.value && d) dateEl.value = d;

  const uid = await getUid();
  const number = getNumberAny();

  if (!uid || !number){
    hide();
    lockAll(false);
    return;
  }

  const doc = await fetchAnimalDoc(uid, number);
  if (!doc){
    window.__MBK_INACTIVE = true;
    window.__MBK_INACTIVE_MSG = "هذا الحيوان غير موجود بالقطيع.";
    installHardBlock();
    show(window.__MBK_INACTIVE_MSG);
    return;
  }

  const st = String(doc.status || "").trim().toLowerCase();
  if (st === "inactive"){
    window.__MBK_INACTIVE = true;
    window.__MBK_INACTIVE_MSG = `${animalLabel(doc)} غير موجودة بالقطيع.`;
    installHardBlock();
    show(window.__MBK_INACTIVE_MSG);
    return;
  }

  window.__MBK_INACTIVE = false;
  hide();
  lockAll(false);
}

// add-animal unique watcher (كما كان)
function attachUniqueAnimalNumberWatcher() {
  const form = document.getElementById("animalForm");
  const input = form?.querySelector("#animalNumber");
  if (!form || !input) return;

  const bar = ensureBar();
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

// boot
document.addEventListener("DOMContentLoaded", ()=>{

  // 🔒 التحقق الحيواني فقط في صفحات الأحداث
  if (EVENT_PAGES.includes(page)) {
    mbkEarlyGate();

    const numEl = document.getElementById("animalNumber") || document.getElementById("animalId");
    if (numEl){
      const rerun = ()=>{ 
        clearTimeout(window.__mbkGateT); 
        window.__mbkGateT = setTimeout(mbkEarlyGate, 250); 
      };
      numEl.addEventListener("input", rerun);
      numEl.addEventListener("change", rerun);
      numEl.addEventListener("blur", rerun);
    }
  }

  // ✅ ده يفضل شغال كما هو (خاص بإضافة حيوان)
  attachUniqueAnimalNumberWatcher();

});
