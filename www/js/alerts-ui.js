// /js/alerts-ui.js — Murabbik Smart Alerts UI (v1)
// ✅ تنبيهات شيك + RTL + زر "حسنًا" للإغلاق
// ✅ بدون تعديل تصميم الصفحات: يضيف Overlay خفيف + Cards
// ✅ Dedup + Stack + صوت خفيف اختياري

(function(){
  "use strict";
  if (window.mbkAlerts) return;

  const state = {
    root: null,
    list: null,
    seen: new Set(),
    max: 6
  };

  function el(tag, cls){
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function ensureUI(){
    if (state.root) return;

    const style = document.createElement("style");
    style.textContent = `
      :root{
        --mbk-brand: var(--brand, #0ea05a);
        --mbk-brand-600: var(--brand-600, #0b7f47);
        --mbk-bg: rgba(15,23,42,.45);
        --mbk-card: #fff;
        --mbk-border: var(--border, #e2e8f0);
        --mbk-text: var(--text, #0f172a);
        --mbk-muted: var(--muted, #64748b);
        --mbk-radius: 18px;
        --mbk-shadow: 0 10px 30px rgba(2,8,23,.18);
      }

      .mbk-alerts{
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: none;
        align-items: flex-end;
        justify-content: center;
        background: var(--mbk-bg);
        padding: 14px;
      }
      .mbk-alerts.show{ display:flex; }

      .mbk-alerts-panel{
        width: min(560px, 100%);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .mbk-alert{
        background: var(--mbk-card);
        border: 1px solid var(--mbk-border);
        border-radius: var(--mbk-radius);
        box-shadow: var(--mbk-shadow);
        overflow: hidden;
        transform: translateY(12px);
        opacity: 0;
        animation: mbkIn .18s ease-out forwards;
      }
      @keyframes mbkIn{
        to{ transform: translateY(0); opacity: 1; }
      }

      .mbk-alert-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding: 12px 12px 8px;
      }
      .mbk-alert-title{
        display:flex;
        align-items:center;
        gap:10px;
        font-weight: 900;
        color: var(--mbk-text);
        font-size: 15px;
      }
      .mbk-pill{
        font-size: 12px;
        font-weight: 900;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--mbk-border);
        color: var(--mbk-brand-600);
        background: rgba(14,160,90,.08);
        white-space: nowrap;
      }
      .mbk-x{
        width: 38px;
        height: 38px;
        border-radius: 12px;
        border: 1px solid var(--mbk-border);
        background: #fff;
        cursor: pointer;
        font-weight: 900;
        color: var(--mbk-muted);
      }

      .mbk-alert-body{
        padding: 0 12px 12px;
        color: var(--mbk-text);
        line-height: 1.55;
        font-size: 14px;
      }
      .mbk-alert-meta{
        margin-top: 6px;
        font-size: 12px;
        color: var(--mbk-muted);
        display:flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .mbk-chip{
        border: 1px solid var(--mbk-border);
        border-radius: 999px;
        padding: 3px 8px;
        background: #fff;
      }

      .mbk-alert-actions{
        display:flex;
        gap:10px;
        padding: 10px 12px 12px;
        border-top: 1px dashed var(--mbk-border);
      }
      .mbk-btn{
        flex:1;
        border-radius: 14px;
        padding: 12px 12px;
        cursor:pointer;
        font-weight: 900;
        border: 1px solid var(--mbk-border);
        background: #fff;
        color: var(--mbk-brand-600);
      }
      .mbk-btn.primary{
        border-color: transparent;
        background: var(--mbk-brand);
        color:#fff;
      }

      /* مستويات */
      .mbk-alert[data-sev="warn"] .mbk-pill{
        color:#9a3412;
        background: rgba(251,146,60,.14);
        border-color: rgba(251,146,60,.35);
      }
      .mbk-alert[data-sev="info"] .mbk-pill{
        color:#1d4ed8;
        background: rgba(59,130,246,.12);
        border-color: rgba(59,130,246,.25);
      }
      .mbk-alert[data-sev="tip"] .mbk-pill{
        color: var(--mbk-brand-600);
        background: rgba(14,160,90,.10);
      }
    `;
    document.head.appendChild(style);

    const root = el("div", "mbk-alerts");
    const panel = el("div", "mbk-alerts-panel");
    root.appendChild(panel);

    root.addEventListener("click", (e)=>{
      // لو المستخدم ضغط في الخلفية يقفل كل شيء
      if (e.target === root) hideAll();
    });

    document.body.appendChild(root);

    state.root = root;
    state.list = panel;
  }

  function sevLabel(sev){
    if (sev === "warn") return "تنبيه";
    if (sev === "info") return "معلومة";
    if (sev === "tip") return "اقتراح";
    return "تنبيه";
  }

  function keyOf(p){
    // مفتاح ذكي يمنع التكرار (Rule + animal + date + taskId)
    const r = p?.ruleId || "";
    const a = p?.animalId || p?.animalNumber || "";
    const d = p?.plannedDate || p?.eventDate || "";
    const t = p?.taskId || "";
    return [r,a,d,t].join("|");
  }

  function hideAll(){
    if (!state.root) return;
    state.root.classList.remove("show");
    // امسح الموجود بعد انيميشن صغيرة
    setTimeout(()=>{
      if (state.list) state.list.innerHTML = "";
    }, 120);
  }

  function removeCard(card){
    try{
      card.style.opacity = "0";
      card.style.transform = "translateY(10px)";
    }catch{}
    setTimeout(()=>{
      try{ card.remove(); }catch{}
      if (state.list && state.list.children.length === 0) hideAll();
    }, 140);
  }

  function show(payload){
    ensureUI();

    const k = keyOf(payload);
    if (k && state.seen.has(k)) return; // dedupe
    if (k) state.seen.add(k);

    // حافظ على حد أقصى
    while (state.list.children.length >= state.max){
      state.list.removeChild(state.list.lastElementChild);
    }

    const sev = (payload?.severity || "warn");
    const card = el("div", "mbk-alert");
    card.dataset.sev = sev;

    const head = el("div", "mbk-alert-head");
    const title = el("div", "mbk-alert-title");

    const pill = el("span", "mbk-pill");
    pill.textContent = sevLabel(sev);

    const t = el("div");
    t.textContent = payload?.title || "تنبيه ذكي";

    title.appendChild(pill);
    title.appendChild(t);

    const x = el("button", "mbk-x");
    x.type = "button";
    x.textContent = "✕";
    x.addEventListener("click", ()=> removeCard(card));

    head.appendChild(title);
    head.appendChild(x);

    const body = el("div", "mbk-alert-body");
    body.textContent = payload?.message || "—";

    const meta = el("div", "mbk-alert-meta");
    const animal = payload?.animalId || payload?.animalNumber;
    if (animal) {
      const c = el("span", "mbk-chip");
      c.textContent = `رقم: ${animal}`;
      meta.appendChild(c);
    }
    if (payload?.plannedDate){
      const c = el("span", "mbk-chip");
      c.textContent = `التاريخ: ${payload.plannedDate}`;
      meta.appendChild(c);
    }
    if (payload?.plannedTime){
      const c = el("span", "mbk-chip");
      c.textContent = `الوقت: ${payload.plannedTime}`;
      meta.appendChild(c);
    }
    if (meta.children.length) body.appendChild(meta);

    const actions = el("div", "mbk-alert-actions");

    const ok = el("button", "mbk-btn primary");
    ok.type = "button";
    ok.textContent = "حسنًا";
    ok.addEventListener("click", ()=> removeCard(card));

    // زر اختياري “افتح البطاقة”
    const open = el("button", "mbk-btn");
    open.type = "button";
    open.textContent = "بطاقة الحيوان";
    open.addEventListener("click", ()=>{
      const num = (payload?.animalId || payload?.animalNumber || "").trim();
      if (!num) return;
      location.href = `cow-card.html?number=${encodeURIComponent(num)}`;
    });

    // لو مفيش رقم حيوان نخفي زر البطاقة
    if (!(payload?.animalId || payload?.animalNumber)) {
      open.style.display = "none";
    }

    actions.appendChild(open);
    actions.appendChild(ok);

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(actions);

    state.list.insertBefore(card, state.list.firstChild);
    state.root.classList.add("show");
  }

  window.mbkAlerts = { show, hideAll };
})();
