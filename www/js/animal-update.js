// www/js/animal-update.js — النسخة النهائية مع إعادة تفعيل اللبن اليومي فقط
//---------------------------------------------------------
import { db } from "/js/firebase-config.js";
import {
  collection,
  query,
  where,
  limit,
  getDocs,
  setDoc,
  doc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export async function updateAnimalByEvent(ev) {
  try {
    const tenant = (ev.userId || "").trim();
    const num    = (ev.animalId || ev.animalNumber || "").trim();

    if (!tenant || !num) {
      console.warn("⛔ updateAnimalByEvent: missing tenant or number");
      return;
    }

    const date = ev.eventDate;
    const upd = {};

    // ============================================================
    // 🟩 DAILY MILK — إنتاج اللبن اليومي (نُبقي عليه)
    // ============================================================
    if (ev.type === "daily_milk") {
      upd.productionStatus = "milking"; // الحيوان بيحلب
      upd.lastMilkDate     = date;       // آخر يوم تسجيل
      upd.dailyMilk        = Number(ev.milkKg) || null; // قيمة اللبن
    }

    // ============================================================
    // 🟩 CALVING — ولادة
    // ============================================================
    if (ev.type === "calving") {
      upd.lastCalvingDate     = date;
      upd.reproductiveStatus  = "ولدت";
      upd.productionStatus    = "fresh";
      upd.daysInMilk          = 0;
      upd.lactationNumber     = Number(ev.lactationNumber) || undefined;
    }

    // ============================================================
    // 🟩 CLOSE-UP — تحضير للولادة
    // ============================================================
    if (ev.type === "close_up" || ev.eventType === "تحضير ولادة") {
      upd.lastCloseUpDate    = date;
      upd.reproductiveStatus = "تحضير ولادة";
    }

    // ============================================================
    // 🟩 HEAT — شياع
    // ============================================================
    if (ev.type === "heat" || ev.eventType === "شياع") {
      upd.lastHeatDate       = date;
      upd.reproductiveStatus = "شياع";
    }

    // ============================================================
    // 🟩 INSEMINATION — تلقيح
    // ============================================================
    if (ev.type === "insemination") {
      upd.lastInseminationDate = date;
      upd.reproductiveStatus   = "ملقح";
      upd.servicesCount        = ev.servicesCount ?? null;
    }

    // ============================================================
    // 🟩 PREGNANCY DIAGNOSIS — تشخيص حمل
    // ============================================================
    if (ev.type === "pregnancy_diagnosis") {
      upd.lastDiagnosisDate   = date;
      upd.lastDiagnosisResult = ev.result;
      upd.reproductiveStatus  = (ev.result === "عشار" ? "عشار" : "فارغ");
    }

    // ============================================================
    // 🟩 ABORTION — إجهاض
    // ============================================================
    if (ev.type === "abortion") {
      upd.lastAbortionDate   = date;
      upd.reproductiveStatus = "فارغ";
    }

    // ============================================================
    // ❌ لا نحدّث الوثيقة لهذه الأحداث:
    //    - التغذية Nutrition
    //    - BCS
    //    - Feces
    //    - وزن
    //    - أي كاميرا
    // ============================================================

    if (Object.keys(upd).length === 0) {
      console.warn("⚠️ No animal fields to update for event:", ev.type);
      return;
    }

    // ------------------------------------------------------
    // 🔥 البحث عن الحيوان
    // ------------------------------------------------------
    const q = query(
      collection(db, "animals"),
      where("userId", "==", tenant),
      where("number", "==", String(num)),
      limit(5)
    );

    const snap = await getDocs(q);
    if (snap.empty) {
      console.warn("⛔ animal not found for update:", num);
      return;
    }

    // ------------------------------------------------------
    // 🔥 الكتابة (merge: true)
    // ------------------------------------------------------
    for (const d of snap.docs) {
      await setDoc(doc(db, "animals", d.id), upd, { merge: true });
      console.log("🔥 animal updated:", d.id, upd);
    }

  } catch (e) {
    console.error("updateAnimalByEvent error:", e);
  }
}
