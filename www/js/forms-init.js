// /js/forms-init.js — ESM

import { validateEvent, uniqueAnimalNumber } from "./form-rules.js";
import { db } from "./firebase-config.js";
import {
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------------- UI helpers ---------------- */
function ensureInfoBar(form) {
  let bar = form.querySelector(".infobar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "infobar";
    bar.style.cssText = `
      margin:8px 0; padding:10px 12px; border-radius:10px;
      font: 14px/1.4 system-ui, 'Cairo', Arial;
      display:none; background:#fff; border:1px solid #e2e8f0; color:#0f172a;
    `;
    form.prepend(bar);
  }
  return bar;
}

function showMsg(bar, msgs, type = "error") {
  if (!bar) return;
  bar.style.display = "block";
  bar.style.borderColor = type === "error" ? "#ef9a9a" : "#bbf7d0";
  bar.style.background = type === "error" ? "#ffebee" : "#ecfdf5";
  bar.style.color = type === "error" ? "#b71c1c" : "#065f46";
  bar.innerHTML = Array.isArray(msgs)
    ? `<ul style="margin:0;padding-left:18px">${msgs.map(m => `<li>${m}</li>`).join("")}</ul>`
    : msgs;
}

function lockFormControls(form, locked) {
  form.querySelectorAll("input, select, textarea, button").forEach(el => {
    if (el.dataset && el.dataset.nav === "1") return;
    el.disabled = !!locked;
  });

  const saveBtn = form.querySelector('button[type="submit"], #saveBtn, .btn-save');
  if (saveBtn) saveBtn.style.display = locked ? "none" : "";
}

/* ---------------- data helpers ---------------- */
function collectFormData(form) {
  const data = {};
  form.querySelectorAll("[data-field]").forEach(el => {
    const k = el.getAttribute("data-field");
    let v =
      el.type === "checkbox" ? (el.checked ? (el.value || true) : "") :
      el.type === "radio" ? (el.checked ? el.value : (data[k] || "")) :
      el.value;
    data[k] = v;
  });

  if (!data.species && localStorage.getItem("herdSpecies")) {
    data.species = localStorage.getItem("herdSpecies");
  }
  return data;
}

function getCtxNumber() {
  const u = new URL(location.href);
  const n =
    u.searchParams.get("number") ||
    u.searchParams.get("animalNumber") ||
    u.searchParams.get("animalId") ||
    localStorage.getItem("currentAnimalNumber") ||
    localStorage.getItem("lastAnimalNumber") ||
    localStorage.getItem("lastAnimalId") ||
    "";
  return String(n || "").trim();
}

function getCtxDate() {
  const u = new URL(location.href);
  const d =
    u.searchParams.get("date") ||
    u.searchParams.get("eventDate") ||
    localStorage.getItem("lastEventDate") ||
    "";
  return String(d || new Date().toISOString().slice(0, 10)).trim();
}

async function fetchAnimalDocByNumber(userId, number) {
  if (!userId || !number) return null;

  const qy = query(
    collection(db, "animals"),
    where("userId", "==", userId),
    where("number", "==", String(number)),
    limit(1)
  );

  const snap = await getDocs(qy);
  if (snap.empty) return null;

  const docSnap = snap.docs[0];
  return { id: docSnap.id, ...docSnap.data() };
}

/* ---------------- Gate (before any input) ---------------- */
async function preGateForm(form, eventName, bar) {
  const page = document.documentElement.getAttribute("data-page") || "";
  if (page === "add-animal" || eventName === "إضافة حيوان") return;

  // start locked
  form.dataset.gated = "0";
  lockFormControls(form, true);
  showMsg(bar, "جارٍ التحقق من حالة الحيوان…", "ok");

  const userId = String(localStorage.getItem("userId") || "").trim();
  const numberFromCtx = getCtxNumber();
  const dateFromCtx = getCtxDate();

  const numField = form.querySelector('[data-field="animalId"], [data-field="animalNumber"], #animalNumber, #animalId');
  const dateField = form.querySelector('[data-field="eventDate"], #eventDate');

  const number = String((numField?.value || numberFromCtx) || "").trim();
  const eventDate = String((dateField?.value || dateFromCtx) || "").trim();

  if (!userId) {
    showMsg(bar, "تعذّر تحديد المستخدم. افتح الصفحة من داخل النظام.", "error");
    return;
  }
  if (!number) {
    showMsg(bar, "رقم الحيوان غير متاح.", "error");
    return;
  }

  let doc = null;
  try {
    doc = await fetchAnimalDocByNumber(userId, number);
  } catch (e) {
    console.error("fetchAnimalDocByNumber failed", e);
  }

  if (!doc) {
    showMsg(bar, `تعذّر العثور على الحيوان رقم ${number}.`, "error");
    return;
  }

  form._mbk_doc = doc;
  form._mbk_ctx = { number, eventDate };

  const probe = {
    animalId: number,
    eventDate: eventDate || new Date().toISOString().slice(0, 10),
    documentData: doc,
    species: doc.species,
  };

  const res = validateEvent(eventName, probe);
  if (!res.ok) {
    showMsg(bar, res.errors?.[0] || "غير مسموح.", "error");
    return; // keep locked
  }

  // unlock
  form.dataset.gated = "1";
  bar.style.display = "none";
  lockFormControls(form, false);

  if (numField && !numField.value) numField.value = number;
  if (dateField && !dateField.value) dateField.value = probe.eventDate;
}

/* ---------------- attach per-form ---------------- */
async function attachOne(form) {
  const bar = ensureInfoBar(form);
  const eventName = form.getAttribute("data-event");
  if (!eventName) return;

  await preGateForm(form, eventName, bar);

  // لو الرقم/التاريخ اتغيروا (في صفحات فيها تعديل)، نعيد Gate
  const numField = form.querySelector('[data-field="animalId"], [data-field="animalNumber"], #animalNumber, #animalId');
  const dateField = form.querySelector('[data-field="eventDate"], #eventDate');

  const reGate = async () => {
    await preGateForm(form, eventName, bar);
  };

  if (numField) numField.addEventListener("change", reGate);
  if (dateField) dateField.addEventListener("change", reGate);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (form.dataset.gated !== "1") {
      showMsg(bar, "⚠️ جارٍ التحقق… انتظر لحظة.", "error");
      return;
    }

    const formData = collectFormData(form);

    // inject doc + ctx
    if (!formData.documentData) formData.documentData = form._mbk_doc || null;
    if (!formData.animalId) formData.animalId = form._mbk_ctx?.number || formData.animalNumber || "";
    if (!formData.eventDate) formData.eventDate = form._mbk_ctx?.eventDate || "";

    const { ok, errors } = validateEvent(eventName, formData);

    if (!ok) {
      showMsg(bar, errors, "error");
      form.dataset.valid = "0";
      return;
    }

    form.dataset.valid = "1";
    showMsg(bar, "✅ البيانات سليمة — جاري الحفظ...", "ok");

    const ev = new CustomEvent("mbk:valid", { detail: { formData, eventName, form } });
    form.dispatchEvent(ev);
  });
}

/* ---------------- unique number watcher (add-animal) ---------------- */
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

    if (!num) {
      bar.style.display = "none";
      lastValue = "";
      return;
    }
    if (num === lastValue) return;
    lastValue = num;

    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const userId = localStorage.getItem("userId");
      if (!userId) return;

      try {
        const res = await uniqueAnimalNumber({ userId, number: num });
        if (!res.ok) {
          showMsg(bar, res.msg || "هذا الرقم مستخدم بالفعل.", "error");
          form.dataset.numberOk = "0";
        } else {
          showMsg(bar, "✅ رقم الحيوان متاح في حسابك.", "ok");
          form.dataset.numberOk = "1";
        }
      } catch (e) {
        console.error("uniqueAnimalNumber check failed", e);
      }
    }, 400);
  });
}

/* ---------------- auto attach ---------------- */
function autoAttach() {
  document.querySelectorAll('form[data-validate="true"][data-event]').forEach(form => {
    attachOne(form);
  });
  attachUniqueAnimalNumberWatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", autoAttach);
} else {
  autoAttach();
}

export { autoAttach };
