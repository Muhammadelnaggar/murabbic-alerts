// /js/forms-init.js — Murabbik Central Gate (ESM)
// يمنع الحفظ لأي حيوان خارج القطيع (inactive) قبل تعبئة النموذج — مركزي 100%

import { db } from "./firebase-config.js";
import { uniqueAnimalNumber } from "./form-rules.js";
import { collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Helpers ---------- */
function qs(k){ return new URL(location.href).searchParams.get(k) || ""; }
function firstNonEmpty(...v){ return v.find(x => String(x||"").trim() !== "") || ""; }
function today(){ return new Date().toISOString().slice(0,10); }

function getUid(){
  // ✅ مركزي: لا نفترض مفتاح واحد
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
    localStorage.getItem("lastAnimalNumber")
  ));
}

function getDateFromCtx(){
  return String(firstNonEmpty(qs("date"), qs("eventDate"), localStorage.getItem("lastEventDate"), localStorage.getItem("eventDate"), today())).trim();
}

function ensureInfoBar(form){
  let bar = form.querySelector(".infobar") || document.getElementById("info");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "infobar";
    bar.style.cssText = `
      margin:8px 0; padding:10px 12px; border-radius:10px;
      font:14px/1.4 system-ui,'Cairo',Arial; display:none;
      background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; font-weight:700; text-align:center;
    `;
    form.prepend(bar);
  }
  return bar;
}

function showBar(bar, msg, ok=false){
  bar.style.display = "block";
  bar.style.borderColor = ok ? "#bbf7d0" : "#fed7aa";
  bar.style.background   = ok ? "#ecfdf5" : "#fff7ed";
  bar.style.color        = ok ? "#065f46" : "#9a3412";
  bar.textContent = msg;
}

function lock(form, locked){
  form.querySelectorAll("input,select,textarea,button").forEach(el => {
    if (el.dataset && el.dataset.nav === "1") return;
    el.disabled = !!locked;
  });
  const btn = form.querySelector('button[type="submit"], #saveBtn, .btn-save');
  if (btn) btn.style.display = locked ? "none" : "";
}

function prefill(form){
  const num = getNumberFromCtx();
  const dt  = getDateFromCtx();

  const numEl = form.querySelector(
    "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']"
  );
  const dtEl = form.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");

  if (numEl && !String(numEl.value||"").trim() && num) numEl.value = num;
  if (dtEl && !String(dtEl.value||"").trim() && dt)  dtEl.value  = dt;
}

function animalLabel(doc){
  const sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "").trim();
  if (/جاموس/i.test(sp) || sp === "جاموس") return "هذه الجاموسة";
  if (/بقر/i.test(sp)   || sp === "أبقار")  return "هذه البقرة";
  return "هذا الحيوان";
}

/* ---------- Fetch animal doc (no assumptions) ---------- */
async function fetchAnimalDoc(uid, number){
  // 1) الأفضل: userId_number
  const key = `${uid}#${number}`;
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

/* ---------- Central Gate ---------- */
async function runGate(form){
  const bar = ensureInfoBar(form);

  form.dataset.gated = "0";
  lock(form, true);
  prefill(form);

  const uid = getUid();
  const number = normDigits(
    form.querySelector("#animalNumber,#animalId,[name='animalNumber'],[name='animalId']")?.value || getNumberFromCtx()
  );

  if (!uid) { showBar(bar, "تعذّر تحديد المستخدم."); return; }
  if (!number) { showBar(bar, "أدخل رقم الحيوان أولًا."); return; }

  // رسالة خفيفة (اختياري)
  showBar(bar, "جارِ التحقق…", true);

  const doc = await fetchAnimalDoc(uid, number);
  if (!doc) {
    showBar(bar, "هذا الحيوان غير موجود بالقطيع.");
    return;
  }

  const st = String(doc.status || "").trim().toLowerCase();
  if (st === "inactive") {
    showBar(bar, `${animalLabel(doc)} غير موجودة بالقطيع.`);
    return; // يظل مقفول
  }

  // ✅ OK
  bar.style.display = "none";
  form.dataset.gated = "1";
  form._mbk_doc = doc;
  lock(form, false);
}

function attachGate(form){
  if (!form || form.dataset.mbkGateBound === "1") return;
  form.dataset.mbkGateBound = "1";

  // ✅ يمنع أي submit handlers أخرى (مركزي) لو gate غير ناجح
  form.addEventListener("submit", (e) => {
    if (form.dataset.gated !== "1") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const bar = ensureInfoBar(form);
      showBar(bar, "⚠️ لا يمكن الحفظ.", false);
    }
  }, true);

  runGate(form);

  const numEl = form.querySelector("#animalNumber,#animalId,[name='animalNumber'],[name='animalId']");
  const dtEl  = form.querySelector("#eventDate,[name='eventDate']");
  const rerun = () => { clearTimeout(form._mbkGateT); form._mbkGateT = setTimeout(()=>runGate(form), 200); };

  numEl?.addEventListener("input", rerun);
  numEl?.addEventListener("change", rerun);
  dtEl?.addEventListener("change", rerun);
}

/* ---------- add-animal unique check (كما كان) ---------- */
function attachUniqueAnimalNumberWatcher() {
  const form = document.getElementById("animalForm");
  const input = form?.querySelector("#animalNumber");
  if (!form || !input) return;

  const bar = ensureInfoBar(form);
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
          showBar(bar, r.msg || "هذا الرقم مستخدم بالفعل.");
          form.dataset.numberOk = "0";
        } else {
          showBar(bar, "✅ رقم الحيوان متاح.", true);
          form.dataset.numberOk = "1";
        }
      } catch {}
    }, 400);
  });
}

/* ---------- Boot ---------- */
function autoAttach(){
  document.querySelectorAll("form").forEach(attachGate);
  attachUniqueAnimalNumberWatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", autoAttach);
} else {
  autoAttach();
}

export { autoAttach };
