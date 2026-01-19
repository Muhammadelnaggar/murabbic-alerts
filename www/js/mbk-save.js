// /js/mbk-save.js — Central event save gate for Murabbik (ESM)

import { db, auth } from "/js/firebase-config.js";
import { validateEvent } from "/js/form-rules.js";
import {
  collection, addDoc, serverTimestamp,
  query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function normDigits(s) {
  const map = {
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'
  };
  return String(s || "")
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g, "")
    .replace(/[٠-٩۰-۹]/g, d => map[d]);
}

async function mbkGetUid() {
  const cached = String(
    window.__tenant?.userId ||
    localStorage.getItem("userId") ||
    localStorage.getItem("tenantId") ||
    localStorage.getItem("ownerUid") ||
    ""
  ).trim();
  if (cached) return cached;

  try {
    if (auth?.currentUser?.uid) return auth.currentUser.uid;
    const { onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const u = await new Promise(res => onAuthStateChanged(auth, x => res(x), () => res(null)));
    return u?.uid || "";
  } catch {
    return "";
  }
}

function pickAnimalNumber(payload) {
  // يدعم animalNumber/animalId/number
  const n = payload?.animalNumber ?? payload?.animalId ?? payload?.number ?? payload?.animal ?? "";
  return normDigits(n);
}

function pickEventType(payload) {
  // يفضّل العربية eventType (مثال: "تلقيح", "لبن يومي")
  return String(payload?.eventType || payload?.type || "").trim();
}

function pickEventDate(payload) {
  return String(payload?.eventDate || payload?.date || payload?.dt || "").trim();
}

async function fetchAnimalDoc(uid, animalNumber) {
  // 1) أفضل مفتاح: userId_number
  const key = `${uid}#${animalNumber}`;
  let qy = query(collection(db, "animals"), where("userId_number", "==", key), limit(1));
  let snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  // 2) fallback: userId + number
  qy = query(collection(db, "animals"), where("userId", "==", uid), where("number", "==", String(animalNumber)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  // 3) fallback: ownerUid + number
  qy = query(collection(db, "animals"), where("ownerUid", "==", uid), where("number", "==", String(animalNumber)), limit(1));
  snap = await getDocs(qy);
  if (!snap.empty) return snap.docs[0].data();

  return null;
}

function makeOutOfHerdMsg(doc) {
  const sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "").trim();
  const label =
    (/جاموس/i.test(sp) || sp === "جاموس") ? "هذه الجاموسة" :
    (/بقر/i.test(sp)   || sp === "أبقار")  ? "هذه البقرة" :
    "هذا الحيوان";
  return `${label} غير موجودة بالقطيع.`;
}

/**
 * mbkSaveEvent(payload, opts?)
 * opts = { skipAnimalUpdate?: boolean }
 *
 * Throws Error with Arabic message on block.
 * Returns docRef from addDoc on success.
 */
export async function mbkSaveEvent(payload = {}, opts = {}) {
  const uid = String(payload.userId || "").trim() || await mbkGetUid();
  if (!uid) throw new Error("تعذّر تحديد المستخدم.");

  const animalNumber = pickAnimalNumber(payload);
  if (!animalNumber) throw new Error("رقم الحيوان غير متاح.");

  const eventType = pickEventType(payload) || "حدث";
  const eventDate = pickEventDate(payload);
  if (!eventDate) throw new Error("تاريخ الحدث غير متاح.");

  // جلب وثيقة الحيوان
  const animalDoc = await fetchAnimalDoc(uid, animalNumber);
  if (!animalDoc) throw new Error("هذا الحيوان غير موجود بالقطيع.");

  // قفل خارج القطيع
  const st = String(animalDoc.status || "").trim().toLowerCase();
  if (st === "inactive") {
    throw new Error(makeOutOfHerdMsg(animalDoc));
  }

  // شغّل الفاليديشن المركزي (لو السكيما موجودة) — لن يكسر لو ناقص حقول غير موجودة
  const v = validateEvent(eventType, {
    animalId: animalNumber,
    eventDate,
    documentData: animalDoc,
    species: animalDoc.species,
    ...payload,
  });
  if (!v.ok) throw new Error(v.errors?.[0] || "غير مسموح.");

  // جهّز payload موحد للحفظ
  const toSave = {
    ...payload,
    userId: uid,
    animalNumber: String(payload.animalNumber || animalNumber).trim() || animalNumber,
    animalId: String(payload.animalId || animalNumber).trim() || animalNumber,
    eventType: payload.eventType || eventType,
    eventDate: payload.eventDate || eventDate,
    source: payload.source || location.pathname,
    createdAt: payload.createdAt || serverTimestamp(),
  };

  const ref = await addDoc(collection(db, "events"), toSave);

  // تحديث وثيقة الحيوان (اختياري)
  if (!opts.skipAnimalUpdate) {
    try {
      // يفضّل import module، ولو فشل يستخدم window.updateAnimalByEvent
      const mod = await import("/js/animal-update.js");
      const fn = mod.updateAnimalByEvent || window.updateAnimalByEvent;
      if (typeof fn === "function") await fn(toSave);
    } catch {}
  }

  return ref;
}
