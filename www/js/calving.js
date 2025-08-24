import { eventCore } from "./event-core.js";

document.addEventListener("DOMContentLoaded", () => {
  const ctx = window.getAnimalFromContext?.() || {};
  console.log("📌 Calving context:", ctx);

  const animalIdInput  = document.querySelector("#animalId");
  const eventDateInput = document.querySelector("#eventDate");
  if (animalIdInput && ctx.animalId)  animalIdInput.value  = ctx.animalId;
  if (eventDateInput && ctx.eventDate) eventDateInput.value = ctx.eventDate;

  const form = document.querySelector("#calvingForm");
  if (!form) return;

  // 🟢 الهاندلر
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = {
      animalId: animalIdInput?.value || ctx.animalId || "",
      eventDate: eventDateInput?.value || ctx.eventDate || "",
      notes: form.querySelector("#notes")?.value || ""
    };

    try {
      await eventCore.save("calving", payload);
      alert("✅ تم حفظ حدث الولادة بنجاح");
      window.location.href = "cow-card.html?animalId=" + payload.animalId;
    } catch (err) {
      console.error("❌ خطأ أثناء الحفظ:", err);
      alert("⚠️ حدث خطأ أثناء الحفظ");
    }
  });
});
