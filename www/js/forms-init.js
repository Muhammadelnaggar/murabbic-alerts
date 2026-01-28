// /js/forms-init.js — ESM (Central Gate + Validation)
// ✅ Gate: يتحقق من وجود الحيوان أولًا (ويمنع ملء باقي الحقول حتى يثبت وجوده)
// ✅ Validation: عند الحفظ فقط (لتجنب Deadlock قبل إدخال الحقول)
// ✅ يجمع [data-field] ويُظهر رسائل في infobar أعلى النموذج
// ✅ عند النجاح يطلق "mbk:valid" ويحمل البيانات في detail.formData

import { validateEvent, uniqueAnimalNumber, thresholds, uniqueCalfNumbers, guards } from "./form-rules.js";
import { db, auth } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  limit,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* ===================== UI: Infobar ===================== */
function ensureInfoBar(form) {
  let bar = document.getElementById("sysbar") || form.querySelector(".infobar");

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

function showMsg(bar, msgs, type = "error", actions = []) {
  if (!bar) return;

  bar.style.display = "block";
  bar.style.borderColor = type === "error" ? "#ef9a9a" : "#bbf7d0";
  bar.style.background = type === "error" ? "#ffebee" : "#ecfdf5";
  bar.style.color = type === "error" ? "#b71c1c" : "#065f46";

  const html = Array.isArray(msgs)
    ? `<ul style="margin:0;padding-left:18px">${msgs
        .map((m) => `<li>${String(m || "")}</li>`)
        .join("")}</ul>`
    : `<div>${String(msgs || "")}</div>`;

  bar.innerHTML = html;
  try{ bar.scrollIntoView({ behavior:"smooth", block:"start" }); }catch(_){}

  if (Array.isArray(actions) && actions.length) {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "margin-top:10px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;";

    actions.forEach((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label || "إجراء";
      btn.style.cssText =
        "padding:10px 12px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:800;font-size:14px;min-width:150px;";
      if (a.primary) {
        btn.style.border = "0";
        btn.style.background = "#0ea05a";
        btn.style.color = "#fff";
      }
      btn.addEventListener("click", () => {
        try {
          a.onClick && a.onClick();
        } catch (_) {}
      });
      wrap.appendChild(btn);
    });

    bar.appendChild(wrap);
  }
}
/* ===================== UI: Field Errors (Inline) ===================== */
function clearFieldErrors(form){
  form.querySelectorAll(".mbk-field-error").forEach(el => el.remove());
  form.querySelectorAll(".mbk-field-error-target").forEach(el => {
    el.classList.remove("mbk-field-error-target");
    el.removeAttribute("aria-invalid");
  });
}


function placeFieldError(form, fieldName, msg){
  const el =
    form.querySelector(`[data-field="${fieldName}"]`) ||
    form.querySelector(`#${fieldName}`) ||
    null;

  if (!el) return null;

  const box = document.createElement("div");
  box.className = "mbk-field-error";
  box.style.cssText = "margin:6px 0 6px; padding:8px 10px; border-radius:10px; background:#ffebee; border:1px solid #ef9a9a; color:#b71c1c; font: 13px/1.4 system-ui,'Cairo',Arial;";
  box.textContent = String(msg || "خطأ في هذا الحقل.");

  // ✅ “فوق الحقل”: نحط الرسالة قبل input/select/textarea مباشرة
  el.parentNode.insertBefore(box, el);

  el.classList.add("mbk-field-error-target");
  el.setAttribute("aria-invalid", "true");

  return box;
}

function scrollToFirstFieldError(form){
  const first = form.querySelector(".mbk-field-error");
  if (first) {
    first.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/* ===================== Helpers ===================== */
async function getUid() {
  if (auth?.currentUser?.uid) return auth.currentUser.uid;

  return await new Promise((res) => {
    const unsub = onAuthStateChanged(auth, (u) => {
      try {
        unsub && unsub();
      } catch (_) {}
      res(u?.uid || "");
    });
  });
}

function normalizeDigits(number) {
  const map = {
    "٠": "0",
    "١": "1",
    "٢": "2",
    "٣": "3",
    "٤": "4",
    "٥": "5",
    "٦": "6",
    "٧": "7",
    "٨": "8",
    "٩": "9",
    "۰": "0",
    "۱": "1",
    "۲": "2",
    "۳": "3",
    "۴": "4",
    "۵": "5",
    "۶": "6",
    "۷": "7",
    "۸": "8",
    "۹": "9"
  };
  return String(number || "")
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g, "")
    .replace(/[٠-٩۰-۹]/g, (d) => map[d]);
}

function stripTashkeel(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[ًٌٍَُِّْ]/g, "");
}

function getFieldEl(form, name) {
  return (
    form.querySelector(`[data-field="${name}"]`) ||
    form.querySelector(`#${name}`) ||
    null
  );
}

function setFormInputsDisabled(form, disabled, allowIds = []) {
  const allow = new Set((allowIds || []).filter(Boolean));
  form.querySelectorAll("input, select, textarea, button").forEach((el) => {
    if (allow.has(el.id)) return;
    if (allow.has(el.getAttribute("data-field"))) return;
    el.disabled = !!disabled;
  });
}

/* ===================== Data: Collect ===================== */
function collectFormData(form) {
  const data = {};
  form.querySelectorAll("[data-field]").forEach((el) => {
    const k = el.getAttribute("data-field");
    let v =
      el.type === "checkbox"
        ? el.checked
          ? el.value || true
          : ""
        : el.type === "radio"
          ? el.checked
            ? el.value
            : data[k] || ""
          : el.value;

    data[k] = v;
  });

  if (!data.species && localStorage.getItem("herdSpecies")) {
    data.species = localStorage.getItem("herdSpecies");
  }

  return data;
}

/* ===================== Animal Gate ===================== */
async function fetchAnimalByNumberForUser(uid, number) {
  const num = normalizeDigits(number);
  if (!uid || !num) return null;

  // 1) Fast path: userId_number المركّب
  try {
    const key = `${uid}#${num}`;
    const q1 = query(
      collection(db, "animals"),
      where("userId_number", "==", key),
      limit(1)
    );
    const s1 = await getDocs(q1);
    if (!s1.empty) {
      const d = s1.docs[0];
      return { id: d.id, data: d.data() || {} };
    }
  } catch (_) {}

  // 2) Fallbacks: number / animalNumber (string/number)
  const tries = [
    ["number", num],
    ["animalNumber", num],
    ["animalNumber", Number(num)]
  ].filter((t) => !(typeof t[1] === "number" && Number.isNaN(t[1])));

  for (const [field, val] of tries) {
    try {
      const q2 = query(
        collection(db, "animals"),
        where("userId", "==", uid),
        where(field, "==", val),
        limit(1)
      );
      const s2 = await getDocs(q2);
      if (!s2.empty) {
        const d = s2.docs[0];
        return { id: d.id, data: d.data() || {} };
      }
    } catch (_) {}
  }

  return null;
}
// ✅ يقرأ أقوى إشارات من events (لا نطلب orderBy لتجنب Index)
async function fetchCalvingSignalsFromEvents(uid, number) {
  const num = String(normalizeDigits(number || "")).trim();

  // ✅ لو مفيش uid/رقم
  if (!uid || !num) {
    return {
      reproStatusFromEvents: "",
      lastBoundary: "",
      lastBoundaryType: ""
    };
  }

  const qEv = query(
    collection(db, "events"),
    where("userId", "==", uid),
    where("animalNumber", "==", num),
    limit(60)
  );

  const snap = await getDocs(qEv);
  const arr = snap.docs
    .map((d) => d.data() || {})
    .filter((ev) => ev.eventDate)
    .sort((a, b) => String(b.eventDate).localeCompare(String(a.eventDate)));

  let reproStatusFromEvents = "";
  let lastBoundary = "";
  let lastBoundaryType = ""; // "ولادة" أو "إجهاض"

  for (const ev of arr) {
    const type = String(ev.eventType || ev.type || "").trim();
    const res  = String(ev.result || ev.status || "").trim();
    const dt   = String(ev.eventDate || "").trim();

    // Boundary (آخر ولادة/إجهاض)
    if ((type === "ولادة" || type === "إجهاض") && !lastBoundary) {
      lastBoundary = dt;
      lastBoundaryType = type;
      if (!reproStatusFromEvents) reproStatusFromEvents = "مفتوحة";
      continue;
    }

    // تشخيص حمل
    if (type === "تشخيص حمل") {
      const r = stripTashkeel(res);
      if (!reproStatusFromEvents) {
        if (r.includes("عشار")) reproStatusFromEvents = "عشار";
        if (r.includes("فارغه") || r.includes("فارغة")) reproStatusFromEvents = "مفتوحة";
      }
    }

    if (reproStatusFromEvents && lastBoundary) break;
  }

  return { reproStatusFromEvents, lastBoundary, lastBoundaryType };
}

function applyAnimalToForm(form, animal) {
  form.__mbkDoc = animal?.data || null;
  form.__mbkAnimalId = animal?.id || "";

  const animalIdEl = getFieldEl(form, "animalId");
  if (animalIdEl) animalIdEl.value = form.__mbkAnimalId || "";

  const speciesEl = getFieldEl(form, "species");
  let sp = String(animal?.data?.species || animal?.data?.animalTypeAr || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";
  if (speciesEl && sp) speciesEl.value = sp;

  // ✅ (حسب طلبك) تعبئة آخر تلقيح من وثيقة الحيوان فقط
  const lastAIEl = getFieldEl(form, "lastInseminationDate");
  const lastAI = String(animal?.data?.lastInseminationDate || "").trim();
  if (lastAIEl && lastAI && !lastAIEl.value) lastAIEl.value = lastAI;
}

async function ensureAnimalExistsGate(form, bar) {
  if (!localStorage.getItem("userId") && !auth?.currentUser) {
  showMsg(bar, "سجّل الدخول أولًا.", "error");
  lockForm(true);
  return false;
}

  const uid = await getUid();
  const numEl = getFieldEl(form, "animalNumber");
  const n = normalizeDigits(numEl?.value || "");

  // ✅ السماح دائمًا برقم الحيوان + التاريخ (مايتقفلش eventDate)
  const ALLOW = ["animalNumber", "eventDate"];

  if (!uid) {
    applyAnimalToForm(form, null);
    showMsg(bar, "سجّل الدخول أولًا.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  if (!n) {
    applyAnimalToForm(form, null);
    bar.style.display = "none";
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  if (form.__mbkLastCheckedNumber === n && form.dataset.animalOk === "1") {
    return true;
  }

  form.__mbkLastCheckedNumber = n;
  form.dataset.animalOk = "0";
  applyAnimalToForm(form, null);

  showMsg(bar, "جارِ التحقق من رقم الحيوان…", "ok");
  setFormInputsDisabled(form, true, ALLOW);

  const animal = await fetchAnimalByNumberForUser(uid, n);
  if (!animal) {
    showMsg(bar, "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  const st = String(animal.data?.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    showMsg(bar, "❌ هذا الحيوان خارج القطيع (بيع/نفوق/استبعاد) — لا يمكن تسجيل أحداث له.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  applyAnimalToForm(form, animal);
  form.dataset.animalOk = "1";
  setFormInputsDisabled(form, false, ALLOW);
  return true;
}

/* ===================== Attach ===================== */
function attachOne(form) {
  const bar = ensureInfoBar(form);
  const eventName = form.getAttribute("data-event");
  if (!eventName) return;

  // 🔒 يقفل/يفتح كل الفورم (ماعدا رقم الحيوان + التاريخ)
  function lockForm(locked) {
    form.dataset.locked = locked ? "1" : "0";
    form.querySelectorAll("input, select, textarea, button").forEach((el) => {
      const key = el.id || el.getAttribute("data-field") || "";
      if (key === "animalNumber" || key === "eventDate") return;
      el.disabled = !!locked;
    });
  }

  // ✅ أول ما الصفحة تفتح: اقفل كل شيء لحد ما Gate يقول "أخضر"
  lockForm(true);

  // Gate فقط (بدون validateEvent الكامل) لتجنب Deadlock
  async function runGateOnly() {
    const n = normalizeDigits(getFieldEl(form, "animalNumber")?.value || "");
    const d = String(getFieldEl(form, "eventDate")?.value || "").trim();
     clearFieldErrors(form); // ✅ امسح أي أخطاء حقول قديمة

    if (!n || !d) {
      bar.style.display = "none";
      lockForm(true);
      return false;
    }

    const okAnimal = await ensureAnimalExistsGate(form, bar);
    if (!okAnimal) {
      lockForm(true);
      return false;
    }
   // ✅ (للولادة فقط) تحقق شروط الولادة قبل فتح الحقول
if (eventName === "ولادة" && typeof guards?.calvingDecision === "function") {
  const uid = await getUid();

  // حضّر بيانات بوابة الولادة من وثيقة الحيوان + إشارات الأحداث
  const sig = await fetchCalvingSignalsFromEvents(uid, n);

  const gateData = {
    animalNumber: n,
    eventDate: d,
    animalId: form.__mbkAnimalId || "",
    species: String(getFieldEl(form, "species")?.value || "").trim(),
    documentData: form.__mbkDoc || null,

    // مهم: آخر تلقيح من وثيقة الحيوان (زي اتفاقنا)
    lastInseminationDate: String(form.__mbkDoc?.lastInseminationDate || "").trim(),

    // إشارات من الأحداث
    reproStatusFromEvents: sig.reproStatusFromEvents || "",
    lastBoundary: sig.lastBoundary || "",
    lastBoundaryType: sig.lastBoundaryType || ""
  };

  const g = guards.calvingDecision(gateData);

  if (g && g.ok === false) {
    // لو فيه عرض “تسجيل إجهاض” (OFFER_ABORT)
    const errs = Array.isArray(g.errors) ? g.errors : [g.msg || "لا يُسمح بتسجيل الولادة."];
    const cleaned = errs.map((e) => String(e || "").replace(/^OFFER_ABORT\|/, ""));
    const hasAbortHint = errs.some((e) => String(e || "").startsWith("OFFER_ABORT|"));

    if (hasAbortHint) {
      const url = `/abortion.html?number=${encodeURIComponent(n)}&date=${encodeURIComponent(d)}`;
      showMsg(bar, cleaned, "error", [
        { label: "نعم — تسجيل إجهاض", primary: true, onClick: () => (location.href = url) },
        { label: "لا — تعديل التاريخ", onClick: () => getFieldEl(form, "eventDate")?.focus?.() }
      ]);
    } else {
      showMsg(bar, cleaned, "error");
    }

    lockForm(true);
    return false;
  }
}

    // ✅ أخضر: افتح الإدخال
    showMsg(bar, "✅ التحقق صحيح — يمكنك إدخال البيانات", "ok");
    lockForm(false);
    return true;
  }

  // Full validation + إطلاق mbk:valid (وقت الحفظ فقط)
  async function runFullValidationAndDispatch() {
    const n = normalizeDigits(getFieldEl(form, "animalNumber")?.value || "");
    const d = String(getFieldEl(form, "eventDate")?.value || "").trim();

    if (!n || !d) {
      showMsg(bar, "أدخل رقم الحيوان وتاريخ الحدث أولًا.", "error");
      lockForm(false);
      return false;
    }

    // 1) Gate وجود الحيوان
    const okAnimal = await ensureAnimalExistsGate(form, bar);
    if (!okAnimal) {
      lockForm(true);
      return false;
    }

    // 2) جهّز formData
    const formData = collectFormData(form);
    formData.documentData = form.__mbkDoc || null;
    if (!formData.animalId && form.__mbkAnimalId) formData.animalId = form.__mbkAnimalId;

    // 3) enrichment للولادة فقط
    if (eventName === "ولادة") {
      const uid = await getUid();
      const sig = await fetchCalvingSignalsFromEvents(uid, n);
      if (sig.reproStatusFromEvents) formData.reproStatusFromEvents = sig.reproStatusFromEvents;
    
      if (sig.lastBoundary) formData.lastBoundary = sig.lastBoundary;
      if (sig.lastBoundaryType) formData.lastBoundaryType = sig.lastBoundaryType;
      // ✅ آخر تلقيح: من وثيقة الحيوان فقط
formData.lastInseminationDate = String(form.__mbkDoc?.lastInseminationDate || "").trim();


    }

    // 4) Validation الحقيقي (المركزي)
   const res = validateEvent(eventName, formData);

if (!res.ok) {
  clearFieldErrors(form);

  const errs = res.errors || [];
  const fieldErrors = res.fieldErrors || {};
  const guardErrors = res.guardErrors || [];

  // ✅ لو في أخطاء حقول → تظهر فوق الحقول (بدون infobar)
  const fieldKeys = Object.keys(fieldErrors);
  if (fieldKeys.length) {
    bar.style.display = "none";
    fieldKeys.forEach((k) => placeFieldError(form, k, fieldErrors[k]));
    scrollToFirstFieldError(form);
    lockForm(false); // خليه يقدر يعدّل الحقول
    return false;
  }

  // ✅ لو مفيش أخطاء حقول (يعني Guards) → استخدم infobar
  const cleaned = errs.map((e) => String(e || "").replace(/^OFFER_ABORT\|/, ""));
  const hasAbortHint =
    eventName === "ولادة" &&
    errs.some((e) => String(e || "").startsWith("OFFER_ABORT|"));

  if (hasAbortHint) {
    const url = `/abortion.html?number=${encodeURIComponent(n)}&date=${encodeURIComponent(d)}`;
    showMsg(bar, cleaned, "error", [
      { label: "نعم — تسجيل إجهاض", primary: true, onClick: () => (location.href = url) },
      { label: "لا — تعديل التاريخ", onClick: () => getFieldEl(form, "eventDate")?.focus?.() }
    ]);
  } else {
    showMsg(bar, cleaned, "error");
  }

  lockForm(false);
  return false;
}

    // ✅ نجاح: اطلق الحدث من الفورم (أفضل من document)
    clearFieldErrors(form);

    // 4.5) ✅ DB-level: منع تكرار رقم العجل لنفس المستخدم (لـ "ولادة" فقط)
if (eventName === "ولادة") {
  const uid = await getUid();

  const kind = String(formData.calvingKind || "").trim();
  if (kind !== "نافقة") {
    const count = parseInt(String(formData.calfCount || "1"), 10) || 1;

    const calfNums = [
      formData.calfId,
      count >= 2 ? formData.calf2Id : "",
      count >= 3 ? formData.calf3Id : ""
    ].filter(Boolean);

    const chk = await uniqueCalfNumbers({ userId: uid, calfNumbers: calfNums });

    if (!chk.ok) {
      clearFieldErrors(form);
      showMsg(bar, chk.msg || "⚠️ رقم عجل مكرر في حسابك.", "error");
      lockForm(false);
      return false;
    }
  }
}

    form.dispatchEvent(
      new CustomEvent("mbk:valid", {
        bubbles: true,
        detail: { formData, eventName, form }
      })
    );
    return true;
  }

  // ✅ شغّل Gate بعد ما الصفحة تحمل
  setTimeout(runGateOnly, 0);

  // ✅ شغّل Gate عند تغيير الرقم أو التاريخ
  getFieldEl(form, "animalNumber")?.addEventListener("change", runGateOnly);
  getFieldEl(form, "eventDate")?.addEventListener("change", runGateOnly);

  // ✅ وقت الحفظ: ممنوع لو مقفول… وإلا نفذ Full validation ثم اطلق mbk:valid
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (form.dataset.locked === "1") return;

   const ok = await runFullValidationAndDispatch();

    if (!ok) return;
  });
}

/* ===================== add-animal watcher (كما هو) ===================== */
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

function autoAttach() {
  document
    .querySelectorAll('form[data-validate="true"][data-event]')
    .forEach(attachOne);

  attachUniqueAnimalNumberWatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", autoAttach);
} else {
  autoAttach();
}

export { autoAttach };
