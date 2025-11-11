// KPI Engine v1.1 — Stable with userId + fallback
// متوافق مع سيرفر murabbikdata الحالي (بدون لمس السيرفر)

(() => {
  const qs = (sel, el = document) => el.querySelector(sel);
  const fmtPct = (x) => Number.isFinite(x) ? Math.round(x) + '%' : '—';

  function ensureGauge(el) {
    if (el.__wired) return;
    el.__wired = true;
    el.innerHTML = `
      <svg viewBox="0 0 100 50" aria-hidden="true">
        <path d="M10,50 A40,40 0 0 1 90,50" fill="none" stroke="#eee" stroke-width="10" />
        <path class="bar" d="M10,50 A40,40 0 0 1 90,50" fill="none" stroke="#2e7d32"
              stroke-width="10" stroke-linecap="round" stroke-dasharray="0 250"/>
      </svg>
      <div class="val">—</div>
    `;
  }

  function setGauge(el, pct) {
    ensureGauge(el);
    const dash = Math.max(0, Math.min(100, +pct || 0)) * 1.57; // نصف دائرة
    qs('.bar', el).setAttribute('stroke-dasharray', `${dash} 250`);
    qs('.val', el).textContent = fmtPct(pct);
  }

  function setLine(id, text) {
    const el = qs('#' + id);
    if (el) el.textContent = text;
  }

  async function getJSON(url) {
    try {
      const uid = localStorage.getItem("userId");
      const headers = uid ? { "X-User-Id": uid } : {};
      const r = await fetch(url, { headers, cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch {
      return null;
    }
  }

  async function load() {
    const species = (localStorage.getItem("herdProfile") || "buffalo").toLowerCase();

    // 1️⃣ تحميل الحيوانات (تأكيد الظهور)
    const animals = await getJSON("/api/animals") || [];
    const totalAnimals = Array.isArray(animals)
      ? animals.length
      : Array.isArray(animals.items)
      ? animals.items.length
      : 0;

    // 2️⃣ تحميل إحصاءات القطيع مع userId
    const userId =
      window.userId ||
      localStorage.getItem("userId") ||
      sessionStorage.getItem("userId") ||
      "";

    let stats = null;
    if (userId) {
      stats = await getJSON(
        `/api/herd-stats?userId=${encodeURIComponent(userId)}&species=${encodeURIComponent(
          species
        )}&analysisDays=90`
      );
    } else {
      console.warn("⚠️ userId غير متاح بعد، لن تُعرض إحصاءات القطيع");
    }

    // 3️⃣ القيم الافتراضية
    const S = {
      totalActive: 0,
      pregnantCnt: 0, pregnantPct: 0,
      inseminatedCnt: 0, inseminatedPct: 0,
      openCnt: 0, openPct: 0,
      conceptionPct: 0,
    };

    // 4️⃣ تحليل النتائج
    if (stats && stats.totals) {
      S.totalActive = +stats.totals.totalActive || 0;
      S.pregnantCnt = +(stats.totals.pregnant?.count || 0);
      S.pregnantPct = +(stats.totals.pregnant?.pct || 0);
      S.inseminatedCnt = +(stats.totals.inseminated?.count || 0);
      S.inseminatedPct = +(stats.totals.inseminated?.pct || 0);
      S.openCnt = +(stats.totals.open?.count || 0);
      S.openPct = +(stats.totals.open?.pct || 0);
      S.conceptionPct = +(stats.fertility?.conceptionRatePct || 0);
    } else if (stats && stats.ok) {
      // 🔹 fallback متوافق مع السيرفر الحالي (البسيط)
      S.totalActive = +stats.animalsCount || totalAnimals;
      S.openCnt = +stats.lactating || 0;
      S.openPct = S.totalActive ? (S.openCnt / S.totalActive) * 100 : 0;
      S.conceptionPct = 0;
    } else {
      // 🔹 fallback عام
      S.totalActive = totalAnimals;
    }

    // 5️⃣ تحديث العدادات
    setGauge(qs('.gauge[data-key="pregnant"]'), S.pregnantPct);
    setGauge(qs('.gauge[data-key="inseminated"]'), S.inseminatedPct);
    setGauge(qs('.gauge[data-key="open"]'), S.openPct);
    setGauge(qs('.gauge[data-key="conception"]'), S.conceptionPct);

    // 6️⃣ النصوص السفلية
    setLine("line-pregnant", `عِشار: ${S.pregnantCnt} من ${S.totalActive}`);
    setLine("line-inseminated", `ملقّحات: ${S.inseminatedCnt} من ${S.totalActive}`);
    setLine("line-open", `مفتوحة: ${S.openCnt} من ${S.totalActive}`);
    setLine("line-conception", `Conception: ${fmtPct(S.conceptionPct)}`);

    const numbersEl = qs("#herd-numbers");
    if (numbersEl) {
      numbersEl.textContent = `إجمالي نشِط: ${S.totalActive} • عِشار: ${S.pregnantCnt} • ملقّحات: ${S.inseminatedCnt} • مفتوحة: ${S.openCnt}`;
    }

    console.log("✅ herd-stats:", stats);
  }

  document.addEventListener("DOMContentLoaded", load);
})();
