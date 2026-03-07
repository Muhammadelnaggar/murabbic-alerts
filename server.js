// ---------- تحديد نوع الحدث ----------
const rawType = String(event.type || event.eventType || "").toLowerCase();
const typeNorm = normalizeEventType(rawType);
const whenMs = Number(event.ts || Date.now());

// ---------- بناء الوثيقة ----------
let doc;

if (typeNorm === "nutrition") {

  doc = buildNutritionEventDoc(event, tenant, whenMs);

} else {

  doc = {
    ...event,

    userId: tenant,
    tenantId: tenant,

    animalId: String(event.animalId || event.animalNumber || ""),
    animalNumber: String(event.animalNumber || event.animalId || ""),

    type: typeNorm,
    eventTypeNorm: typeNorm,

    eventDate: String(event.eventDate || toYYYYMMDD(whenMs)),
    date: toYYYYMMDD(whenMs),

    createdAt: admin.firestore.Timestamp.fromMillis(whenMs)
  };

}

// ---------- حفظ الحدث ----------
try {

  await db.collection("events").add(cleanDeep(doc));

} catch (e) {

  console.error("events.save error:", e.message || e);

}
