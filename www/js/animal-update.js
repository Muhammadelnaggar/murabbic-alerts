// www/js/animal-update.js — Final Murabbik Stable Edition
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
//  تحديث وثيقة الحيوان بناءً على أي حدث
// ----------------------------------------------------------
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

    // ------------------------------------------------------
    //       🟩 1) DAILY MILK — إنتاج اللبن اليومي
    // ------------------------------------------------------
    if (ev.type === "daily_milk") {
      upd.productionStatus = "milking";
      upd.lastMilkDate     = date;
      upd.dailyMilk        = Number(ev.milkKg) || null;
    }

    // ------------------------------------------------------
    //       🟩 2) CALVING — ولادة
    // ------------------------------------------------------
    if (ev.type === "calving") {
      upd.lastCalvingDate     = date;
      upd.reproductiveStatus  = "ولدت";
      upd.productionStatus    = "fresh";   // أول أيام اللبن
      upd.daysInMilk          = 0;
      upd.lactationNumber     = Number(ev.lactationNumber) || undefined;
    }

    // ------------------------------------------------------
    //       🟩 3) INSEMINATION — تلقيح
    // ------------------------------------------------------
    if (ev.type === "insemination") {
      upd.lastInseminationDate = date;
      upd.reproductiveStatus   = "ملقح";
      upd.servicesCount        = (ev.servicesCount ?? null);
    }

    // ------------------------------------------------------
    //       🟩 4) PREGNANCY DIAGNOSIS — تشخيص حمل
    // ------------------------------------------------------
    if (ev.type === "pregnancy_diagnosis") {
      upd.lastDiagnosisDate    = date;
      upd.lastDiagnosisResult  = ev.result; // عشار / فارغة

      if (ev.result === "عشار") {
        upd.reproductiveStatus = "عشار";
      } else {
        upd.reproductiveStatus = "فارغ";
      }
    }

    // ------------------------------------------------------
    //       🟩 5) ABORTION — إجهاض
    // ------------------------------------------------------
    if (ev.type === "abortion") {
      upd.reproductiveStatus = "فارغ";
      upd.lastAbortionDate   = date;
    }

    // ------------------------------------------------------
    //       🟩 6) BCS EVALUATION — تقييم حالة الجسم
    // ------------------------------------------------------
    if (ev.type === "bcs_eval") {
      upd.lastBCS       = ev.bcsScore || null;
      upd.lastBCSDate  = date;
    }

    // ------------------------------------------------------
    //       🟩 7) FECES EVALUATION — تقييم الروث
    // ------------------------------------------------------
    if (ev.type === "feces_eval") {
      upd.lastFecesScore = ev.score || null;
      upd.lastFecesDate  = date;
    }

    // ------------------------------------------------------
    //       🟩 8) NUTRITION — التغذية
    // ------------------------------------------------------
    if (ev.type === "تغذية" || ev.type === "nutrition") {
      upd.lastNutritionDate   = date;
      upd.lastNutritionRows   = ev.nutritionRows || [];
      upd.lastNutritionKPIs   = ev.nutritionKPIs || null;
      upd.lastNutritionMode   = ev.nutritionMode || null;
      upd.lastNutritionGroup  = ev.nutritionContext?.group || null;
    }

    // ------------------------------------------------------
    //   لو مفيش تحديثات — اخرج
    // ------------------------------------------------------
    if (Object.keys(upd).length === 0) {
      console.warn("⚠️ No animal fields to update for event:", ev.type);
      return;
    }

    // ------------------------------------------------------
    //   🔥 البحث عن وثيقة الحيوان (أهم جزء)
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
    //   🔥 الكتابة (merge: true)
    // ------------------------------------------------------
    for (const d of snap.docs) {
      await setDoc(doc(db, "animals", d.id), upd, { merge: true });
      console.log("🔥 animal updated:", d.id, upd);
    }

  } catch (e) {
    console.error("updateAnimalByEvent error:", e);
  }
}
