// www/js/animal-update.js — النسخة النهائية بعد دعم "ولادة" بالعربي
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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export async function updateAnimalByEvent(ev) {
  try {
    // ✅ المالك + رقم الحيوان (نفضّل animalNumber ثم number)
    const tenant = (ev.userId || "").toString().trim();
    const num = (
      ev.animalNumber ||
      ev.number ||
      ev.animalId ||           // احتياطي لو اتخزّن فيه الرقم
      ""
    ).toString().trim();

    if (!tenant || !num) {
      console.warn("⛔ updateAnimalByEvent: missing tenant or number", {
        tenant,
        num,
        ev
      });
      return;
    }

    const date = ev.eventDate;
    const upd  = {};

    // ============================================================
    // ✅ تطبيع نوع الحدث (عربي / إنجليزي) إلى نوع واحد قياسي
    // ============================================================
    const rawType = (
      ev.normalizedType ||
      ev.eventType ||
      ev.type ||
      ""
    ).toString().trim();

    let type;
    switch (rawType) {
      // لبن يومي
      case "daily_milk":
      case "لبن":
      case "لبن يومي":
      case "اللبن اليومي":
        type = "daily_milk";
        break;

      // ولادة
      case "calving":
      case "ولادة":
        type = "calving";
        break;

      // تحضير للولادة
      case "close_up":
      case "تحضير ولادة":
      case "تحضير للولادة":
        type = "close_up";
        break;

      // شياع
      case "heat":
      case "شياع":
        type = "heat";
        break;

      // تلقيح
      case "insemination":
      case "تلقيح":
      case "تلقيح مخصب":
        type = "insemination";
        break;

      // تشخيص حمل
      case "pregnancy_diagnosis":
      case "تشخيص حمل":
        type = "pregnancy_diagnosis";
        break;

      // إجهاض
      case "abortion":
      case "إجهاض":
        type = "abortion";
        break;

      default:
        type = rawType; // احتياطي لو فيه أنواع تانية
    }

    // ============================================================
    // 🟩 DAILY MILK — إنتاج اللبن اليومي
    // ============================================================
    if (type === "daily_milk") {
      upd.productionStatus = "milking";               // الحيوان بيحلب
      upd.lastMilkDate     = date;                    // آخر يوم تسجيل
      upd.dailyMilk        = Number(ev.milkKg) || null; // قيمة اللبن
    }

    // ============================================================
    // 🟩 CALVING — ولادة
    // ============================================================
    if (type === "calving") {
      upd.lastCalvingDate    = date;
      upd.reproductiveStatus = "حديث الولادة";
      upd.productionStatus   = "fresh";
      upd.daysInMilk         = 0;
      if (ev.lactationNumber != null) {
        upd.lactationNumber = Number(ev.lactationNumber) || undefined;
      }
    }

    // ============================================================
    // 🟩 CLOSE-UP — تحضير للولادة
    // ============================================================
    if (type === "close_up") {
      upd.lastCloseUpDate    = date;
      upd.reproductiveStatus = "تحضير ولادة";
    }

    // ============================================================
    // 🟩 HEAT — شياع
    // ============================================================
    if (type === "heat") {
      upd.lastHeatDate       = date;
      upd.reproductiveStatus = "شياع";
    }

    // ============================================================
    // 🟩 INSEMINATION — تلقيح
    // ============================================================
    if (type === "insemination") {
      upd.lastInseminationDate = date;
      upd.reproductiveStatus   = "ملقح";
      if (ev.servicesCount != null) {
        upd.servicesCount = ev.servicesCount;
      }
    }

    // ============================================================
    // 🟩 PREGNANCY DIAGNOSIS — تشخيص حمل
    // ============================================================
    if (type === "pregnancy_diagnosis") {
      upd.lastDiagnosisDate   = date;
      upd.lastDiagnosisResult = ev.result;
      upd.reproductiveStatus  = (ev.result === "عشار" ? "عشار" : "فارغ");
    }

    // ============================================================
    // 🟩 ABORTION — إجهاض
    // ============================================================
   if (type === "abortion") {
  upd.lastAbortionDate = date;

  const m = Number(ev.abortionAgeMonths);
  if (Number.isFinite(m)) {
    upd.reproductiveStatus = (m < 5) ? "مفتوحة" : "حديث الولادة";
    upd.productionStatus   = (m < 5) ? upd.productionStatus : "fresh";
  } else {
    // لو العمر مش متاح: نخليها "مفتوحة" كـ safe default
    upd.reproductiveStatus = "مفتوحة";
  }
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
      console.warn("⚠️ No animal fields to update for event:", type, ev);
      return;
    }

    // ------------------------------------------------------
    // 🔥 البحث عن الحيوان — نجرب number ثم animalNumber
    // ------------------------------------------------------
    const animalsRef = collection(db, "animals");

    let snap = await getDocs(
      query(
        animalsRef,
        where("userId", "==", tenant),
        where("number", "==", String(num)),
        limit(5)
      )
    );

    if (snap.empty) {
      // محاولة ثانية على animalNumber احتياطيًا
      snap = await getDocs(
        query(
          animalsRef,
          where("userId", "==", tenant),
          where("animalNumber", "==", String(num)),
          limit(5)
        )
      );
    }

    if (snap.empty) {
      console.warn("⛔ animal not found for update:", { tenant, num, ev });
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
