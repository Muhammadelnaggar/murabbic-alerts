// /js/calving.js

document.addEventListener("DOMContentLoaded", () => {
  // 1) قراءة السياق (animalId + date) من event-core.js
  const ctx = window.getAnimalFromContext?.() || {};
  console.log("📌 Calving context:", ctx);

  // 2) تخزين آخر قيم (fallback لو الصفحة تفتحت مباشرة)
  if (ctx.animalId) localStorage.setItem("lastAnimalId", ctx.animalId);
  if (ctx.eventDate) localStorage.setItem("lastEventDate", ctx.eventDate);

  // 3) ملء الحقول في النموذج
  document.querySelector("#animalId")?.setAttribute("value", ctx.animalId);
  document.querySelector("#eventDate")?.setAttribute("value", ctx.eventDate);

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
