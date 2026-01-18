// /js/forms-init.js — Murabbik Global Early Gate (ESM)
// هدفه: منع أي submit لحيوان status=inactive فور فتح الصفحة + تعبئة الرقم/التاريخ من URL
// يعمل على أي <form> حتى لو الصفحة عندها كود حفظ مباشر (بـ capture)

import { db } from "./firebase-config.js";
import { validateEvent, uniqueAnimalNumber } from "./form-rules.js";
import {
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* =============== Helpers =============== */
function qs(k){ return new URL(location.href).searchParams.get(k) || ""; }
function firstNonEmpty(...v){ return v.find(x => String(x||"").trim() !== "") || ""; }
function today(){ return new Date().toISOString().slice(0,10); }

function getUserId(){
  return String(window.__tenant?.userId || localStorage.getItem("userId") || "").trim();
}

function getNumberFromCtx(){
  return String(firstNonEmpty(
    qs("number"), qs("animalId"), qs("animalNumber"),
    localStorage.getItem("currentAnimalId"),
    localStorage.getItem("lastAnimalId"),
    localStorage.getItem("lastAnimalNumber")
  )).trim();
}

function getDateFromCtx(){
  return String(firstNonEmpty(
    qs("date"), qs("eventDate"),
    localStorage.getItem("eventDate"),
    localStorage.getItem("lastEventDate"),
    today()
  )).trim();
}

function ensureInfoBar(form){
  let bar = form.querySelector(".infobar") || document.getElementById("info");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "infobar";
    bar.style.cssText = `
      margin:8px 0; padding:10px 12px; border-radius:10px;
      font: 14px/1.4 system-ui,'Cairo',Arial;
      display:none; background:#ffebee; border:1px solid #ef9a9a; color:#b71c1c;
    `;
    form.prepend(bar);
  }
  return bar;
}

function showBar(bar, msg, ok=false){
  bar.style.display = "block";
  bar.style.borderColor = ok ? "#bbf7d0" : "#ef9a9a";
  bar.style.background   = ok ? "#ecfdf5" : "#ffebee";
  bar.style.color        = ok ? "#065f46" : "#b71c1c";
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

  const numEl = form.querySelector("#animalId,#animalNumber,[name='animalId'],[name='animalNumber'],[data-field='animalId'],[data-field='animalNumber']");
  const dtEl  = form.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");

  if (numEl && !String(numEl.value||"").trim() && num) numEl.value = num;
  if (dtEl && !String(dtEl.value||"").trim() && dt) dtEl.value = dt;
}

async function fetchAnimalDocByKey(uid, number){
  const key = `${uid}#${number}`;
  const qy = query(
    collection(db, "animals"),
    where("userId_number", "==", key),
    limit(1)
  );
  const snap = await getDocs(qy);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

/* =============== Core Gate =============== */
async function runGate(form){
  const bar = ensureInfoBar(form);

  form.dataset.gated = "0";
  lock(form, true);
  prefill(form);

  const uid = getUserId();
  const number = String(
    form.querySelector("#animalId,#animalNumber,[name='animalId'],[name='animalNumber']")?.value || getNumberFromCtx()
  ).trim();

  if (!uid) { showBar(bar, "تعذّر تحديد المستخدم. افتح الصفحة من داخل النظام."); return; }
  if (!number) { showBar(bar, "رقم الحيوان غير متاح."); return; }

  showBar(bar, "جارٍ التحقق من حالة الحيوان…", true);

  let animalDoc = null;
  try {
    animalDoc = await fetchAnimalDocByKey(uid, number);
  } catch (e) {
    console.error("Gate fetch failed:", e);
  }

  if (!animalDoc) { showBar(bar, `تعذّر العثور على الحيوان رقم ${number}.`); return; }

  // ✅ استخدم الفاليديشن المركزي نفسه
  const eventDate = String(
    form.querySelector("#eventDate,[name='eventDate']")?.value || getDateFromCtx()
  ).trim();

  const res = validateEvent("لبن يومي", { animalId: number, eventDate, documentData: animalDoc }); // مجرد استدعاء للـ inactive lock
  if (!res.ok) {
    showBar(bar, res.errors?.[0] || "غير مسموح.");
    return; // يظل مقفول
  }

  // ✅ OK
  bar.style.display = "none";
  form.dataset.gated = "1";
  form._mbk_doc = animalDoc;
  lock(form, false);
}

function attachGateToForm(form){
  if (!form || form.dataset.mbkGateBound === "1") return;
  form.dataset.mbkGateBound = "1";

  // ✅ capture: يمنع أي submit handlers أخرى لو gate غير ناجح
  form.addEventListener("submit", (e) => {
    if (form.dataset.gated !== "1") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const bar = ensureInfoBar(form);
      showBar(bar, "⚠️ لا يمكن الحفظ قبل التحقق من حالة الحيوان.");
    }
  }, true);

  runGate(form);

  const numEl = form.querySelector("#animalId,#animalNumber,[name='animalId'],[name='animalNumber']");
  const dtEl  = form.querySelector("#eventDate,[name='eventDate']");
  const rerun = () => { clearTimeout(form._mbkGateT); form._mbkGateT = setTimeout(()=>runGate(form), 200); };
  numEl?.addEventListener("input", rerun);
  numEl?.addEventListener("change", rerun);
  dtEl?.addEventListener("change", rerun);
}

/* =============== add-animal unique check (اختياري) =============== */
function attachUniqueAnimalNumberWatcher() {
  const form = document.getElementById("animalForm");
  const input = form?.querySelector("#animalNumber");
  if (!form || !input) return;

  const bar = ensureInfoBar(form);
  let timer = null;
  let lastValue = "";

  input.addEventListener("input", () => {
    const num = String(input.value || "").trim();
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
          showBar(bar, "✅ رقم الحيوان متاح في حسابك.", true);
          form.dataset.numberOk = "1";
        }
      } catch (e) {
        console.error("uniqueAnimalNumber check failed", e);
      }
    }, 400);
  });
}

/* =============== Boot =============== */
function autoAttach(){
  document.querySelectorAll("form").forEach(attachGateToForm);
  attachUniqueAnimalNumberWatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", autoAttach);
} else {
  autoAttach();
}

export { autoAttach };
