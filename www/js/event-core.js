// js/event-core.js

// --- تتبع موحد ---
window.dataLayer = window.dataLayer || [];
window.t = window.t || {
  event: function (name, params) {
    window.dataLayer.push({ event: name, ...params });
    console.log("Tracked:", name, params);
  }
};

// --- استخراج السياق (animalId, date, وغيرها) ---
function getContext() {
  const qs = new URLSearchParams(location.search);

  const ctx = {
    animalId:
      qs.get("animalId") ||
      qs.get("number") ||
      qs.get("animalNumber") ||
      localStorage.getItem("lastAnimalId") ||
      localStorage.getItem("currentAnimalId") ||
      sessionStorage.getItem("ctxAnimalId") ||
      "",
    date:
      qs.get("date") ||
      qs.get("eventDate") ||
      localStorage.getItem("lastEventDate") ||
      localStorage.getItem("eventDate") ||
      sessionStorage.getItem("ctxDate") ||
      new Date().toISOString().slice(0, 10)
  };

  if (ctx.animalId) {
    localStorage.setItem("lastAnimalId", ctx.animalId);
    localStorage.setItem("currentAnimalId", ctx.animalId);
    sessionStorage.setItem("ctxAnimalId", ctx.animalId);
  }
  if (ctx.date) {
    localStorage.setItem("lastEventDate", ctx.date);
    localStorage.setItem("eventDate", ctx.date);
    sessionStorage.setItem("ctxDate", ctx.date);
  }

  return ctx;
}

// --- حفظ حدث موحد ---
async function saveEvent(payload) {
  try {
    const userId = localStorage.getItem("userId");
    const tenantId = localStorage.getItem("tenantId");

    // تأكيد الحقول الأساسية
    if (!payload.animalId) payload.animalId = localStorage.getItem("lastAnimalId") || "";
    if (!payload.eventDate) payload.eventDate = new Date().toISOString().slice(0, 10);

    const enriched = {
      ...payload,
      userId,
      tenantId,
      createdAt: new Date().toISOString()
    };

    // تتبع
    t.event("event_save", enriched);

    // إرسال للسيرفر
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enriched)
    });

    if (!res.ok) throw new Error("خطأ في الحفظ");

    // تنبيه نجاح (مع fallback)
    if (typeof smartAlerts !== "undefined") {
      smartAlerts.show("✅ تم تسجيل الحدث بنجاح", { type: "success" });
    } else {
      alert("✅ تم تسجيل الحدث بنجاح");
    }

    if (enriched.animalId) localStorage.setItem("lastAnimalId", enriched.animalId);
    if (enriched.eventDate) localStorage.setItem("lastEventDate", enriched.eventDate);

    return true;
  } catch (err) {
    console.error("فشل حفظ الحدث:", err);

    if (typeof smartAlerts !== "undefined") {
      smartAlerts.show("❌ حدث خطأ أثناء الحفظ", { type: "error" });
    } else {
      alert("❌ حدث خطأ أثناء الحفظ");
    }

    return false;
  }
}
