// /js/herd-gauges.js — النسخة النهائية المتوافقة مع السيرفر 100%

document.addEventListener("DOMContentLoaded", initHerdGauges);

async function initHerdGauges() {
  try {
    const userId =
      localStorage.getItem("userId") ||
      window.userId ||
      sessionStorage.getItem("userId") || "";

    if (!userId) {
      console.warn("❌ لا يوجد userId — إيقاف تشغيل الجوجز");
      return setTimeout(initHerdGauges, 300);
    }

    const res = await fetch("/api/herd-stats", {
      headers: { "X-User-Id": userId },
      cache: "no-store"
    });

    const data = await res.json();
    console.log("HERD-STATS:", data);

    if (!data || !data.ok || !data.totals) {
      console.warn("⚠️ بيانات herd-stats غير صالحة");
      return;
    }

    // =========================
    // القيم EXACT من السيرفر
    // =========================
    const T  = data.totals;
    const F  = data.fertility || {};

    const totalActive      = +T.totalActive || 0;

    const pregnantCnt      = +T.pregnant.count || 0;
    const pregnantPct      = +T.pregnant.pct   || 0;

    const inseminatedCnt   = +T.inseminated.count || 0;
    const inseminatedPct   = +T.inseminated.pct   || 0;

    const openCnt          = +T.open.count || 0;
    const openPct          = +T.open.pct   || 0;

    const conceptionPct    = +F.conceptionRatePct || 0;

    // =========================
    // تحديث الجوجز
    // =========================
    setGaugeValue("g_pregnant",    pregnantPct);
    setGaugeValue("g_inseminated", inseminatedPct);
    setGaugeValue("g_open",        openPct);
    setGaugeValue("g_conception",  conceptionPct);

    // =========================
    // كتابة النصوص
    // =========================
    setText("line-pregnant",    `عِشار: ${pregnantCnt} من ${totalActive}`);
    setText("line-inseminated", `ملقّحات: ${inseminatedCnt} من ${totalActive}`);
    setText("line-open",        `مفتوحة: ${openCnt} من ${totalActive}`);
    setText("line-conception",  `Conception: ${Math.round(conceptionPct)}%`);

    const h = document.querySelector("#herd-numbers");
    if (h) {
      h.textContent =
        `إجمالي نشِط: ${totalActive} • عِشار: ${pregnantCnt} • ملقّحات: ${inseminatedCnt} • مفتوحة: ${openCnt}`;
    }

  } catch (err) {
    console.error("❌ خطأ في herd-gauges:", err);
  }
}

// =========================
// أدوات تعتمد على gauge.js
// =========================

function setGaugeValue(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;

  const v = Math.max(0, Math.min(100, +pct || 0));
  const bar = el.querySelector(".bar");
  const txt = el.querySelector(".value");

  if (bar)  bar.style.strokeDasharray = `${v * 1.57} 250`;
  if (txt)  txt.textContent = Math.round(v) + "%";
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}
