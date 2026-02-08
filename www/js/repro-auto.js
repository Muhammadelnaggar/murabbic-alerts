// /js/repro-auto.js — Auto move "حديثة الولادة" -> "مفتوح" بعد مدة ثابتة
// ✅ الأبقار: 49 يوم | الجاموس: 44 يوم
// ✅ بدون أي حدث جديد — مجرد تحديث لوثيقة الحيوان
// ✅ يعمل مرة واحدة يوميًا عند فتح الداشبورد
// ✅ يقرأ تاريخ الولادة من الحقل: lastCalvingDate (كما في قاعدة البيانات) + بدائل

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

console.log("[repro-auto] loaded ✅");

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

function todayISO(){ return new Date().toISOString().slice(0,10); }

function daysBetweenISO(aISO, bISO){
  if(!aISO || !bISO) return null;
  const a = new Date(aISO + "T00:00:00");
  const b = new Date(bISO + "T00:00:00");
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function normAr(s){
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");
}

function isNewbornStatus(v){
  const n = normAr(v);
  // تقبل كل الصيغ الشائعة
  return (
    n === "حديثه الولاده" ||
    n === "حديثه الولاده " ||
    n.includes("حديث") && n.includes("ولاد")
  );
}

function getUserId(){
  const uid = auth?.currentUser?.uid;
  if(uid) return uid;

  return (
    (localStorage.getItem("userId") ||
     localStorage.getItem("uid") ||
     localStorage.getItem("tenantId") ||
     "").trim()
  );
}

async function safeWaitUser(ms=2000){
  const t0 = Date.now();
  while(Date.now() - t0 < ms){
    const u = getUserId();
    if(u) return true;
    await new Promise(r => setTimeout(r, 80));
  }
  return !!getUserId();
}

/* ---------------- Settings (49/44) ---------------- */
function getThresholdDays(type){
  const t = String(type || "").trim().toLowerCase();

  const isBuffalo =
    t.includes("جاموس") ||
    t.includes("buffalo");

  // 👇 الشرط الجديد
  if (isBuffalo) return 41;   // > 40 يوم
  return 50;                  // > 49 يوم
}


function pickAnimalType(a){
  return (a.type || a.animalType || a.species || "أبقار").trim();
}

// ✅ تاريخ آخر ولادة: زي قاعدة البيانات + بدائل
function pickCalvingDate(a){
  return toISODate(
    a.lastCalvingDate ??
    a.LastCalvingDate ??
    a.lastcalvingdate ??
    a.Lastcalvingdate ??
    a.calvingDate ??
    a.lastCalving ??
    ""
  );
}

/* ---------------- Main ---------------- */
export async function runReproAutoOnce(options = {}){
  const { maxScan = 500, dryRun = false } = options;

  await safeWaitUser(2000);

  const userId = getUserId();
  if(!userId){
    console.warn("[repro-auto] No userId yet; skipping.");
    return { scanned: 0, updated: 0, skipped: 0, reason: "no_user" };
  }

  const animalsRef = collection(db, "animals");

  // ✅ فلترة آمنة: نفس المستخدم + active فقط
  const qy = query(
    animalsRef,
    where("userId", "==", userId),
    where("status", "==", "active"),
    limit(maxScan)
  );

  const snap = await getDocs(qy);

  const today = todayISO();
  let scanned = 0, updated = 0, skipped = 0;

  const batch = writeBatch(db);

  snap.forEach(docSnap => {
    const a = docSnap.data() || {};

    // نفحص فقط حديث الولادة (بكل صيغها)
    if (!isNewbornStatus(a.reproductiveStatus)) { return; }

    scanned++;

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
async function autoRun(){
  const key = "mbk_repro_auto_last_run";
  const today = todayISO();
  if ((localStorage.getItem(key) || "") === today) return;

  await new Promise(r => setTimeout(r, 800));

  runReproAutoOnce({ maxScan: 500, dryRun: false })
    .then(res => {
      localStorage.setItem(key, today);
      localStorage.setItem("mbk_repro_auto_last_result", JSON.stringify(res));
      console.log("[repro-auto] done:", res);
    })
    .catch(err => console.warn("[repro-auto] failed:", err));
}

autoRun();

// ✅ للتجربة من الكونسول مباشرة
window.runReproAutoOnce = runReproAutoOnce;
