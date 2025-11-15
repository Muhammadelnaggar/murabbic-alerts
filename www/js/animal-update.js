// ================================================================
//  animal-update.js — تحديث تلقائي لوثيقة الحيوان حسب الحدث
//  يعمل من أي صفحة حدث بدون أي تعديل إضافي
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore, collection, query, where, limit, getDocs, updateDoc } 
  from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

import config from "/js/firebase-config.js";

const app = initializeApp(config);
const db  = getFirestore(app, "murabbikdata");

export async function updateAnimalByEvent(event) {
  try {
    if (!event || !event.animalId) return;

    const animalId = String(event.animalId).trim();
    const evType   = String(event.type || "").toLowerCase();
    const result   = String(event.result || event.status || "").toLowerCase();
    const evDate   = toYYYYMMDD(Number(event.ts || Date.now()));

    const patch = {};

    // ====================================================
    //  الحالة التناسلية
    // ====================================================

    // تشخيص حمل + إيجابي
    if (/preg|حمل/.test(evType) && /(ايجاب|عشار|positive|pregnant|حامل)/.test(result)) {
      patch.reproductiveStatus = "pregnant";
      patch.lastDiagnosisDate  = evDate;
    }

    // تشخيص حمل + سلبي
    else if (/preg|حمل/.test(evType) && /(neg|فارغ|negative)/.test(result)) {
      patch.reproductiveStatus = "open";
      patch.lastDiagnosisDate  = evDate;
    }

    // تلقيح
    else if (/insemin|تلقيح/.test(evType)) {
      patch.reproductiveStatus   = "inseminated";
      patch.lastInseminationDate = evDate;
    }

    // ولادة
    else if (/calv|birth|ولادة/.test(evType)) {
      patch.reproductiveStatus = "fresh";
      patch.lastCalvingDate    = evDate;
    }

    // إجهاض
    else if (/abortion|اجهاض/.test(evType)) {
      patch.reproductiveStatus = "aborted";
      patch.lastAbortionDate   = evDate;
    }

    // ====================================================
    //  الحالة الإنتاجية
    // ====================================================

    if (/milk|لبن/.test(evType)) {
      patch.productionStatus = "milking";
    }

    if (/dry|جاف|تجفيف/.test(evType)) {
      patch.productionStatus = "dry";
      patch.lastDryOffDate   = evDate;
    }

    if (/close|تحضير/.test(evType)) {
      patch.productionStatus = "close_up";
      patch.lastCloseUpDate  = evDate;
    }

    if (/calv|birth|ولادة/.test(evType)) {
      patch.productionStatus = "milking";
    }

    // ====================================================
    //  تطبيق التحديث على وثيقة الحيوان
    // ====================================================
    if (Object.keys(patch).length === 0) return;

    const q = query(
      collection(db, "animals"),
      where("number", "==", animalId),
      limit(1)
    );

    const snap = await getDocs(q);
    if (snap.empty) return;

    const ref = snap.docs[0].ref;
    await updateDoc(ref, patch);

    console.log("🔥 animal updated (frontend):", animalId, patch);

  } catch (e) {
    console.error("animal-update failed:", e);
  }
}

// ======================================================
// مساعد لتنسيق التاريخ YYYY-MM-DD
// ======================================================
function toYYYYMMDD(ms) {
  const d = new Date(ms);
  const m = (`0${d.getMonth()+1}`).slice(-2);
  const dd= (`0${d.getDate()}`).slice(-2);
  return `${d.getFullYear()}-${m}-${dd}`;
}
