const getContext = window.getContext;

window.eventCore = {
  /**
   * حفظ حدث موحّد
   * @param {string} eventType - نوع الحدث (بالعربي: "تلقيح" / "لبن يومي" / "عرج" ...)
   * @param {object} extra - بيانات إضافية خاصة بالحدث
   */
  async save(eventType, extra = {}) {
    const ctx = getContext();

    // بناء الـpayload
    const payload = {
      userId: ctx.userId,
      tenantId: ctx.tenantId || ctx.userId,
      animalId: ctx.animalId || null,
      animalNumber: ctx.animalNumber || null,
      eventType: eventType,      // لازم بالعربي
      eventDate: ctx.eventDate,
      ...extra,
      createdAt: new Date().toISOString()
    };

    // 🔹 تتبع قبل الحفظ
    window.dataLayer = window.dataLayer || [];
    t?.event("event_save", {
      page: location.pathname,
      eventType: payload.eventType,
      animalId: payload.animalId,
      eventDate: payload.eventDate
    });

    // 🟢 لوجات ديباج
    console.log("🚀 getContext() = ", ctx);
    console.log("🚀 Payload to save:", payload);

    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": ctx.userId
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(`فشل حفظ الحدث (${eventType})`);
      }

      const data = await res.json();
      console.log(`✅ تم حفظ حدث (${eventType}):`, data);

      // 🔹 تتبع نجاح الحفظ
      t?.event("event_saved_success", {
        page: location.pathname,
        eventType: payload.eventType,
        animalId: payload.animalId,
        eventDate: payload.eventDate
      });

      return data;

    } catch (err) {
      console.error("❌ خطأ أثناء الحفظ:", err);

      // 🔹 تتبع فشل الحفظ
      t?.event("event_saved_error", {
        page: location.pathname,
        eventType: eventType,
        error: err.message
      });

      alert("حدث خطأ أثناء الحفظ");
      throw err;
    }
  }
};
