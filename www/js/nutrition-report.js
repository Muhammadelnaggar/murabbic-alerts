// مُرَبِّيك — تقرير التغذية الاحترافي
// عرض فقط: يقرأ التحليلات المحفوظة من السيرفر ولا يعيد حساب الاحتياجات أو الإمداد.
// نسخة منظمة: تقرير شامل افتراضي + فهرس واضح + تبويب/روابط داخلية + كل تحليل العليقة في كتلة واحدة.

const API_BASE = window.API_BASE || 'https://murabbic-alerts.onrender.com';

const $ = (id) => document.getElementById(id);
const qp = new URLSearchParams(location.search);

/* ============================================================
   أدوات عامة
============================================================ */
function getTenantId(){
  try{
    const T = window.__TENANT__ || {};
    return (
      T.userId || T.uid || T.id || T.tenantId ||
      localStorage.getItem('userId') ||
      localStorage.getItem('uid') ||
      localStorage.getItem('tenantId') ||
      null
    );
  }catch(_){ return null; }
}

async function waitTenant(ms = 1800){
  const start = Date.now();
  while(Date.now() - start < ms){
    const id = getTenantId();
    if(id) return id;
    await new Promise(r => setTimeout(r, 120));
  }
  return getTenantId();
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[m]));
}

function num(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function finite(v){
  return Number.isFinite(Number(v));
}

function nf(v, d = 2){
  const n = Number(v);
  if(!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(d);
}

function money(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return '—';
  return `${nf(n, 2)} جنيه`;
}

function kg(v, d = 2){ return `${nf(v, d)} كجم`; }
function pct(v, d = 1){ return `${nf(v, d)}%`; }
function g(v, d = 0){ return `${nf(v, d)} جم`; }
function safe(v){ return (v === null || v === undefined || v === '') ? '—' : String(v); }

function stateWeight(s){
  const x = String(s || '').toLowerCase();
  if(x.includes('danger') || x.includes('خطر')) return 1;
  if(x.includes('warn') || x.includes('watch') || x.includes('مراجعة') || x.includes('متابعة')) return 2;
  if(x.includes('good') || x.includes('ok') || x.includes('مقبول') || x.includes('مناسب')) return 3;
  return 4;
}

function stateClass(state){
  const s = String(state || '').toLowerCase();
  if(s.includes('danger') || s.includes('bad') || s.includes('deficit') || s.includes('excess') || s.includes('خطر')) return 'danger';
  if(s.includes('warn') || s.includes('watch') || s.includes('low') || s.includes('border') || s.includes('مراجعة') || s.includes('متابعة')) return 'warn';
  if(s.includes('good') || s.includes('ok') || s.includes('مقبول') || s.includes('مناسب')) return 'good';
  return 'muted';
}

function statusText(state){
  const s = String(state || '').toLowerCase();
  if(s.includes('deficit')) return 'نقص';
  if(s.includes('excess')) return 'زيادة';
  if(s.includes('danger')) return 'تنبيه';
  if(s.includes('warn') || s.includes('watch')) return 'يحتاج ضبط';
  if(s.includes('good') || s.includes('ok')) return 'متزن';
  return 'معلومة';
}
const ADVICE = {
  energy: {
    low: 'الطاقة أقل من الاحتياج؛ راجع كثافة الطاقة ومصادرها مع الحفاظ على أمان الكرش.',
    high: 'الطاقة أعلى من الاحتياج؛ راجع الزيادة في تكلفة مصادر الطاقة وتجنب الزيادة عن حدود الاحتياج.',
    ok: 'الطاقة متزنة؛ استمر على نفس التركيب مع متابعة اللبن والاجترار والروث والمتبقي في المعلف.'
  },
  mp: {
    low: 'البروتين الممثل أقل من الاحتياج؛ راجع مصدر البروتين الحقيقي وجودته لتفادي نقص إنتاج اللبن وجودته.',
    high: 'البروتين الممثل أعلى من الاحتياج؛ راجع التكلفة الزائدة لتجنب ارتفاع تكاليف الإنتاج.',
    ok: 'البروتين الممثل متزن؛ لا تغيّر مصدر البروتين إلا لسبب اقتصادي أو إنتاجي.'
  },
  cp: {
    low: 'البروتين الخام أقل من المطلوب؛ راجعه مع البروتين الممثل قبل تعديل العليقة.',
    high: 'البروتين الخام مرتفع؛ لا ترفع البروتين أكثر وراجع الهدر والتكلفة.',
    ok: 'البروتين الخام مناسب، مع الاعتماد الأساسي على قراءة البروتين الممثل.'
  },
  ndf: {
    low: 'الألياف المتعادلة منخفضة؛ راجع نسبة الخشن وجودته لحماية صحة الكرش.',
    high: 'الألياف المتعادلة مرتفعة؛ قد تقلل كثافة الطاقة والمأكول مما ينعكس على إنتاج اللبن، راجع جودة الخشن ونسبته.',
    ok: 'الألياف المتعادلة متزنة؛ تابع الاجترار والروث وثبات اللبن.'
  },
  starch: {
    low: 'النشا منخفض؛ راجع مصادر الحبوب النشوية مع مراجعة اتزان الطاقة الكلية في كارت الطاقة.',
    high: 'النشا مرتفع؛ راجع الألياف الفعالة وصحة الكرش لتجنب الحموضة.',
    ok: 'النشا داخل الحد المناسب؛ استمر مع متابعة الروث والاجترار وصحة الكرش.'
  },
  fat: {
    low: 'دهن العليقة منخفض؛ لا ترفعه إلا إذا كانت الطاقة تحتاج دعمًا واضحًا وبعد مراجعة مصادر الطاقة الأخرى.',
    high: 'دهن العليقة مرتفع؛ راجع مصادر الدهون والزيوت لأنها قد تضغط هضم الألياف وصحة الكرش.',
    ok: 'دهن العليقة داخل الحد المناسب؛ استمر مع متابعة الروث والاجترار وثبات اللبن.'
  },
  pendf: {
    low: 'الألياف الفعالة أقل من المطلوب؛ راجع طول تقطيع الخشن ومنع فرز الخلطة.',
    high: 'الألياف الفعالة أعلى من الحد العملي؛ راجع قبول الحيوان للعليقة وكثافة الطاقة.',
    ok: 'الألياف الفعالة مناسبة؛ تابع الاجترار والروث وثبات اللبن.'
  },
  roughage: {
    low: 'نسبة الخشن منخفضة؛ راجع كمية وجودة الخشن لحماية الكرش.',
    high: 'نسبة الخشن مرتفعة؛ قد تقلل كثافة الطاقة والمأكول، راجع جودة الخشن ونسبة المركزات.',
    ok: 'نسبة الخشن مناسبة؛ تابع المتبقي والاجترار والروث.'
  },
  forageNdf: {
    low: 'الألياف المتعادلة من الخشن منخفضة؛ راجع مصدر الخشن وجودته.',
    high: 'الألياف المتعادلة من الخشن مرتفعة؛ قد تقلل كثافة الطاقة، راجع جودة الخشن ونسبة إضافته.',
    ok: 'الألياف المتعادلة من الخشن مناسبة؛ تابع صحة الكرش وثبات اللبن.'
  }
};

function adviceKind(state, mode = 'balance'){
  const s = String(state || '').toLowerCase();

  if(mode === 'max'){
    if(s.includes('warn') || s.includes('danger')) return 'high';
    return 'ok';
  }

  if(mode === 'min'){
    if(s.includes('warn') || s.includes('danger')) return 'low';
    return 'ok';
  }

  if(s.includes('danger')) return 'low';
  if(s.includes('warn')) return 'high';
  return 'ok';
}

function mbkAdvice(key, state, mode = 'balance'){
  const pack = ADVICE[key] || {};
  const kind = adviceKind(state, mode);
  return pack[kind] || pack.ok || 'استمر في المتابعة حسب قراءة مُرَبِّيك.';
}
function badge(text, state = ''){
  if(!text) return '';
  return `<span class="status-chip ${stateClass(state || text)}">${esc(text)}</span>`;
}

function stageLabel(stage, ctx = {}){
  const s = String(stage || ctx.groupType || '').toLowerCase();
  if(s.includes('close')) return 'انتظار الولادة';
  if(s.includes('far') || s.includes('dry')) return 'جاف بعيد';
  if(s.includes('lact')) return 'حلاب';
  if(ctx.closeUp) return 'انتظار الولادة';
  if(ctx.earlyDry) return 'جاف بعيد';
  if(Number(ctx.avgMilkKg || 0) > 0) return 'حلاب';
  return 'غير محدد';
}

function isLactating(stage, ctx = {}){
  return stageLabel(stage, ctx) === 'حلاب' || Number(ctx.avgMilkKg || 0) > 0;
}

function isCloseUp(stage, ctx = {}){
  return stageLabel(stage, ctx) === 'انتظار الولادة';
}

function balanceState(balance, tolerance = 0){
  const n = Number(balance);
  if(!Number.isFinite(n)) return 'muted';
  if(n < -Math.abs(tolerance)) return 'danger';
  if(n > Math.abs(tolerance)) return 'warn';
  return 'good';
}

function highLimitState(actual, max){
  if(!finite(actual) || !finite(max)) return 'muted';
  return Number(actual) > Number(max) ? 'warn' : 'good';
}

function minLimitState(actual, min){
  if(!finite(actual) || !finite(min)) return 'muted';
  return Number(actual) < Number(min) ? 'warn' : 'good';
}

function decisionFromEvent(e = {}){
  const cards = e?.nutrition?.panels?.analysisCards || [];
  return cards.find(c => String(c?.key || '').toLowerCase() === 'decision') || null;
}

function priorityFromEvent(e = {}){
  const cards = e?.nutrition?.panels?.analysisCards || [];
  return cards.find(c => String(c?.key || '').toLowerCase() === 'priority') || null;
}

function eventStage(e = {}){
  const ctx = e?.nutrition?.context || {};
  if(ctx.closeUp) return 'close_up';
  if(ctx.earlyDry) return 'far_dry';
  if(Number(ctx.avgMilkKg || 0) > 0) return 'lactating';

  const gt = String(ctx.groupType || '').toLowerCase();
  if(gt.includes('close')) return 'close_up';
  if(gt.includes('far') || gt.includes('dry')) return 'far_dry';
  if(gt.includes('lact')) return 'lactating';

  const modelStage = String(e?.nutrition?.analysis?.targets?.chapter12EnergyModel?.stage || '').toLowerCase();
  if(modelStage.includes('close')) return 'close_up';
  if(modelStage.includes('far') || modelStage.includes('dry')) return 'far_dry';

  return '';
}

function groupNameFromEvent(e = {}){
  const ctx = e?.nutrition?.context || {};
  return String(ctx.groupName || ctx.group || ctx.groupLabel || e.groupName || 'مجموعة تغذية').trim();
}

function speciesLabelFromEvent(e = {}){
  const s = String(e?.nutrition?.context?.species || '').toLowerCase();
  if(s.includes('جاموس') || s.includes('buffalo')) return 'جاموس';
  if(s.includes('بقر') || s.includes('cow')) return 'أبقار';
  return safe(e?.nutrition?.context?.species);
}

function eventStatus(e = {}){
  const d = decisionFromEvent(e);
  const p = priorityFromEvent(e);
  const s = String(d?.status || p?.status || e?.nutrition?.analysis?.nutrition?.rumenStatus || '').toLowerCase();
  if(s.includes('danger')) return 'danger';
  if(s.includes('warn') || s.includes('watch')) return 'warn';
  if(s.includes('good') || s.includes('ok')) return 'good';
  return 'muted';
}
function displayStatusFromAnalysis(e = {}){
  const a = e?.nutrition?.analysis || {};
  const n = a.nutrition || {};
  const t = a.targets || {};
  const ec = a.economics || {};

  if(String(n.rumenStatus || '').toLowerCase().includes('danger')) return 'danger';
  if(finite(n.mpBalanceG) && Number(n.mpBalanceG) < -50) return 'danger';
  if(finite(n.nelActual) && finite(t.nelTarget) && Number(n.nelActual) < Number(t.nelTarget) - 0.5) return 'warn';
  if(finite(n.starchPctActual) && finite(t.starchMax) && Number(n.starchPctActual) > Number(t.starchMax)) return 'warn';
  if(finite(n.peNDFPctActual) && finite(t.peNDFMin) && Number(n.peNDFPctActual) < Number(t.peNDFMin)) return 'warn';
  if(finite(ec.milkMargin) && Number(ec.milkMargin) < 0) return 'warn';

  return 'good';
}

function buildDisplayIndexFromEvents(events = []){
  return (Array.isArray(events) ? events : []).map(ev => {
    const a = ev?.nutrition?.analysis || {};
    const ctx = ev?.nutrition?.context || {};
    const stage = eventStage(ev);
    const decision = buildAutoDecision(a, stage, ctx);

    return {
      id: ev.id || null,
      groupName: groupNameFromEvent(ev),
      stage,
      stageLabel: stageLabel(stage, ctx),
      species: String(ctx.species || ''),
      speciesLabel: speciesLabelFromEvent(ev),
      eventDate: ev.eventDate || ev.date || null,
      headCount: Number(ev.groupSize || ctx.headCount || 0) || null,
      milkTargetKg: num(ctx?.formulationTarget?.milkKg || ctx.avgMilkKg),
      dmiTarget: a?.targets?.dmiTarget ?? null,
      dmActual: a?.totals?.dmKg ?? null,
      nelTarget: a?.targets?.nelTarget ?? null,
      nelActual: a?.nutrition?.nelActual ?? null,
      mpTargetG: a?.targets?.mpTargetG ?? null,
      mpSupplyG: a?.nutrition?.mpSupplyG ?? null,
      mpBalanceG: a?.nutrition?.mpBalanceG ?? null,
      ndfPctActual: a?.nutrition?.ndfPctActual ?? null,
      starchPctActual: a?.nutrition?.starchPctActual ?? null,
      fatPctActual: a?.nutrition?.fatPctActual ?? null,
      costPerKgMilk: a?.economics?.costPerKgMilk ?? null,
      milkMargin: a?.economics?.milkMargin ?? null,
      reportStatus: displayStatusFromAnalysis(ev),
      decisionText: decision.title,
      priorityText: decision.action
    };
  });
}

function buildDisplayExecutive(index = []){
  const danger = index.filter(x => x.reportStatus === 'danger');
  const warn = index.filter(x => x.reportStatus === 'warn');

  const highestCost = [...index]
    .filter(x => finite(x.costPerKgMilk))
    .sort((a,b) => Number(b.costPerKgMilk) - Number(a.costPerKgMilk))[0] || null;

  const weakestMargin = [...index]
    .filter(x => finite(x.milkMargin))
    .sort((a,b) => Number(a.milkMargin) - Number(b.milkMargin))[0] || null;

  return {
    totalRations: index.length,
    dangerCount: danger.length,
    warningCount: warn.length,
    okCount: index.filter(x => x.reportStatus === 'good').length,
    firstPriority: danger[0] || warn[0] || weakestMargin || highestCost || index[0] || null,
    highestCost,
    weakestMargin
  };
}
function slug(s){
  return String(s || '')
    .trim()
    .replace(/[^\u0600-\u06FFa-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'ration';
}

/* ============================================================
   ستايل التقرير والطباعة
============================================================ */
function injectReportStyles(){
  if(document.getElementById('mbkNutritionReportStyle')) return;

  const style = document.createElement('style');
  style.id = 'mbkNutritionReportStyle';
  style.textContent = `
    html{scroll-behavior:smooth}
    .report-tabs{
      position:sticky;
      top:0;
      z-index:20;
      display:flex;
      gap:8px;
      overflow:auto;
      padding:10px 0;
      margin-bottom:10px;
      background:rgba(248,250,252,.96);
      backdrop-filter:blur(8px);
      border-bottom:1px solid #e2e8f0;
    }
    .report-tabs a{
      flex:0 0 auto;
      text-decoration:none;
      border:1px solid #dce9df;
      background:#fff;
      color:#134e2f;
      border-radius:999px;
      padding:8px 12px;
      font-size:12px;
      font-weight:950;
      white-space:nowrap;
    }
    .report-tabs a.main{
      background:#0f5d35;
      color:#fff;
      border-color:#0f5d35;
    }
    .executive-hero{
      display:grid;
      grid-template-columns:1.15fr .85fr;
      gap:12px;
      align-items:stretch;
    }
    .hero-main{
      border:1px solid #dfe9e2;
      background:linear-gradient(135deg,#f0fbf4,#fff);
      border-radius:22px;
      padding:16px;
    }
    .hero-title{
      font-size:24px;
      font-weight:950;
      color:#123d2a;
      line-height:1.35;
      margin:0 0 8px;
    }
    .hero-desc{
      font-size:13px;
      font-weight:850;
      color:#475569;
      line-height:1.9;
    }
    .hero-side{
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:8px;
    }
    .status-chip{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border-radius:999px;
      padding:5px 10px;
      font-size:11px;
      font-weight:950;
      border:1px solid #bbf7d0;
      background:#ecfdf3;
      color:#166534;
      white-space:nowrap;
      vertical-align:middle;
    }
    .status-chip.warn{
      background:#fff7ed;
      color:#c2410c;
      border-color:#fed7aa;
    }
    .status-chip.danger{
      background:#fff1f2;
      color:#b91c1c;
      border-color:#fecdd3;
    }
    .status-chip.muted{
      background:#f1f5f9;
      color:#475569;
      border-color:#e2e8f0;
    }
    .decision-box{
      border:1px solid #dfe9e2;
      background:#fbfdfb;
      border-radius:20px;
      padding:14px;
      margin-bottom:12px;
    }
    .decision-head{
      display:flex;
      gap:8px;
      align-items:center;
      justify-content:space-between;
      flex-wrap:wrap;
      margin-bottom:8px;
    }
    .decision-title{
      font-size:16px;
      font-weight:950;
      color:#123d2a;
    }
    .decision-text{
      font-size:15px;
      font-weight:950;
      color:#0f172a;
      line-height:1.8;
    }
    .decision-note{
      margin-top:6px;
      color:#475569;
      font-size:12.5px;
      font-weight:850;
      line-height:1.85;
    }
    .metric-table{
      width:100%;
      min-width:0;
      border-collapse:collapse;
      border-spacing:0;
    }
    .metric-table th,
    .metric-table td{
      border:1px solid #e1ece4 !important;
      border-radius:0 !important;
      background:#fff;
      padding:9px;
      font-size:12.5px;
      font-weight:850;
      line-height:1.55;
      vertical-align:middle;
    }
    .metric-table th{
      background:#eef7f0 !important;
      color:#143d2b;
      font-weight:950;
    }
    .metric-name{
      font-weight:950 !important;
      color:#173126;
    }
    .small-note{
      font-size:12px;
      font-weight:850;
      color:#64748b;
      line-height:1.8;
    }
    .ration-block{
      break-inside:auto;
      page-break-inside:auto;
      scroll-margin-top:90px;
    }
    .ration-break{
      break-before:page;
      page-break-before:always;
    }
    .priority-list{
      margin:0;
      padding-inline-start:22px;
      color:#334155;
      font-weight:900;
      line-height:1.95;
      font-size:13px;
    }
    .screen-actions-row{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      margin-top:10px;
    }
    .screen-actions-row a,
    .screen-actions-row button{
      text-decoration:none;
      border-radius:12px;
      padding:9px 12px;
      font-weight:950;
      font-size:12px;
      border:1px solid #dfe9e2;
      color:#134e2f;
      background:#eef7f0;
      cursor:pointer;
    }
    .ration-head-grid{
      display:grid;
      grid-template-columns:1fr auto;
      gap:10px;
      align-items:start;
    }
    .compact-grid{
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:8px;
    }
    .analysis-subtitle{
      font-weight:950;
      color:#123d2a;
      margin:14px 0 8px;
      font-size:14px;
    }

    @media(max-width:760px){
      .executive-hero{grid-template-columns:1fr}
      .hero-side{grid-template-columns:repeat(2,minmax(0,1fr))}
      .compact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .metric-table{min-width:760px}
      .ration-head-grid{grid-template-columns:1fr}
    }

    @media print{
      .report-tabs,
      .screen-actions-row{display:none !important}
      .executive-hero{grid-template-columns:1.1fr .9fr}
      .hero-main,
      .decision-box{
        border-radius:0;
        box-shadow:none;
      }
      .hero-title{font-size:20pt}
      .status-chip{border-radius:0}
      .ration-break{
        break-before:page;
        page-break-before:always;
      }
      .metric-table th,
      .metric-table td{
        font-size:8.7pt;
        padding:2.4mm;
      }
      .decision-text{font-size:11pt}
      .decision-note{font-size:9pt}
      .card{break-inside:auto;page-break-inside:auto}
    }
  `;
  document.head.appendChild(style);
}

/* ============================================================
   HTML blocks
============================================================ */
function section(title, html, extraClass = ''){
  return `<section class="card ${extraClass}">
    <div class="section-title">${esc(title)}</div>
    ${html}
  </section>`;
}

function kpi(label, value, note = '', state = ''){
  return `<div class="kpi">
    <b>${esc(value)}</b>
    <span>${esc(label)}</span>
    ${note ? `<div class="small-note">${esc(note)}</div>` : ''}
    ${state ? `<div style="margin-top:7px">${badge(statusText(state), state)}</div>` : ''}
  </div>`;
}

function mini(title, value, note = '', state = ''){
  return `<div class="mini">
    <div class="name">${esc(title)} ${state ? badge(statusText(state), state) : ''}</div>
    <div class="value">${esc(value)}</div>
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
  </div>`;
}

function table(headers, rows, empty = 'لا توجد بيانات.'){
  const head = headers.map(h => `<th>${esc(h)}</th>`).join('');
  const body = rows && rows.length
    ? rows.join('')
    : `<tr><td colspan="${headers.length}">${esc(empty)}</td></tr>`;

  return `<div class="table-wrap">
    <table class="metric-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

/* ============================================================
   API
============================================================ */
async function apiGet(path){
  const uid = await waitTenant();
  const headers = { 'Cache-Control': 'no-store' };
  if(uid) headers['X-User-Id'] = uid;

  const res = await fetch(API_BASE + path, { headers, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if(!res.ok || data.ok === false){
    throw new Error(data.message || data.error || `HTTP ${res.status}`);
  }
  return data;
}

function buildPath(){
  const type = qp.get('type') || '';
  const view = qp.get('view') || '';
  let scope = qp.get('scope') || '';

  // الافتراضي الآن تقرير شامل، حتى لا يفتح المستخدم عليقة واحدة ويتوه.
  if(!scope && view) scope = 'all';
  if(!scope) scope = 'all';

  const p = new URLSearchParams();
  p.set('scope', scope);
  if(type) p.set('type', type);
  if(qp.get('stage')) p.set('stage', qp.get('stage'));
  if(qp.get('groupName')) p.set('groupName', qp.get('groupName'));
  if(qp.get('group')) p.set('group', qp.get('group'));

  return `/api/nutrition/report/latest?${p.toString()}`;
}

/* ============================================================
   ملخص الحلاب
============================================================ */
function adviceForSummary(groups = [], totals = {}){
  const notes = [];
  const weakest = [...groups].sort((a,b) => Number(a.marginPerHead || 0) - Number(b.marginPerHead || 0))[0];
  const highCost = [...groups].sort((a,b) => Number(b.costPerKgMilk || 0) - Number(a.costPerKgMilk || 0))[0];

  if(weakest?.groupName){
    notes.push(`أولوية التدخل الأولى: ${weakest.groupName} لأنها الأقل في هامش اللبن بعد العلف.`);
  }
  if(highCost?.groupName && highCost.costPerKgMilk){
    notes.push(`راجع تكلفة العليقة في ${highCost.groupName} لأنها الأعلى في تكلفة كجم اللبن.`);
  }
  if(Number(totals.totalMargin) < 0){
    notes.push('الهامش الكلي للحلاب سلبي؛ راجع سعر اللبن وتكلفة الخامات فورًا.');
  }
  if(!notes.length){
    notes.push('المؤشرات العامة مستقرة. راجع تفاصيل كل مجموعة للتدخل الدقيق.');
  }

  return notes.slice(0, 3);
}

function renderSummary(data){
  const s = data.summary || {};
  const totals = s.totals || {};
  const groups = Array.isArray(s.groups) ? s.groups : [];
  const type = qp.get('type') || data.type || '';
  const typeLabel = String(type).toLowerCase().includes('buffalo') ? 'جاموس' : 'أبقار';

  $('reportTitle').textContent = `تقرير الإنتاج الاقتصادي للحلاب — ${typeLabel}`;
  $('reportSub').textContent = 'ملخص اقتصادي لآخر تحليلات الحلاب المحفوظة، بدون إعادة حساب.';
  $('statusBox').style.display = 'none';

  const rows = groups.map(gp => {
    const name = gp.groupName || 'مجموعة بدون اسم';
    const href = `nutrition-report.html?scope=group&type=${encodeURIComponent(type)}&groupName=${encodeURIComponent(name)}`;
    const state = Number(gp.marginPerHead || 0) < 0 ? 'danger' : (Number(gp.costPerKgMilk || 0) > Number(totals.costPerKgMilk || 0) ? 'warn' : 'good');

    return `<tr class="click" onclick="location.href='${href}'">
      <td class="metric-name">${esc(name)} ${badge(statusText(state), state)}</td>
      <td>${nf(gp.headCount,0)}</td>
      <td>${kg(gp.avgMilkKg,1)}</td>
      <td>${kg(gp.totalMilkKg,1)}</td>
      <td>${money(gp.feedCostPerHead)}</td>
      <td>${money(gp.costPerKgMilk)}</td>
      <td>${money(gp.marginPerHead)}</td>
      <td>${money(gp.totalMargin)}</td>
    </tr>`;
  });

  const advice = adviceForSummary(groups, totals).map(x => `<li>${esc(x)}</li>`).join('');

  $('content').innerHTML = `
    ${section('ملخص تنفيذي', `
      <div class="executive-hero">
        <div class="hero-main">
          <h2 class="hero-title">مؤشر الحلاب الاقتصادي</h2>
          <div class="hero-desc">
            هذا الملخص يوضح صورة تكلفة العلف وإنتاج اللبن والهامش لكل مجموعات الحلاب المحفوظة.
            استخدمه لتحديد المجموعة التي تحتاج تدخلًا اقتصاديًا أولًا.
          </div>
        </div>
        <div class="hero-side">
          ${kpi('عدد الرؤوس', nf(totals.headCount,0))}
          ${kpi('إجمالي اللبن', kg(totals.totalMilkKg,1))}
          ${kpi('تكلفة العلف اليومية', money(totals.totalFeedCost))}
          ${kpi('هامش اللبن بعد العلف', money(totals.totalMargin), '', Number(totals.totalMargin) < 0 ? 'danger' : 'good')}
        </div>
      </div>
    `)}

    ${section('أولويات سريعة', `<ul class="priority-list">${advice}</ul>`)}

    ${section('مقارنة مجموعات الحلاب', table(
      ['المجموعة','الرؤوس','لبن/رأس','إجمالي اللبن','تكلفة رأس','تكلفة كجم اللبن','هامش/رأس','إجمالي الهامش'],
      rows,
      'لا توجد مجموعات حلاب محفوظة.'
    ))}
  `;
}

/* ============================================================
   تحليل عليقة واحدة
============================================================ */
function buildAutoDecision(a = {}, stage = '', ctx = {}){
  const n = a.nutrition || {};
  const t = a.targets || {};
  const e = a.economics || {};

  if(finite(n.mpBalanceG) && Number(n.mpBalanceG) < -50){
    return {
      title:'العليقة تحتاج مراجعة البروتين الممثل.',
      action:'راجع مصدر البروتين الحقيقي والهضم/RUP قبل رفع البروتين الخام.'
    };
  }

  if(finite(n.nelActual) && finite(t.nelTarget) && Number(n.nelActual) < Number(t.nelTarget) - 0.5){
    return {
      title:'العليقة تحتاج دعم طاقة محسوب.',
      action:'راجع كثافة الطاقة ومصادرها مع الحفاظ على أمان الكرش.'
    };
  }

  if(finite(n.starchPctActual) && finite(t.starchMax) && Number(n.starchPctActual) > Number(t.starchMax)){
    return {
      title:'العليقة تحتاج مراجعة النشا وصحة الكرش.',
      action:'راجع مصدر النشا السريع وارفع الألياف الفعالة إذا لزم.'
    };
  }

  if(isCloseUp(stage, ctx) && finite(n.dcadModel?.dcadMeqKgDM) && Number(n.dcadModel.dcadMeqKgDM) > -50){
    return {
      title:'عليقة انتظار الولادة تحتاج مراجعة DCAD.',
      action:'راجع أملاح الأنيون والكالسيوم والماغنسيوم تحت إشراف فني.'
    };
  }

  if(isLactating(stage, ctx) && finite(e.milkMargin) && Number(e.milkMargin) < 0){
    return {
      title:'العليقة اقتصاديًا تحتاج تدخلًا.',
      action:'راجع سعر اللبن وتكلفة الخامات الأعلى مساهمة في التكلفة.'
    };
  }

  return {
    title:'العليقة مقبولة تشغيليًا حسب البيانات المحفوظة.',
    action:'استمر في متابعة اللبن والروث والمتبقي وتغيّر أسعار الخامات.'
  };
}

function renderDecisionBlock(e = {}, a = {}, stage = '', ctx = {}){
  const displayDecision = buildAutoDecision(a, stage, ctx);
  const state = displayStatusFromAnalysis(e);

  return `<div class="decision-box">
    <div class="decision-head">
      <div class="decision-title">قراءة مُرَبِّيك</div>
      ${badge(statusText(state), state)}
    </div>
    <div class="decision-text">${esc(displayDecision.title)}</div>
    <div class="decision-note"><b>توصية مُرَبِّيك:</b> ${esc(displayDecision.action)}</div>
  </div>`;
}
function renderContextBlock(ctx = {}, event = {}, stage = ''){
  const profile = ctx.groupNutritionProfile || {};
  const hom = ctx.homogeneity || {};
  const ft = ctx.formulationTarget || {};

  return section('بطاقة تعريف العليقة', `<div class="compact-grid">
    ${kpi('العليقة / المجموعة', ctx.groupName || ctx.group || ctx.groupLabel || '—')}
    ${kpi('المرحلة', stageLabel(stage, ctx))}
    ${kpi('النوع', safe(ctx.species))}
    ${kpi('عدد الرؤوس', nf(event.groupSize || ctx.headCount,0))}
    ${kpi('هدف اللبن', finite(ft.milkKg || ctx.avgMilkKg) ? kg(ft.milkKg || ctx.avgMilkKg,1) : '—')}
    ${kpi('متوسط اللبن المرصود', finite(ctx.observedAvgMilkKg || ctx.avgMilkKg) ? kg(ctx.observedAvgMilkKg || ctx.avgMilkKg,1) : '—')}
    ${kpi('تجانس المجموعة', hom.status ? `${safe(hom.status)} / ${nf(hom.score,0)}` : '—')}
    ${kpi('تاريخ التحليل', safe(event.eventDate || event.date))}
    ${kpi('السلالة', safe(ctx.breed))}
    ${kpi('DIM', nf(ctx.daysInMilk,0))}
    ${kpi('DCC', nf(ctx.pregnancyDays,0))}
    ${kpi('متبقي للولادة', nf(ctx.daysToCalving,0))}
    ${kpi('الوزن المستخدم', finite(ctx.bodyWeight || ctx.bodyWeightKg) ? kg(ctx.bodyWeight || ctx.bodyWeightKg,0) : '—')}
    ${kpi('BCS', nf(ctx.bcs || ctx.groupBcs,2))}
    ${kpi('دهن اللبن', finite(ctx.milkFatPct) ? pct(ctx.milkFatPct,1) : '—')}
    ${kpi('بروتين اللبن', finite(ctx.milkProteinPct) ? pct(ctx.milkProteinPct,1) : '—')}
  </div>
  ${profile.method || ft.reason ? `<div class="small-note" style="margin-top:10px">
    ${profile.method ? `مصدر البصمة: ${esc(profile.method)}. ` : ''}
    ${ft.reason ? `هدف التركيب: ${esc(ft.reason)}.` : ''}
  </div>` : ''}`);
}

function metricRow(name, need, supply, balance, state, note = ''){
  return `<tr>
    <td class="metric-name">${esc(name)}</td>
    <td>${esc(need)}</td>
    <td>${esc(supply)}</td>
    <td>${esc(balance)}</td>
    <td>${badge(statusText(state), state)}</td>
    <td>${esc(note || '—')}</td>
  </tr>`;
}

function mineralVal(item, keyG, keyMg){
  const v = item?.[keyG] ?? item?.[keyMg];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function mineralStatus(item = {}){
  const s = String(item.status || '').toLowerCase();
  if(s.includes('deficit')) return 'danger';
  if(s.includes('excess')) return 'warn';
  if(s.includes('warn') || s.includes('watch')) return 'warn';
  if(s.includes('ok')) return 'good';
  return 'muted';
}

function mineralStatusText(item = {}){
  const s = String(item.status || '').toLowerCase();
  if(s.includes('deficit')) return 'نقص';
  if(s.includes('excess')) return 'زيادة';
  if(s.includes('ok')) return 'مقبول';
  if(s.includes('warn') || s.includes('watch')) return 'مراجعة';
  return 'متابعة';
}

function mineralRows(balance = {}, unit = 'g'){
  const orderMacro = ['Ca','P','Mg','Na','K','Cl','S'];
  const orderTrace = ['Co','Cu','Fe','I','Mn','Se','Zn'];
  const order = unit === 'mg' ? orderTrace : orderMacro;

  return order
    .filter(k => balance && balance[k])
    .map(k => {
      const item = balance[k] || {};
      const required = unit === 'mg'
        ? mineralVal(item, 'requiredMg', 'requiredG')
        : mineralVal(item, 'requiredG', 'requiredMg');

      const supplied = unit === 'mg'
        ? mineralVal(item, 'suppliedMg', 'suppliedG')
        : mineralVal(item, 'suppliedG', 'suppliedMg');

      const bal = unit === 'mg'
        ? mineralVal(item, 'balanceMg', 'balanceG')
        : mineralVal(item, 'balanceG', 'balanceMg');

      const cover = num(item.supplyPctOfRequirement);

      return metricRow(
        k,
        required == null ? '—' : `${nf(required, 2)} ${unit}`,
        supplied == null ? '—' : `${nf(supplied, 2)} ${unit}`,
        bal == null ? '—' : `${nf(bal, 2)} ${unit}`,
        mineralStatus(item),
        Number.isFinite(cover) ? `تغطية ${nf(cover,1)}%` : '—'
      );
    });
}

function vitaminRows(balance = {}){
  return ['A','D','E']
    .filter(k => balance && balance[k])
    .map(k => {
      const item = balance[k] || {};
      const required = num(item.requiredIU);
      const supplied = num(item.suppliedIU);
      const bal = num(item.balanceIU);
      const cover = num(item.supplyPctOfRequirement);
      const label = k === 'A' ? 'فيتامين أ' : (k === 'D' ? 'فيتامين د' : 'فيتامين هـ');
      return metricRow(
        label,
        Number.isFinite(required) ? `${nf(required, 0)} وحدة دولية` : '—',
        Number.isFinite(supplied) ? `${nf(supplied, 0)} وحدة دولية` : '—',
        Number.isFinite(bal) ? `${nf(bal, 0)} وحدة دولية` : '—',
        mineralStatus(item),
        Number.isFinite(cover) ? `تغطية ${nf(cover,1)}%` : '—'
      );
    });
}

function renderCompleteRationAnalysis(a = {}, stage = '', ctx = {}){
  const n = a.nutrition || {};
  const t = a.targets || {};
  const totals = a.totals || {};
  const e = a.economics || {};

  const supply = n.mineralSupplyModel || {};
  const vitSupply = n.vitaminSupplyModel || {};
  const dcad = n.dcadModel || {};
  const macroBalance = supply?.mineralBalanceModel?.balance || {};
  const traceBalance = supply?.traceMineralBalanceModel?.balance || {};
  const vitBalance = vitSupply?.vitaminBalanceModel?.balance || {};

  const dmBal = finite(totals.dmKg) && finite(t.dmiTarget) ? Number(totals.dmKg) - Number(t.dmiTarget) : null;
  const nelBal = finite(n.nelActual) && finite(t.nelTarget) ? Number(n.nelActual) - Number(t.nelTarget) : null;
  const mpBal = finite(n.mpBalanceG) ? Number(n.mpBalanceG) : (finite(n.mpSupplyG) && finite(t.mpTargetG) ? Number(n.mpSupplyG) - Number(t.mpTargetG) : null);

  const rh = n.rumenHealthModel || {};
  const rumenState = rh.status || n.rumenStatus || 'muted';
  const dcadVal = n.dcadModel?.dcadMeqKgDM;

  const rows = [
metricRow('المادة الجافة المأكولة (DMI)', kg(t.dmiTarget,2), kg(totals.dmKg,2), finite(dmBal) ? kg(dmBal,2) : '—', 'muted', 'المادة الجافة المأكولة الفعلية من العليقة مقارنةً بالمأكول المتوقع للحيوان. اضبط الكمية حسب المتبقي على المعلف وتأكد من الشبع للأبقار.'),

metricRow('الطاقة الصافية للحليب (NEL)', `${nf(t.nelTarget,2)} ميجا كالوري/يوم`, `${nf(n.nelActual,2)} ميجا كالوري/يوم`, finite(nelBal) ? `${nf(nelBal,2)} ميجا كالوري` : '—', balanceState(nelBal, 0.5), mbkAdvice('energy', balanceState(nelBal, 0.5), 'balance')),

metricRow('البروتين الممثل القابل للاستفادة (MP)', g(t.mpTargetG,0), g(n.mpSupplyG,0), g(mpBal,0), balanceState(mpBal, 50), mbkAdvice('mp', balanceState(mpBal, 50), 'balance')),

metricRow('البروتين الخام (CP)', pct(t.cpTarget,1), pct(n.cpPctTotal,1), finite(n.cpPctTotal) && finite(t.cpTarget) ? pct(Number(n.cpPctTotal) - Number(t.cpTarget),1) : '—', balanceState(finite(n.cpPctTotal) && finite(t.cpTarget) ? Number(n.cpPctTotal) - Number(t.cpTarget) : null, 0.7), mbkAdvice('cp', balanceState(finite(n.cpPctTotal) && finite(t.cpTarget) ? Number(n.cpPctTotal) - Number(t.cpTarget) : null, 0.7), 'balance')),

metricRow('الألياف المتعادلة (NDF)', pct(t.ndfTarget,1), pct(n.ndfPctActual,1), finite(n.ndfPctActual) && finite(t.ndfTarget) ? pct(Number(n.ndfPctActual) - Number(t.ndfTarget),1) : '—', balanceState(finite(n.ndfPctActual) && finite(t.ndfTarget) ? Number(n.ndfPctActual) - Number(t.ndfTarget) : null, 1.5), mbkAdvice('ndf', balanceState(finite(n.ndfPctActual) && finite(t.ndfTarget) ? Number(n.ndfPctActual) - Number(t.ndfTarget) : null, 1.5), 'balance')),

metricRow('الألياف الفعالة للكرش (peNDF)', `حد أدنى ${pct(t.peNDFMin,1)}`, pct(n.peNDFPctActual,1), finite(n.peNDFPctActual) && finite(t.peNDFMin) ? pct(Number(n.peNDFPctActual) - Number(t.peNDFMin),1) : '—', minLimitState(n.peNDFPctActual, t.peNDFMin), mbkAdvice('pendf', minLimitState(n.peNDFPctActual, t.peNDFMin), 'min')),

metricRow('النشا', `حد أقصى ${pct(t.starchMax,1)}`, pct(n.starchPctActual,1), finite(n.starchPctActual) && finite(t.starchMax) ? pct(Number(n.starchPctActual) - Number(t.starchMax),1) : '—', highLimitState(n.starchPctActual, t.starchMax), mbkAdvice('starch', highLimitState(n.starchPctActual, t.starchMax), 'max')),

metricRow('دهن العليقة', 'حد تشغيلي', pct(n.fatPctActual,1), '—', finite(n.fatPctActual) && Number(n.fatPctActual) > 7 ? 'warn' : 'good', mbkAdvice('fat', finite(n.fatPctActual) && Number(n.fatPctActual) > 7 ? 'warn' : 'good', 'max')),

metricRow('صحة الكرش', 'آمن', rh.title || n.rumenStatus || '—', '—', rumenState, rh.reason || n.rumenNote || '—'),

metricRow('نسبة الخشن من المادة الجافة', `حد أدنى ${pct(t.roughageMin,1)}`, pct(n.roughPctDM,1), finite(n.roughPctDM) && finite(t.roughageMin) ? pct(Number(n.roughPctDM) - Number(t.roughageMin),1) : '—', minLimitState(n.roughPctDM, t.roughageMin), mbkAdvice('roughage', minLimitState(n.roughPctDM, t.roughageMin), 'min')),

metricRow('الألياف المتعادلة من الخشن (Forage NDF)', `حد أدنى ${pct(t.forageNDFMin,1)}`, pct(n.forageNDFPctDM,1), finite(n.forageNDFPctDM) && finite(t.forageNDFMin) ? pct(Number(n.forageNDFPctDM) - Number(t.forageNDFMin),1) : '—', minLimitState(n.forageNDFPctDM, t.forageNDFMin), mbkAdvice('forageNdf', minLimitState(n.forageNDFPctDM, t.forageNDFMin), 'min'))
  ];

  if(isLactating(stage, ctx)){
    rows.push(metricRow('تكلفة كجم اللبن', 'أقل أفضل', money(e.costPerKgMilk), '—', 'muted', 'مؤشر اقتصادي للحلاب.'));
    rows.push(metricRow('هامش لبن-علف/رأس', 'موجب', money(e.milkMargin), '—', finite(e.milkMargin) && Number(e.milkMargin) < 0 ? 'danger' : 'good', 'أهم مؤشر ربحية يومي.'));
    rows.push(metricRow('إيراد اللبن/رأس', 'حسب السعر', money(e.milkRevenue), '—', 'muted', 'مرتبط بسعر اللبن المدخل.'));
    rows.push(metricRow('مادة جافة / كجم لبن', 'أقل أفضل مع ثبات الصحة', kg(e.dmPerKgMilk,2), '—', 'muted', 'مؤشر لكفاءة تحويل العلف.'));
  }

  if(isCloseUp(stage, ctx)){
   rows.push(metricRow('ميزان الكاتيونات والأنيونات الغذائي (DCAD)', 'نطاق انتظار الولادة', finite(dcadVal) ? `${nf(dcadVal,0)} ملي مكافئ/كجم مادة جافة` : '—', '—', finite(dcadVal) && Number(dcadVal) > -50 ? 'warn' : 'good', dcad?.note || 'راجع الكالسيوم والماغنسيوم وأملاح الأنيون تحت إشراف فني.'));
  }

  const macro = mineralRows(macroBalance, 'g');
  const trace = mineralRows(traceBalance, 'mg');
  const vit = vitaminRows(vitBalance);

  const mineralHeader = (macro.length || trace.length || vit.length)
   ? `<div class="analysis-subtitle">العناصر المعدنية والفيتامينات</div>`
    : '';

  return section('تحليل العليقة الكامل', `
    ${rh.instruction ? `<div class="decision-box">
      <div class="decision-head">
        <div class="decision-title">توجيه صحة الكرش</div>
        ${badge(statusText(rumenState), rumenState)}
      </div>
      <div class="decision-text">${esc(rh.title || '—')}</div>
      <div class="decision-note">${esc(rh.instruction)}</div>
    </div>` : ''}

  ${table(['البند','المتوقع / الاحتياج / الحد','الإمداد / الفعلي','الفرق','قراءة مُرَبِّيك','توصية مُرَبِّيك'], rows)}

    ${mineralHeader}
    ${(macro.length || trace.length || vit.length) ? table(
      ['العنصر','الاحتياج','الإمداد','الميزان','قراءة مُرَبِّيك','توصية مُرَبِّيك'],
      [...macro, ...trace, ...vit],
      'لا توجد عناصر محفوظة داخل التحليل.'
    ) : ''}
  `);
}

function renderRows(rows = []){
  const body = (Array.isArray(rows) ? rows : []).map(r => {
    const asFed = num(r.asFedKg ?? r.kg ?? r.amount);
    const dmPct = num(r.dmPct ?? r.dm);
    const cpPct = num(r.cpPct ?? r.cp);
    const ndfPct = num(r.ndfPct ?? r.ndf);
    const starchPct = num(r.starchPct ?? r.starch);
    const fatPct = num(r.fatPct ?? r.fat ?? r.crudeFatPct);
    const price = num(r.pricePerTon ?? r.pTon ?? r.price ?? r.pTonRaw);

    const dmKg = finite(asFed) && finite(dmPct) ? Number(asFed) * Number(dmPct) / 100 : null;
    const cpKg = finite(dmKg) && finite(cpPct) ? Number(dmKg) * Number(cpPct) / 100 : null;
    const ndfKg = finite(dmKg) && finite(ndfPct) ? Number(dmKg) * Number(ndfPct) / 100 : null;
    const starchKg = finite(dmKg) && finite(starchPct) ? Number(dmKg) * Number(starchPct) / 100 : null;
    const cost = finite(asFed) && finite(price) ? Number(asFed) * Number(price) / 1000 : null;

    return `<tr>
      <td class="metric-name">${esc(r.name || r.nameAr || r.feedName || r.id || 'خامة')}</td>
      <td>${esc(r.cat || r.category || '—')}</td>
      <td>${kg(asFed,2)}</td>
      <td>${kg(dmKg,2)}</td>
      <td>${kg(cpKg,2)}</td>
      <td>${kg(ndfKg,2)}</td>
      <td>${kg(starchKg,2)}</td>
      <td>${pct(fatPct,1)}</td>
      <td>${money(cost)}</td>
    </tr>`;
  });

  return section('تركيبة العليقة ومساهمة الخامات', table(
   ['الخامة','الفئة','كجم طازج (as-fed)','كجم مادة جافة','كجم بروتين خام','كجم ألياف متعادلة','كجم نشا','دهن %','تكلفة/رأس'],
    body,
    'لا توجد خامات محفوظة.'
  ));
}
function renderOneRation(event = {}, opts = {}){
  const nDoc = event.nutrition || {};
  const a = nDoc.analysis || {};
  const ctx = nDoc.context || {};
  const rows = nDoc.rows || [];
  const stage = opts.stage || eventStage(event) || ctx.groupType || '';
  const groupName = opts.groupName || groupNameFromEvent(event);
  const id = opts.id || `ration-${slug(groupName)}`;
  const breakClass = opts.pageBreak ? 'ration-break' : '';

  return `<div id="${esc(id)}" class="ration-block ${breakClass}">
    ${section(`تقرير عليقة: ${groupName}`, `
      <div class="ration-head-grid">
        <div>${renderDecisionBlock(event, a, stage, ctx)}</div>
        <div>
        ${badge(stageLabel(stage, ctx), displayStatusFromAnalysis(event))}
          ${badge(speciesLabelFromEvent(event), 'muted')}
        </div>
      </div>
      <div class="screen-actions-row">
        <a href="#top">أعلى التقرير</a>
        <a href="nutrition-report.html?scope=group&type=${encodeURIComponent(qp.get('type') || '')}&groupName=${encodeURIComponent(groupName)}">فتح منفرد</a>
      </div>
    `)}
    ${renderContextBlock(ctx, event, stage)}
    ${renderCompleteRationAnalysis(a, stage, ctx)}
    ${renderRows(rows)}
   
  </div>`;
}

function renderGroup(data){
  const e = data.event || {};
  const groupName = data.groupName || groupNameFromEvent(e);
  const stage = data.stage || eventStage(e);

  $('reportTitle').textContent = `تقرير تغذية: ${groupName}`;
  $('reportSub').textContent = `${stageLabel(stage, e?.nutrition?.context || {})} — تاريخ التحليل: ${safe(e.eventDate || e.date)} — تقرير عليقة منفردة`;
  $('statusBox').style.display = 'none';

  $('content').innerHTML = `
    <div id="top"></div>
    <nav class="report-tabs">
      <a class="main" href="#${esc(`ration-${slug(groupName)}`)}">العليقة</a>
      <a href="nutrition-report.html?scope=all&type=${encodeURIComponent(qp.get('type') || '')}">كل العلائق</a>
    </nav>
    ${renderOneRation(e, { groupName, stage, pageBreak:false })}
  `;
}

/* ============================================================
   التقرير الشامل scope=all
============================================================ */
function renderExecutiveAll(report = {}, type = ''){
  const ex = report.executive || {};
  const typeLabel = String(type).toLowerCase().includes('buffalo') ? 'جاموس' : (String(type).toLowerCase().includes('cows') ? 'أبقار' : 'كل الأنواع');

  const first = ex.firstPriority || {};
  const highCost = ex.highestCost || {};
  const weak = ex.weakestMargin || {};

  return section('الملخص التنفيذي', `
    <div class="executive-hero">
      <div class="hero-main">
        <h2 class="hero-title">تقرير التغذية الشامل — ${esc(typeLabel)}</h2>
        <div class="hero-desc">
تقرير عملي يلخص العلائق المحفوظة، ثم يعرض مقارنة مختصرة وتفاصيل كل عليقة.
اقرأ جدول الاتزان أولًا، ثم راجع تركيبة العليقة والخامات.
        </div>
        <div style="margin-top:12px">
          ${first.groupName ? badge(`تحتاج مراجعة: ${first.groupName}`, first.reportStatus) : badge('معلومة عامة','muted')}
        </div>
      </div>

      <div class="hero-side">
        ${kpi('عدد العلائق', nf(ex.totalRations,0))}
${kpi('علائق بها تنبيه', nf(ex.dangerCount,0), '', ex.dangerCount ? 'danger' : 'good')}
${kpi('علائق تحتاج ضبط', nf(ex.warningCount,0), '', ex.warningCount ? 'warn' : 'good')}
${kpi('علائق متزنة', nf(ex.okCount,0), '', 'good')}
      </div>
    </div>

    <div class="cards" style="margin-top:12px">
     ${mini('أهم قراءة الآن', first.groupName || '—', first.priorityText || first.decisionText || '—', first.reportStatus)}
      ${mini('أعلى تكلفة كجم لبن', highCost.groupName || '—', finite(highCost.costPerKgMilk) ? money(highCost.costPerKgMilk) : '—', finite(highCost.costPerKgMilk) ? 'warn' : 'muted')}
      ${mini('أضعف هامش لبن-علف', weak.groupName || '—', finite(weak.milkMargin) ? money(weak.milkMargin) : '—', finite(weak.milkMargin) && Number(weak.milkMargin) < 0 ? 'danger' : 'warn')}
      ${mini('شكل التقرير', 'مفهرس ومبوب', 'اختَر العليقة من الشريط أو الفهرس.')}
    </div>
  `);
}

function renderRationIndex(report = {}, type = ''){
  const index = Array.isArray(report.index) ? report.index : [];

  const rows = index.map((x, i) => {
    const id = `ration-${slug(x.groupName || `r${i}`)}`;
    return `<tr>
      <td>${i + 1}</td>
      <td class="metric-name"><a href="#${esc(id)}" style="color:#134e2f;font-weight:950">${esc(x.groupName || '—')}</a></td>
      <td>${esc(x.stageLabel || '—')}</td>
      <td>${esc(x.speciesLabel || '—')}</td>
      <td>${nf(x.headCount,0)}</td>
      <td>${finite(x.milkTargetKg) ? kg(x.milkTargetKg,1) : '—'}</td>
      <td>${x.reportStatus ? badge(statusText(x.reportStatus), x.reportStatus) : badge('متابعة','muted')}</td>
      <td>${esc(x.priorityText || x.decisionText || 'متابعة دورية')}</td>
    </tr>`;
  });

  return section('فهرس العلائق داخل التقرير', table(
    ['#','العليقة','المرحلة','النوع','الرؤوس','هدف اللبن','الحالة','أول توجيه'],
    rows,
    'لا توجد علائق داخل التقرير.'
  ));
}

function renderAllComparison(report = {}){
  const index = Array.isArray(report.index) ? report.index : [];

  const rows = index.map(x => `<tr>
    <td class="metric-name">${esc(x.groupName || '—')}</td>
    <td>${esc(x.stageLabel || '—')}</td>
    <td>${kg(x.dmActual,2)} / ${kg(x.dmiTarget,2)}</td>
    <td>${nf(x.nelActual,2)} / ${nf(x.nelTarget,2)}</td>
    <td>${g(x.mpSupplyG,0)} / ${g(x.mpTargetG,0)}</td>
    <td>${g(x.mpBalanceG,0)}</td>
    <td>${pct(x.ndfPctActual,1)}</td>
    <td>${pct(x.starchPctActual,1)}</td>
    <td>${money(x.costPerKgMilk)}</td>
    <td>${x.reportStatus ? badge(statusText(x.reportStatus), x.reportStatus) : badge('متابعة','muted')}</td>
  </tr>`);

  return section('مقارنة مختصرة بين العلائق', table(
  ['العليقة','المرحلة','مأكول/متوقع','الطاقة الصافية للحليب (NEL)','البروتين الممثل (MP)','ميزان البروتين الممثل','الألياف المتعادلة (NDF)','نشا','تكلفة كجم اللبن','قراءة مُرَبِّيك'],
    rows,
    'لا توجد بيانات مقارنة.'
  ));
}

function renderTabs(report = {}){
  const index = Array.isArray(report.index) ? report.index : [];
  const links = [
    `<a class="main" href="#top">الملخص</a>`,
    `<a href="#ration-index">الفهرس</a>`,
    `<a href="#comparison">المقارنة</a>`,
    
  ];

  for(const x of index){
    const id = `ration-${slug(x.groupName || '')}`;
    links.push(`<a href="#${esc(id)}">${esc(x.groupName || 'عليقة')}</a>`);
  }

  return `<nav class="report-tabs">${links.join('')}</nav>`;
}

function renderAll(data){
  const report = data.report || {};
  const events = Array.isArray(report.events) ? report.events : [];
   const displayIndex = buildDisplayIndexFromEvents(events);
const displayReport = {
  ...report,
  index: displayIndex,
  executive: buildDisplayExecutive(displayIndex),
  count: displayIndex.length
};
  const type = data.type || qp.get('type') || '';
  const typeLabel = String(type).toLowerCase().includes('buffalo') ? 'جاموس' : (String(type).toLowerCase().includes('cows') ? 'أبقار' : 'كل الأنواع');

  $('reportTitle').textContent = `تقرير التغذية الشامل — ${typeLabel}`;
  $('reportSub').textContent = `عدد العلائق داخل التقرير: ${nf(report.count || events.length,0)} — أحدث تحليل محفوظ لكل عليقة`;
  $('statusBox').style.display = 'none';

  const rationReports = events.map((ev, i) => renderOneRation(ev, {
    groupName: groupNameFromEvent(ev),
    stage: eventStage(ev),
    id: `ration-${slug(groupNameFromEvent(ev) || `r${i}`)}`,
    pageBreak: true
  })).join('');

  $('content').innerHTML = `
    <div id="top"></div>
  ${renderTabs(displayReport)}
${renderExecutiveAll(displayReport, type)}
<div id="ration-index">${renderRationIndex(displayReport, type)}</div>
<div id="comparison">${renderAllComparison(displayReport)}</div>

    ${rationReports}
  `;
}

/* ============================================================
   تشغيل
============================================================ */
async function main(){
  injectReportStyles();

  try{
    const data = await apiGet(buildPath());

    if(data.scope === 'all'){
      renderAll(data);
      return;
    }

    if(data.scope === 'lactating_summary'){
      renderSummary(data);
      return;
    }

    renderGroup(data);

  }catch(e){
    $('reportTitle').textContent = 'تعذر تحميل تقرير التغذية';
    $('reportSub').textContent = 'تأكد من وجود تحليل تغذية محفوظ مطابق ومن تسجيل الدخول.';
    $('statusBox').style.display = 'block';
    $('statusBox').textContent = '⚠️ ' + (e.message || String(e));
  }
}

main();
