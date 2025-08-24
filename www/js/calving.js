// /js/calving.js

document.addEventListener("DOMContentLoaded", () => {
  // 1) قراءة السياق (animalId + date) من event-core.js
  const ctx = window.getAnimalFromContext?.() || {};
  console.log("📌 Calving context:", ctx);// /js/calving.js

document.addEventListener("DOMContentLoaded", () => {
  // 1) قراءة السياق من event-core.js
  const ctx = window.getAnimalFromContext?.() || {};
  console.log("📌 Calving context:", ctx);

  // 2) تأكيد إن عندنا animalId و date (من add-event)
  if (ctx.animalId) {
    localStorage.setItem("lastAnimalId", ctx.animalId);
    document.querySelector("#animalId")?.setAttribute("value", ctx.animalId);
  }

  if (ctx.eventDate) {
    localStorage.setItem("lastEventDate", ctx.eventDate);
    document.querySelector("#eventDate")?.setAttribute("value", ctx.eventDate);
  }

  // 3) حفظ النموذج عند الضغط على زر الحفظ
  const form = document.querySelector("#calvingForm");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const payload = {
        eventType: "ولادة",
        animalId: ctx.animalId,
        eventDate: ctx.eventDate,   // 👈 دايمًا اللي جاي من add-event
        notes: form.querySelector("#notes")?.value || "",
        createdAt: new Date().toISOString(),
        source: "calving.html"
      };

      console.log("📦 Calving payload:", payload);

      try {
        const res = await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          alert("✅ تم حفظ حدث الولادة بنجاح");
          window.location.href = "cow-card.html?animalId=" + ctx.animalId;
        } else {
          alert("⚠️ حدث خطأ أثناء الحفظ");
        }
      } catch (err) {
        console.error("❌ Calving save error:", err);
        alert("❌ تعذر الاتصال بالسيرفر");
      }
    });
  }
});


  // 2) تخزين آخر قيم (fallback لو الصفحة تفتحت مباشرة)
  if (ctx.animalId) localStorage.setItem("lastAnimalId", ctx.animalId);
  if (ctx.eventDate) localStorage.setItem("lastEventDate", ctx.eventDate);

  // 3) ملء الحقول في النموذج
 // ✅ ملء رقم الحيوان
const animalIdInput = document.querySelector("#animalId");
if (animalIdInput && ctx.animalId) {
  animalIdInput.value = ctx.animalId;
}

// ✅ ملء تاريخ الولادة
const eventDateInput = document.querySelector("#eventDate");
if (eventDateInput && ctx.eventDate) {
  eventDateInput.value = ctx.eventDate;  // 👈 دي اللي هتظهر التاريخ جوه input
}


  // 4) حفظ النموذج عند الضغط على زر الحفظ
  const form = document.querySelector("#calvingForm");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const payload = {
        eventType: "ولادة",
        animalId: ctx.animalId,
        eventDate: ctx.eventDate || new Date().toISOString().slice(0, 10),
        notes: form.querySelector("#notes")?.value || "",
        createdAt: new Date().toISOString(),
        source: "calving.html"
      };

      console.log("📦 Calving payload:", payload);

      try {
        const res = await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          alert("✅ تم حفظ حدث الولادة بنجاح");
          window.location.href = "cow-card.html?animalId=" + ctx.animalId;
        } else {
          alert("⚠️ حدث خطأ أثناء الحفظ");
        }
      } catch (err) {
        console.error("❌ Calving save error:", err);
        alert("❌ تعذر الاتصال بالسيرفر");
      }
    });
  }
});
