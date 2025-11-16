// www/js/animal-update.js — Murabbik FINAL CLEAN EDITION
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

// ----------------------------------------------------------
//  تحديث وثيقة الحيوان بناءً على الأحداث الأساسية فقط
//  (ولادة – تلقيح – تشخيص حمل – إجهاض – تجفيف)
// ----------------------------------------------------------
export async function updateAnimalByEvent(ev) {
  try {
    const tenant = (ev.userId || "").trim();
    const num    = (ev.animalId || ev.animalNumber || "").trim();
    const date   = ev.eventDate;

    if (!tenant || !num || !date) {
      console.warn("⛔ updateAnimalByEvent: missing tenant / number / date");
      return;
    }

    const upd = {};

    // ------------------------------------------------------
    // 🟩 1) CALVING — ولادة
    // ------------------------------------------------------
    if (ev.type === "calving") {
      upd.lastCalvingDate    = date;
      upd.reproductiveStatus = "ولدت";
      upd.productionStatus   = "milking";
      upd.daysInMilk         = 0;
      if (ev.lactationNumber) upd.lactationNumber = Number(ev.lactationNumber);
    }

    // ------------------------------------------------------
    // 🟩 2) DRY-OFF — تجفيف
    // ------------------------------------------------------
    if (ev.type === "dry_off") {
      upd.productionStatus = "dry";
      // daysInMilk تتجمد عند يوم التجفيف
      if (ev.lastCalvingDate) {
        const diff = Math.floor(
          (new Date(date) - new Date(ev.lastCalvingDate)) / 86400000
        );
        upd.daysInMilk = diff >= 0 ? diff : null;
      }
    }

    // ------------------------------------------------------
    // 🟩 3) INSEMINATION — تلقيح
    // ------------------------------------------------------
    if (ev.type === "insemination") {
      upd.lastInseminationDate = date;
      upd.reproductiveStatus   = "ملقح";
      if (ev.servicesCount !== undefined)
        upd.servicesCount = ev.servicesCount;
    }

    // ------------------------------------------------------
    // 🟩 4) PREGNANCY DIAGNOSIS — تشخيص حمل
    // ------------------------------------------------------
    if (ev.type === "pregnancy_diagnosis") {
      upd.lastDiagnosisDate   = date;
      upd.lastDiagnosisResult = ev.result; // عشار / فارغة
      upd.reproductiveStatus  = (ev.result === "عشار") ? "عشار" : "فارغ";
    }

    // ------------------------------------------------------
    // 🟩 5) ABORTION — إجهاض
    // ------------------------------------------------------
    if (ev.type === "abortion") {
      upd.lastAbortionDate  = date;
      upd.reproductiveStatus = "فارغ";
    }

    // ------------------------------------------------------
    // ❌ 6) IGNORE — لا نحدّث وثيقة الحيوان من:
    //    - daily milk
    //    - nutrition
    //    - BCS camera
    //    - feces camera
    //    - weight camera
    // ------------------------------------------------------

    if (
      ev.type === "daily_milk" ||
      ev.type === "nutrition"  ||
      ev.type === "تغذية"     ||
      ev.type === "bcs_eval"   ||
      ev.type === "feces_eval" ||
      ev.type === "weight"
    ) {
      console.warn("ℹ️ هذا الحدث لا يحدّث وثيقة الحيوان:", ev.type);
    }

    // ------------------------------------------------------
    // لو مفيش تحديثات — خروج
    // ------------------------------------------------------
    if (Object.keys(upd).length === 0) {
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
      console.warn("⛔ animal not found:", num);
      return;
    }

    // ------------------------------------------------------
    // 🔥 كتابة التحديث
    // ------------------------------------------------------
    for (const d of snap.docs) {
      await setDoc(doc(db, "animals", d.id), upd, { merge: true });
      console.log("🔥 updated animal:", d.id, upd);
    }

  } catch (err) {
    console.error("updateAnimalByEvent error:", err);
  }
}
