// www/js/animal-update.js — النسخة النهائية (استبعاد/بيع/نفوق + status)
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

/* ===================== Helpers ===================== */
function normDigitsOnly(s){
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
               '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  return String(s||'')
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g,'')
    .replace(/[٠-٩۰-۹]/g, d=>map[d]);
}

export async function updateAnimalByEvent(ev) {
  try {
    // ✅ المالك + رقم الحيوان (نفضّل animalNumber ثم number)
    const tenant = (ev.userId || "").toString().trim();
    const num = normDigitsOnly(
      (
        ev.animalNumber ||
        ev.number ||
        ev.animalId || // احتياطي لو اتخزّن فيه الرقم
        ""
      ).toString().trim()
    );

    if (!tenant || !num) {
      console.warn("⛔ updateAnimalByEvent: missing tenant or number", { tenant, num, ev });
      return;
    }

    const date = (ev.eventDate || "").toString().trim();
    const upd  = {};
// ✅ بروتوكول تزامن: دخول الحيوان في البروتوكول


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

      // استبعاد
      case "cull":
      case "استبعاد":
        type = "cull";
        break;

      // بيع
      case "sale":
      case "بيع":
        type = "sale";
        break;

      // نفوق
      case "death":
      case "نفوق":
        type = "death";
        break;
      // تجفيف
      case "dry_off":
      case "dryoff":
      case "تجفيف":
        type = "dry_off";
        break;
      // بروتوكول تزامن
case "ovysynch":
case "بروتوكول تزامن":
  type = "ovysynch";
  break;

// خطوة بروتوكول
case "ovysynch-step":
case "خطوة بروتوكول":
  type = "ovysynch-step";
  break;

      default:
        type = rawType; 
    }
    // ✅ بروتوكول تزامن: دخول الحيوان في البروتوكول
if (type === "ovysynch" || type === "بروتوكول تزامن") {
  upd.currentProtocol = "ovsynch";
  upd.protocolStatus = "active";
  upd.protocolStartDate =
    (ev.startDate || ev.eventDate || "").toString().trim() || null;
  upd.status = "active";
}


// ✅ خطوة بروتوكول: لو كانت آخر خطوة (TAI) نُنهي البروتوكول
if (type === "ovysynch-step" || type === "خطوة بروتوكول") {
  const stepName = String(ev.stepName || "").trim();

  // لو اسم الخطوة فيه "تلقيح" أو TAI → دي آخر خطوة
  if (stepName.includes("تلقيح") || stepName.includes("TAI")) {
    upd.currentProtocol = null;
    upd.protocolStatus = "completed";
    upd.protocolExitDate =
      (ev.confirmedOn || ev.eventDate || "").toString().trim() || null;
  }
}

    // ============================================================
    // 🟩 DAILY MILK — إنتاج اللبن اليومي
    // ============================================================
    if (type === "daily_milk") {
      upd.productionStatus = "milking";
      upd.lastMilkDate     = date;
      upd.dailyMilk        = (ev.milkKg != null) ? (Number(ev.milkKg) || null) : null;
      upd.status = "active";
    }

    // ============================================================
    // 🟩 CALVING — ولادة
    // ✅ لازم تغيّر الحالة: عشار -> حديث الولادة
    // ✅ الموسم/اللاكتشن يزيد تلقائيا (حتى لو ev ما بعتش lactationNumber)
    // ============================================================
    let wantIncLactation = false;

    if (type === "calving") {
      upd.lastCalvingDate    = date;
      upd.reproductiveStatus = "حديث الولادة";
      upd.productionStatus   = "fresh";
      upd.daysInMilk         = 0;

      // لو جالك رقم موسم جاهز هنستخدمه، وإلا هنزوده من وثيقة الحيوان
      if (ev.lactationNumber != null) upd.lactationNumber = Number(ev.lactationNumber) || undefined;
      else wantIncLactation = true;

      upd.status = "active";
    }

    // ============================================================
// 🟩 CLOSE-UP — تحضير للولادة (حدث إنتاجي فقط)
// ❌ ممنوع يغيّر reproductiveStatus
// ============================================================
if (type === "close_up") {
  upd.lastCloseUpDate = date;

  // (اختياري مفيد للتقارير فقط — لا يلمس الحالة التناسلية)
  if (ev.ration != null)       upd.closeUpRation = String(ev.ration).trim();
  if (ev.anionicSalts != null) upd.anionicSalts  = String(ev.anionicSalts).trim();

  upd.status = "active";
}
    // ============================================================
    // 🟩 DRY-OFF — تجفيف
    // ✅ لازم يحدّث الحالة الإنتاجية إلى "جاف"
    // ============================================================
    if (type === "dry_off") {
      upd.lastDryOffDate   = date;
      upd.productionStatus = "dry";   // 👈 دي أهم سطر
      upd.status = "active";
    }


    // ============================================================
    // 🟩 HEAT — شياع (حدث فقط)
    // ============================================================
    if (type === "heat") {
      upd.lastHeatDate = date;
      upd.status = "active";
      // ✅ لو كانت داخل بروتوكول: تخرج تلقائيًا عند الشياع
upd.currentProtocol = null;
upd.protocolStatus = "exited_heat";
upd.protocolExitDate = date;

    }

    // ============================================================
    // 🟩 INSEMINATION — تلقيح
    // ============================================================
if (type === "insemination") {
  upd.lastInseminationDate = date;
  upd.reproductiveStatus   = "ملقحة";
  upd.status = "active";
  upd.currentProtocol = null;
  upd.protocolStatus = "exited_inseminated";
  upd.protocolExitDate = date;
}

    }

    // ============================================================
    // 🟩 PREGNANCY DIAGNOSIS — تشخيص حمل
    // ✅ “غير عشار” = “مفتوحة” (مش “فارغ”) لتوحيد النظام كله
    // ============================================================
    if (type === "pregnancy_diagnosis") {
      upd.lastDiagnosisDate   = date;
      upd.lastDiagnosisResult = ev.result;
      upd.reproductiveStatus  = (ev.result === "عشار" ? "عشار" : "مفتوحة");
      upd.status = "active";
    }

    // ============================================================
    // 🟩 ABORTION — إجهاض
    // ✅ الإجهاض دائمًا يخليها “مفتوحة”
    // ✅ لكن لو عمر الإجهاض >= 5 شهور: يزيد الموسم/اللاكتشن +1 (بس مش “حديث الولادة”)
    // ============================================================
    let wantIncLactationFromAbortion = false;

    if (type === "abortion") {
      upd.lastAbortionDate = date;

      const m = Number(ev.abortionAgeMonths);
      upd.abortionAgeMonths = Number.isFinite(m) ? Number(m) : null;

      // الحالة بعد الإجهاض: مفتوحة دائمًا
      upd.reproductiveStatus = "مفتوحة";

      // قرار الموسم
      if (Number.isFinite(m) && m >= 5) {
        wantIncLactationFromAbortion = true;
        upd.lastPregnancyLossClass = "late";   // تمييز اختياري مفيد للتقارير
      } else {
        upd.lastPregnancyLossClass = "early";
      }

      upd.status = "active";
    }

    // ============================================================
    // 🟩 CULL — استبعاد (يظل نشط + منع تلقيح)
    // ============================================================
    if (type === "cull") {
      upd.status = "active";
      upd.reproductiveStatus = "لا تُلقّح مرة أخرى";
      upd.breedingBlocked = true;
      upd.breedingBlockReason = "استبعاد";
      upd.breedingBlockDate = date;
      if (ev.cullMain)   upd.cullMain = String(ev.cullMain).trim();
      if (ev.cullDetail) upd.cullDetail = String(ev.cullDetail).trim();
      if (ev.reason)     upd.cullReasonText = String(ev.reason).trim();
    }

    // ============================================================
    // 🟩 SALE — بيع (يخرج من القطيع)
    // ============================================================
    if (type === "sale") {
      upd.status = "inactive";
      upd.inactiveReason = "sale";
      upd.saleDate = date;
      if (ev.price != null) upd.salePrice = Number(ev.price) || null;
      if (ev.saleReason) upd.saleReason = String(ev.saleReason).trim();
      upd.statusUpdatedAt = date;
        // ✅ تاريخ خروج موحد
  upd.inactiveDate = date;

  // ✅ تنظيف بصري (مش تاريخي) لتجنب الالتباس في الصفحات
  upd.productionStatus = "inactive";
  upd.currentProtocol = null;
  upd.protocolStatus = null;
  upd.protocolExitDate = date;

    }

    // ============================================================
    // 🟩 DEATH — نفوق (يخرج من القطيع)
    // ============================================================
    if (type === "death") {
      upd.status = "inactive";
      upd.inactiveReason = "death";
      upd.deathDate = date;
      if (ev.reason) upd.deathReason = String(ev.reason).trim();
      upd.statusUpdatedAt = date;
        // ✅ تاريخ خروج موحد
  upd.inactiveDate = date;

  // ✅ تنظيف بصري
  upd.productionStatus = "inactive";
  upd.currentProtocol = null;
  upd.protocolStatus = null;
  upd.protocolExitDate = date;

    }

    // ============================================================
    // لو مفيش أي تحديثات
    // ============================================================
    // ✅ تنظيف احتياطي: تحضير للولادة لا يغيّر الحالة التناسلية إطلاقًا
if (type === "close_up") {
  delete upd.reproductiveStatus;
  delete upd.reproStatus;
}

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
      snap = await getDocs(
        query(
          animalsRef,
          where("userId", "==", tenant),
          where("animalNumber", "==", Number(num)),
          limit(5)
        )
      );
    }

    if (snap.empty) {
      console.warn("⛔ animal not found for update:", { tenant, num, ev });
      return;
    }

    // ------------------------------------------------------
    // 🔥 الكتابة (merge: true) + زيادة الموسم من الوثيقة عند اللزوم
    // ------------------------------------------------------
    for (const d of snap.docs) {
      const cur = d.data() || {};
      const updFinal = { ...upd };
      if (type === "insemination") {
  const curSvc = Number(cur.servicesCount || 0);
  updFinal.servicesCount = (Number.isFinite(curSvc) ? curSvc : 0) + 1;
}
      // ✅ زيادة lactationNumber تلقائيًا عند الولادة (لو مش مُرسل)
      if (type === "calving" && wantIncLactation) {
        const curL = Number(cur.lactationNumber || 0);
        updFinal.lactationNumber = (Number.isFinite(curL) ? curL : 0) + 1;
      }

      // ✅ زيادة lactationNumber عند الإجهاض المتأخر (>=5 شهور)
      if (type === "abortion" && wantIncLactationFromAbortion) {
        const curL = Number(cur.lactationNumber || 0);
        updFinal.lactationNumber = (Number.isFinite(curL) ? curL : 0) + 1;
      }

      await setDoc(doc(db, "animals", d.id), updFinal, { merge: true });
      console.log("🔥 animal updated:", d.id, updFinal);
    }

  } catch (e) {
    console.error("updateAnimalByEvent error:", e);
  }
}
