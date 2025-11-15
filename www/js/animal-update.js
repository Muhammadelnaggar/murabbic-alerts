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

    // تجهيز الحقول
    const upd = {};
    const date = ev.eventDate;

    if (ev.type === "daily_milk") {
      upd.productionStatus = "milking";
      upd.lastMilkDate = date;
    }

    if (ev.type === "insemination") {
      upd.reproductiveStatus = "inseminated";
      upd.lastInseminationDate = date;
    }

    if (ev.type === "calving") {
      upd.reproductiveStatus = "fresh";
      upd.productionStatus = "milking";
      upd.lastCalvingDate = date;
    }

    if (ev.type === "dry_off") {
      upd.productionStatus = "dry";
      upd.lastDryOffDate = date;
    }

    if (!Object.keys(upd).length) return;

    // البحث عن الحيوان برقم animalId
    const q = query(
      collection(db, "animals"),
      where("userId", "==", tenant),
      where("number", "==", Number(num)),
      limit(5)
    );

    const snap = await getDocs(q);

    for (const d of snap.docs) {
      await setDoc(doc(db, "animals", d.id), upd, { merge: true });
      console.log("🔥 updated animal:", d.id, upd);
    }
  } catch (e) {
    console.error("updateAnimalByEvent error:", e);
  }
}
