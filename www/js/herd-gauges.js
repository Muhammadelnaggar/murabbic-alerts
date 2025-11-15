// /js/herd-gauges.js — نسخة نهائية مستقرة 100%
// =============================================

document.addEventListener("DOMContentLoaded", initHerdGauges);

async function initHerdGauges() {
  try {
    const userId =
      localStorage.getItem("userId") ||
      window.userId ||
      sessionStorage.getItem("userId") ||
      "";

    if (!userId) {
      console.warn("❌ لا يوجد userId — الجوجز لن تعمل");
      return;
    }

    const res = await fetch("/api/herd-stats", {
      headers: { "X-User-Id": userId },
      cache: "no-store"
    });

    const data = await res.json();
    console.log("HERD-STATS:", data);

    if (!data || !data.ok) {
      console.warn("⚠️ herd-stats لم يرجع بيانات صالحة");
      return;
    }

    // ============================
    // القيم EXACT كما جاءت من السيرفر
    // ============================

    const totalActive = +data.totals?.totalActive || 0;

    const pregnantCnt   = +data.fertility?.pregCount || 0;
    const pregnantPct   = +data.fertility?.pregPercent || 0;

    const inseminatedCnt = +data.fertility?.inseminatedCount || 0;
    const inseminatedPct = +data.fertility?.inseminatedPercent || 0;

    const openCnt = +data.fertility?.openCount || 0;
    const openPct = +data.fertility?.openPercent || 0;

    const conceptionPct = +data.fertility?.conceptionRate || 0;

    // ============================
    // تحديث الجوجز (باستخدام gauge.js)
    // ============================

    setGaugeValue("g_pregnant",    pregnantPct);
    setGaugeValue("g_inseminated", inseminatedPct);
    setGaugeValue("g_open",        openPct);
    setGaugeValue("g_conception",  conceptionPct);

    // ============================
    // نصوص تحت كل عدّاد
    // ============================

    setText("line-pregnant",    `عِشار: ${pregnantCnt} من ${totalActive}`);
    setText("line-inseminated", `ملقّحات: ${inseminatedCnt} من ${totalActive}`);
    setText("line-open",        `مفتوحة: ${openCnt} من ${totalActive}`);
    setText("line-conception",  `Conception: ${Math.round(conceptionPct)}%`);

    // نص الإجمالي
    const h = document.querySelector("#herd-numbers");
    if (h) {
      h.textContent =
        `إجمالي نشِط: ${totalActive} • عِشار: ${pregnantCnt} • ملقّحات: ${inseminatedCnt} • مفتوحة: ${openCnt}`;
    }

  } catch (err) {
    console.error("❌ خطأ في herd-gauges:", err);
  }
}


// =============================================
// دوال مساعدة تعتمد على gauge.js الموجود عندك
// =============================================

function setGaugeValue(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;

  const value = Math.max(0, Math.min(10
