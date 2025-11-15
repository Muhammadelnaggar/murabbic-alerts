// www/js/animal-update.js
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
    const tenant = (ev.userId || "").trim();
    const num    = ev.animalId || ev.animalNumber;

    if (!tenant || !num) return;

    const upd = {};
    const date = ev.eventDate;

    // تحديث الحالة الإنتاجية فقط للـ daily milk
    if (ev.type === "daily_milk") {
      upd.productionStatus = "milking";
      upd.lastMilkDate = date;
    }

    if (!Object.keys(upd).length) return;

    // البحث عن الحيوان برقم number
    const q = query(
      collection(db, "animals"),
      where("userId", "==", tenant),
      where("number", "==", Number(num)),
      limit(5)
    );

    const snap = await getDocs(q);

    for (const d of snap.docs) {
      await setDoc(doc(db, "animals", d.id), upd, { merge: true });
      console.log("🔥 animal updated:", d.id, upd);
    }
  } catch (e) {
    console.error("updateAnimalByEvent error:", e);
  }
}
