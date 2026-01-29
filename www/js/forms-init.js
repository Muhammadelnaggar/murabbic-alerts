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
  bar.className = "infobar show " + (type === "error" ? "error" : type === "ok" ? "success" : "info");
  bar.style.borderColor = type === "error" ? "#ef9a9a" : "#bbf7d0";
  bar.style.background = type === "error" ? "#ffebee" : "#ecfdf5";
  bar.style.color = type === "error" ? "#b71c1c" : "#065f46";

  const html = Array.isArray(msgs)
    ? `<ul style="margin:0;padding-left:18px">${msgs
        .map((m) => `<li>${String(m || "")}</li>`)
        .join("")}</ul>`
    : `<div>${String(msgs || "")}</div>`;

  bar.innerHTML = html;
  try { bar.scrollIntoView({ behavior:"smooth", block:"start" }); } catch(_) {}

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
        try { a.onClick && a.onClick(); } catch(_) {}
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

  if (!el || !el.parentNode) return null;

  const box = document.createElement("div");
  box.className = "mbk-field-error";
  box.style.cssText = "margin:6px 0 6px; padding:8px 10px; border-radius:10px; background:#ffebee; border:1px solid #ef9a9a; color:#b71c1c; font: 13px/1.4 system-ui,'Cairo',Arial;";
  box.textContent = String(msg || "خطأ في هذا الحقل.");

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
      try { unsub && unsub(); } catch(_) {}
      res(u?.uid || "");
    });
  });
}

function normalizeDigits(number) {
  const map = {
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4","٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
    "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4","۵": "5","۶": "6","۷": "7","۸": "8","۹": "9"
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

/* ===================== Data: Collect (Robust) ===================== */
function readFieldValue(form, el) {
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();

  if (type === "radio") {
    const name = el.getAttribute("name");
    if (!name) return "";
    const checked = form.querySelector(
      `input[type="radio"][name="${CSS.escape(name)}"]:checked`
    );
    return checked ? String(checked.value || "").trim() : "";
  }

  if (type === "checkbox") return !!el.checked;
  if (tag === "select") return String(el.value || "").trim();
  return String(el.value || "").trim();
}

function collectFormData(form) {
  const data = {};
  const fields = Array.from(form.querySelectorAll("[data-field]"));

  for (const el of fields) {
    const key = el.getAttribute("data-field");
    if (!key) continue;

    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "radio" && key in data) continue;

    data[key] = readFieldValue(form, el);
  }

  if (!data.species && localStorage.getItem("herdSpecies")) {
    data.species = localStorage.getItem("herdSpecies");
  }

  return data;
}

/* ===================== Animal Gate ===================== */
async function fetchAnimalByNumberForUser(uid, number) {
  const num = normalizeDigits(number);
  if (!uid || !num) return null;

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

async function fetchCalvingSignalsFromEvents(uid, number) {
  const num = String(normalizeDigits(number || "")).trim();

  if (!uid || !num) {
    return { reproStatusFromEvents: "", lastBoundary: "", lastBoundaryType: "" };
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
  let lastBoundaryType = "";

  for (const ev of arr) {
    const type = String(ev.eventType || ev.type || "").trim();
    const res  = String(ev.result || ev.status || "").trim();
    const dt   = String(ev.eventDate || "").trim();

    if ((type === "ولادة" || type === "إجهاض") && !lastBoundary) {
      lastBoundary = dt;
      lastBoundaryType = type;
      if (!reproStatusFromEvents) reproStatusFromEvents = "مفتوحة";
      continue;
    }

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

  const lastAIEl = getFieldEl(form, "lastInseminationDate");
  const lastAI = String(animal?.data?.lastInseminationDate || "").trim();
  if (lastAIEl && lastAI && !lastAIEl.value) lastAIEl.value = lastAI;
}

async function ensureAnimalExistsGate(form, bar) {
  if (!localStorage.getItem("userId") && !auth?.currentUser) {
    showMsg(bar, "سجّل الدخول أولًا.", "error");
    return false;
  }

  const uid = await getUid();
  const numEl = getFieldEl(form, "animalNumber");
  const n = normalizeDigits(numEl?.value || "");

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

  showMsg(bar, "جارِ التحقق من رقم الحيوان…", "info");
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

  function lockForm(locked) {
    form.dataset.locked = locked ? "1" : "0";
    form.querySelectorAll("input, select, textarea, button").forEach((el) => {
      const key = el.id || el.getAttribute("data-field") || "";
      if (key === "animalNumber" || key === "eventDate") return;
      el.disabled = !!locked;
    });
  }

  lockForm(true);

  async function runGateOnly() {
    const n = normalizeDigits(getFieldEl(form, "animalNumber")?.value || "");
    const d = String(getFieldEl(form, "eventDate")?.value || "").trim();
    clearFieldErrors(form);

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

    if (eventName === "ولادة") {
      if (typeof guards?.calvingDecision !== "function") {
        showMsg(bar, "❌ تعذّر تحميل قواعد التحقق (calvingDecision). حدّث الصفحة أو راجع form-rules.js", "error");
        lockForm(true);
        return false;
      }

      const uid = await getUid();
      const sig = await fetchCalvingSignalsFromEvents(uid, n);

      const doc = form.__mbkDoc || {};
      const docSpecies = String(doc.species || doc.animalTypeAr || "").trim();

      let sp = String(getFieldEl(form, "species")?.value || "").trim() || docSpecies;
      if (/cow|بقر/i.test(sp)) sp = "أبقار";
      if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

      const reproFromEvents = String(sig.reproStatusFromEvents || "").trim();
      const reproFromDoc = String(doc.reproductiveStatus || "").trim();
      const repro = reproFromEvents || reproFromDoc || "";

      const lastAI = String(doc.lastInseminationDate || "").trim();

      const gateData = {
        animalNumber: n,
        eventDate: d,
        animalId: form.__mbkAnimalId || "",
        species: sp,
        documentData: doc,
        reproductiveStatus: repro,
        reproStatusFromEvents: reproFromEvents,
        lastInseminationDate: lastAI,
        lastBoundary: String(sig.lastBoundary || "").trim(),
        lastBoundaryType: String(sig.lastBoundaryType || "").trim()
      };

      const g = guards.calvingDecision(gateData);

      if (g) {
        const errs = [String(g)];
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

    showMsg(bar, "✅ التحقق صحيح — يمكنك إدخال البيانات", "info");
    lockForm(false);
    return true;
  }

  async function runFullValidationAndDispatch() {
    const n = normalizeDigits(getFieldEl(form, "animalNumber")?.value || "");
    const d = String(getFieldEl(form, "eventDate")?.value || "").trim();

    if (!n || !d) {
      showMsg(bar, "أدخل رقم الحيوان وتاريخ الحدث أولًا.", "error");
      lockForm(true);
      return false;
    }

    const okAnimal = await ensureAnimalExistsGate(form, bar);
    if (!okAnimal) {
      lockForm(true);
      return false;
    }

    const formData = collectFormData(form);
    formData.documentData = form.__mbkDoc || null;
    if (!formData.animalId && form.__mbkAnimalId) formData.animalId = form.__mbkAnimalId;
        // ✅ Auto-calc للإجهاض: يحسب عمر الإجهاض + السبب من آخر تلقيح (من الوثيقة)
    if (eventName === "إجهاض") {
      const doc = formData.documentData || {};
      const lastAI = String(formData.lastInseminationDate || doc.lastInseminationDate || "").slice(0,10);
      const evDate = String(formData.eventDate || "").slice(0,10);

      formData.lastInseminationDate = lastAI;
      if (!formData.species) formData.species = String(doc.species || doc.animalTypeAr || "").trim();

      let months = "";
      let cause = "";

      if (lastAI && evDate) {
        const d1 = new Date(lastAI);
        const d2 = new Date(evDate);
        if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
          const m = Math.max(0, (d2 - d1) / (1000*60*60*24*30.44));
          months = Number.isFinite(m) ? Number(m.toFixed(1)) : "";
          cause = (months !== "" && months >= 6) ? "احتمال بروسيلا (≥6 شهور)" : "احتمال BVD (<6 شهور)";
        }
      }

      formData.abortionAgeMonths = months;
      formData.probableCause = cause;

      // ✅ اكتبهم في الحقول (بدون ما يعتمد على سكربت الصفحة)
      const ageEl = document.getElementById("abortionAgeMonths");
      const causeEl = document.getElementById("probableCause");
      if (ageEl) ageEl.value = months === "" ? "" : String(months);
      if (causeEl) causeEl.value = cause || "";
    }

    if (eventName === "ولادة") {
      const uid = await getUid();
      const kind = String(formData.calvingKind || "").trim();

      if (kind !== "نافقة") {
        const count = parseInt(String(formData.calfCount || "1"), 10) || 1;

        const calfNums = [
          String(formData.calfId || "").trim(),
          count >= 2 ? String(formData.calf2Id || "").trim() : "",
          count >= 3 ? String(formData.calf3Id || "").trim() : ""
        ].filter(Boolean);

        if (calfNums.length) {
          try {
            const chk = await uniqueCalfNumbers({ userId: uid, calfNumbers: calfNums });
            if (!chk || chk.ok === false) {
              clearFieldErrors(form);
              showMsg(bar, (chk && chk.msg) ? chk.msg : "⚠️ رقم عجل مكرر في حسابك.", "error");
              lockForm(false);
              return false;
            }
          } catch (err) {
            console.error("uniqueCalfNumbers failed:", err);
            clearFieldErrors(form);
            showMsg(bar, "تعذّر التحقق من تكرار أرقام العجول الآن. جرّب مرة أخرى.", "error");
            lockForm(false);
            return false;
          }
        }
      }
    }
    // ✅ 1) Validation المركزي لكل الأحداث (إجهاض/تلقيح/تشخيص/…)
    const v = validateEvent(eventName, formData);

    if (!v || v.ok === false) {
      clearFieldErrors(form);

      // Inline field errors
      if (v?.fieldErrors && typeof v.fieldErrors === "object") {
        for (const [fname, msg] of Object.entries(v.fieldErrors)) {
          placeFieldError(form, fname, msg);
        }
        scrollToFirstFieldError(form);
      }

      // رسائل أعلى النموذج
      const topMsgs =
        (Array.isArray(v?.guardErrors) && v.guardErrors.length) ? v.guardErrors :
        (Array.isArray(v?.errors) && v.errors.length) ? v.errors :
        ["❌ البيانات غير صحيحة — راجع الحقول."];

      showMsg(bar, topMsgs, "error");
      lockForm(false);
      return false;
    }

    form.dispatchEvent(
      new CustomEvent("mbk:valid", {
        bubbles: true,
        detail: { formData, eventName, form }
      })
    );
    return true;
  }

  // ✅ Gate startup watcher
  let gateStarted = false;
  const watcher = setInterval(() => {
    if (gateStarted) return;

    const n = getFieldEl(form, "animalNumber")?.value?.trim();
    const d = getFieldEl(form, "eventDate")?.value?.trim();

    if (n && d) {
      gateStarted = true;
      clearInterval(watcher);
      runGateOnly();
    }
  }, 120);

  // ✅ هنا الإصلاح الحقيقي: input + change (خصوصًا للتاريخ)
  const numEl = getFieldEl(form, "animalNumber");
  const dateEl = getFieldEl(form, "eventDate");

  ["input", "change"].forEach(evt => {
    numEl?.addEventListener(evt, runGateOnly);
    dateEl?.addEventListener(evt, runGateOnly);
  });

  // ✅ submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // بدل الصمت: لو لسه مقفول
    if (form.dataset.locked === "1") {
      showMsg(bar, "⚠️ أكمل إدخال رقم الحيوان والتاريخ وانتظر التحقق الأخضر أولًا.", "error");
      return;
    }

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
