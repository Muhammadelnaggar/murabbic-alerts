// /js/forms-init.js — ESM (Central Gate + Validation)
// ✅ يتحقق من وجود الحيوان أولًا (ويمنع ملء باقي الحقول حتى يثبت وجوده)
// ✅ يجمع [data-field] ويُظهر رسائل في infobar أعلى النموذج
// ✅ عند النجاح يطلق "mbk:valid" ويحمل البيانات في detail.formData

import { validateEvent, uniqueAnimalNumber } from "./form-rules.js";
import { db, auth } from "./firebase-config.js";
import { collection, query, where, limit, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

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
  bar.style.background   = type === "error" ? "#ffebee" : "#ecfdf5";
  bar.style.color        = type === "error" ? "#b71c1c" : "#065f46";

  const html = Array.isArray(msgs)
    ? `<ul style="margin:0;padding-left:18px">${msgs.map(m=>`<li>${String(m||"")}</li>`).join("")}</ul>`
    : `<div>${String(msgs || "")}</div>`;

  bar.innerHTML = html;

  if (Array.isArray(actions) && actions.length) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:10px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;";

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
      btn.addEventListener("click", () => { try { a.onClick && a.onClick(); } catch(_){} });
      wrap.appendChild(btn);
    });

    bar.appendChild(wrap);
  }
}


/* ===================== Helpers ===================== */
async function getUid() {
  if (auth?.currentUser?.uid) return auth.currentUser.uid;

  return await new Promise((res) => {
    const unsub = onAuthStateChanged(auth, (u) => {
      unsub && unsub();
      res(u?.uid || "");
    });
  });
}

function normalizeDigits(number) {
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9"
  };
  return String(number || "")
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g, "")
    .replace(/[٠-٩۰-۹]/g, (d) => map[d]);
}

function setFormInputsDisabled(form, disabled, allowIds = []) {
  const allow = new Set(allowIds.filter(Boolean));
  form.querySelectorAll("input, select, textarea, button").forEach((el) => {
    if (allow.has(el.id)) return;
    if (allow.has(el.getAttribute("data-field"))) return;
    el.disabled = !!disabled;
  });
}

function getFieldEl(form, name) {
  return (
    form.querySelector(`[data-field="${name}"]`) ||
    form.querySelector(`#${name}`) ||
    null
  );
}

/* ===================== Data: Collect ===================== */
function collectFormData(form) {
  const data = {};
  form.querySelectorAll("[data-field]").forEach((el) => {
    const k = el.getAttribute("data-field");
    let v =
      el.type === "checkbox"
        ? (el.checked ? (el.value || true) : "")
        : el.type === "radio"
          ? (el.checked ? el.value : (data[k] || ""))
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

  try {
    const key = `${uid}#${num}`;
    const q1 = query(collection(db, "animals"), where("userId_number", "==", key), limit(1));
    const s1 = await getDocs(q1);
    if (!s1.empty) {
      const d = s1.docs[0];
      return { id: d.id, data: d.data() || {} };
    }
  } catch (_) {}

const tries = [
  ["number", num],
  ["animalNumber", num],
  ["animalNumber", Number(num)],
].filter(t => !(typeof t[1] === "number" && Number.isNaN(t[1])));

  

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
}

async function ensureAnimalExistsGate(form, bar) {
  const uid = await getUid();
  const numEl = getFieldEl(form, "animalNumber");
  const n = normalizeDigits(numEl?.value || "");

  if (!uid) {
    applyAnimalToForm(form, null);
    showMsg(bar, "سجّل الدخول أولًا.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ["animalNumber"]);
    return false;
  }

  if (!n) {
    applyAnimalToForm(form, null);
    bar.style.display = "none";
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ["animalNumber"]);
    return false;
  }

  if (form.__mbkLastCheckedNumber === n && form.dataset.animalOk === "1") {
    return true;
  }

  form.__mbkLastCheckedNumber = n;
  form.dataset.animalOk = "0";
  applyAnimalToForm(form, null);

  showMsg(bar, "جارِ التحقق من رقم الحيوان…", "ok");
  setFormInputsDisabled(form, true, ["animalNumber"]);

  const animal = await fetchAnimalByNumberForUser(uid, n);
  if (!animal) {
    showMsg(bar, "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ["animalNumber"]);
    return false;
  }

  const st = String(animal.data?.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    showMsg(bar, "❌ هذا الحيوان خارج القطيع (بيع/نفوق/استبعاد) — لا يمكن تسجيل أحداث له.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ["animalNumber"]);
    return false;
  }

  applyAnimalToForm(form, animal);
  form.dataset.animalOk = "1";
  setFormInputsDisabled(form, false, ["animalNumber"]);
  showMsg(bar, "✅ تم العثور على الحيوان — أكمل البيانات.", "ok");
  return true;
}

/* ===================== Attach ===================== */
function attachOne(form) {
  const bar = ensureInfoBar(form);
  const eventName = form.getAttribute("data-event");
  if (!eventName) return;

  setFormInputsDisabled(form, true, ["animalNumber"]);

  const numEl = getFieldEl(form, "animalNumber");
  if (numEl) {
    const kick = async () => {
      await ensureAnimalExistsGate(form, bar);
    };
    numEl.addEventListener("change", kick);
    numEl.addEventListener("blur", kick);
    numEl.addEventListener("input", () => {
      form.dataset.animalOk = "0";
      applyAnimalToForm(form, null);
      setFormInputsDisabled(form, true, ["animalNumber"]);
      bar.style.display = "none";
    });
  }

  setTimeout(() => {
    if (numEl && normalizeDigits(numEl.value)) {
      ensureAnimalExistsGate(form, bar);
    }
  }, 0);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const okAnimal = await ensureAnimalExistsGate(form, bar);
    if (!okAnimal) return;

    const formData = collectFormData(form);
    formData.documentData = form.__mbkDoc || null;
    if (!formData.animalId && form.__mbkAnimalId) formData.animalId = form.__mbkAnimalId;

    const { ok, errors } = validateEvent(eventName, formData);

if (!ok) {
  const isCalving = (eventName === "ولادة");

  const hasAbortHint = Array.isArray(errors) && errors.some(e =>
    String(e || "").includes("انتقل لتسجيل «إجهاض»") ||
    String(e || "").includes("تسجيل «إجهاض»")
  );

  // زر الإجهاض يظهر فقط لو الخطأ فعلاً عمر حمل أقل من الحد
  if (isCalving && hasAbortHint) {
    const n = normalizeDigits((getFieldEl(form, "animalNumber")?.value || ""));
    let d = String(getFieldEl(form, "eventDate")?.value || "").trim();
    if (!d) d = new Date().toISOString().slice(0, 10);

    showMsg(bar, errors, "error", [
      {
        label: "نعم — تسجيل إجهاض",
        primary: true,
        onClick: () => {
          const url = `/abortion.html?number=${encodeURIComponent(n)}&date=${encodeURIComponent(d)}`;
          location.href = url;
        }
      },
      {
        label: "لا — تعديل التاريخ",
        onClick: () => {
          const el = getFieldEl(form, "eventDate");
          el?.focus?.();
          el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        }
      }
    ]);
  } else {
    showMsg(bar, errors, "error");
  }

  form.dataset.valid = "0";
  return;
}



    form.dataset.valid = "1";
    showMsg(bar, "✅ البيانات سليمة — جاري الحفظ...", "ok");

    const ev = new CustomEvent("mbk:valid", { detail: { formData, eventName, form } });
    form.dispatchEvent(ev);
  });
}

/* ===================== add-animal watcher (كما هو) ===================== */
function attachUniqueAnimalNumberWatcher() {
  const form  = document.getElementById("animalForm");
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
