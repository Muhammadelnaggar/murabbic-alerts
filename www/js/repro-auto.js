// /js/repro-auto.js — Auto move "حديثة الولادة" -> "مفتوح" بعد مدة ثابتة
// ✅ الأبقار: 49 يوم | الجاموس: 44 يوم
// ✅ بدون أي حدث جديد — مجرد تحديث لوثيقة الحيوان
// ✅ يعمل مرة واحدة يوميًا عند فتح الداشبورد
// ✅ يقرأ تاريخ الولادة من الحقل: Lastcalvingdate (كما في قاعدة البيانات)

import { db, auth } from "./firebase-config.js";

import {
  collection,
  getDocs,
  query,
  where,
  limit,
  writeBatch,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------------- Helpers ---------------- */
function toISODate(v){
  if(!v) return "";
  if(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  // Firestore Timestamp
  if (v?.toDate) {
    const d = v.toDate();
    return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  }

  const d = new Date(v);
  if (isNaN(d)) return "";
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
}

function todayISO(){
  return new Date().toISOString().slice(0,10);
}

function daysBetweenISO(aISO, bISO){
  if(!aISO || !bISO) return null;
  const a = new Date(aISO + "T00:00:00");
  const b = new Date(bISO + "T00:00:00");
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / 86400000);
}

function getUserId(){
  // 1) Firebase Auth
  const uid = auth?.currentUser?.uid;
  if(uid) return uid;

  // 2) لو عندك تخزين محلي للهوية
  const ls = localStorage.getItem("userId") || localStorage.getItem("tenantId") || "";
  return (ls || "").trim();
}

async function safeWaitAuth(ms=600){
  const t0 = Date.now();
  while(Date.now() - t0 < ms){
    if (auth?.currentUser?.uid) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !!auth?.currentUser?.uid;
}

/* ---------------- Settings (49/44) ---------------- */
function getThresholdDays(type){
  // ✅ تقدر تغيّرها لاحقًا بدون كود:
  // localStorage.setItem("mbk_open_after_days_cows","49")
  // localStorage.setItem("mbk_open_after_days_buffalo","44")
  const cows = parseInt(localStorage.getItem("mbk_open_after_days_cows") || "49", 10);
  const buff = parseInt(localStorage.getItem("mbk_open_after_days_buffalo") || "44", 10);

  if (String(type || "").trim() === "جاموس") return Number.isFinite(buff) ? buff : 44;
  return Number.isFinite(cows) ? cows : 49;
}

function pickAnimalType(a){
  return (a.type || a.animalType || a.species || "أبقار").trim();
}

// ✅ تاريخ آخر ولادة: زي قاعدة البيانات حرفيًا
function pickCalvingDate(a){
  return toISODate(a.Lastcalvingdate || "");
}

/* ---------------- Main ---------------- */
export async function runReproAutoOnce(options = {}){
  const { maxScan = 500, dryRun = false } = options;

  await safeWaitAuth(600);

  const userId = getUserId();
  if(!userId){
    console.warn("[repro-auto] No userId yet; skipping.");
    return { scanned: 0, updated: 0, skipped: 0, reason: "no_user" };
  }

  const animalsRef = collection(db, "animals");

  // ✅ نفحص فقط: active + حديثة الولادة + لنفس المستخدم
  const qy = query(
    animalsRef,
    where("userId", "==", userId),
    where("status", "==", "active"),
    where("reproductiveStatus", "==", "حديثة الولادة"),
    limit(maxScan)
  );

  const snap = await getDocs(qy);

  const today = todayISO();
  let scanned = 0, updated = 0, skipped = 0;

  const batch = writeBatch(db);

  snap.forEach(docSnap => {
    scanned++;
    const a = docSnap.data() || {};

    // تجاهل المستبعدة من التلقيح
    if (a.breedingBlocked === true) { skipped++; return; }

    const type = pickAnimalType(a);
    const threshold = getThresholdDays(type);

    const calvingISO = pickCalvingDate(a);
    if(!calvingISO){ skipped++; return; }

    const dim = daysBetweenISO(calvingISO, today);
    if(dim === null){ skipped++; return; }

    if (dim >= threshold) {
      if(!dryRun){
        batch.update(docSnap.ref, {
          reproductiveStatus: "مفتوح",
          reproAutoUpdatedAt: Timestamp.now(),
          reproAutoReason: `AutoOpenAfter${threshold}Days`,
          reproAutoDim: dim
        });
      }
      updated++;
    } else {
      skipped++;
    }
  });

  if(!dryRun && updated > 0){
    await batch.commit();
  }

  return { scanned, updated, skipped };
}

/* ---------------- Auto-run: once per day ---------------- */
(function autoRun(){
  const key = "mbk_repro_auto_last_run";
  const today = todayISO();
  const last = localStorage.getItem(key) || "";
  if(last === today) return;

  runReproAutoOnce({ maxScan: 500, dryRun: false })
    .then(res => {
      localStorage.setItem(key, today);
      console.log("[repro-auto] done:", res);
    })
    .catch(err => {
      console.warn("[repro-auto] failed:", err);
      // لا نكتب last_run عند الفشل
    });
})();
