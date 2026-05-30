// مُرَبِّيك — تقرير التغذية الاحترافي
// عرض فقط: يقرأ التحليلات المحفوظة من السيرفر ولا يعيد حساب الاحتياجات أو الإمداد.
// نسخة منظمة: تقرير شامل افتراضي + فهرس واضح + تبويب/روابط داخلية + كل تحليل العليقة في كتلة واحدة.

const API_BASE = window.API_BASE || 'https://murabbic-alerts.onrender.com';

const $ = (id) => document.getElementById(id);
const qp = new URLSearchParams(location.search);
const reportDistributionsPerDay = Math.max(
  1,
  Math.min(12, Math.round(Number(qp.get('distributionsPerDay') || 2) || 2))
);
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
  if(s.includes('warn') || s.includes('watch')) return 'متابعة';
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

  ndf: {
    low: 'تحذير ألياف: NDF أقل من حد أمان الكرش الأدنى؛ راجع الخشن قبل زيادة الحبوب.',
    high: 'NDF يغطي حد أمان الكرش الأدنى. الارتفاع الكبير لا يُحكم كخطر مباشر هنا، لكنه قد يضغط المأكول والطاقة حسب جودة الخشن وهضميته.',
    ok: 'NDF يغطي حد أمان الكرش الأدنى؛ تابع الاجترار والروث والمتبقي وصحة الكرش.'
  },
  starch: {
    low: 'النشا أقل من حد الأمان؛ راجعه فقط إذا كان هناك نقص طاقة واضح في كارت الطاقة.',
    high: 'تحذير نشا: النشا تجاوز حد الأمان؛ راجع الحبوب وتوازن الخشن وصحة الكرش.',
    ok: 'النشا داخل حد الأمان؛ استمر مع متابعة الروث والاجترار ودهن اللبن.'
  },
  fat: {
    low: 'دهن العليقة أقل من حد الأمان؛ لا ترفعه إلا إذا احتاجت الطاقة دعمًا وبعد مراجعة مصادر الطاقة.',
    high: 'تحذير دهن: دهن العليقة تجاوز حد الأمان؛ راجع مصدر الدهون لأنه قد يؤثر على هضم الألياف وصحة الكرش.',
    ok: 'دهن العليقة داخل حد الأمان؛ استمر مع متابعة الروث والاجترار وثبات اللبن.'
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
  const cards = e?.nutrition?.panels?.analysisCards || [];

  const cardByKey = (key) =>
    cards.find(c => String(c?.key || '').toLowerCase() === key) || null;

  const starchCard = cardByKey('starch');
  const fatCard = cardByKey('fat');

  const starchOkByServer =
    starchCard && String(starchCard.status || '').toLowerCase() === 'good';

  const fatOkByServer =
    fatCard && String(fatCard.status || '').toLowerCase() === 'good';

  if(String(n.rumenStatus || '').toLowerCase().includes('danger')) return 'danger';

  if(finite(n.mpBalanceG) && Number(n.mpBalanceG) < -50) return 'danger';

  if(
    finite(n.nelActual) &&
    finite(t.nelTarget) &&
    Number(t.nelTarget) > 0 &&
    ((Number(n.nelActual) - Number(t.nelTarget)) / Number(t.nelTarget)) * 100 < -5
  ){
    return 'warn';
  }

  if(
    finite(n.starchPctActual) &&
    finite(t.starchMax) &&
    Number(n.starchPctActual) > Number(t.starchMax) &&
    !starchOkByServer
  ){
    return 'warn';
  }

  if(
    finite(n.fatPctActual) &&
    finite(t.fatTarget) &&
    Number(n.fatPctActual) > Number(t.fatTarget) &&
    !fatOkByServer
  ){
    return 'warn';
  }

  if(finite(n.peNDFPctActual) && finite(t.peNDFMin) && Number(n.peNDFPctActual) < Number(t.peNDFMin)){
    return 'warn';
  }

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
    /* ===============================
       Base
    =============================== */
    html{scroll-behavior:smooth}

    .report-tabs{
      position:sticky;
      top:0;
      z-index:20;
      display:flex;
      gap:8px;
      overflow:auto;
      padding:10px 0;
      margin-bottom:12px;
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

    .small-note{
      font-size:12px;
      font-weight:850;
      color:#64748b;
      line-height:1.8;
    }

    /* ===============================
       Report cover
    =============================== */
    .report-cover{
      position:relative;
      overflow:hidden;
      border:1px solid #dfe9e2;
      background:
        radial-gradient(circle at 12% 18%, rgba(20,120,74,.10), transparent 26%),
        linear-gradient(135deg,#f4fbf6 0%,#ffffff 64%,#eef8f1 100%);
      border-radius:28px;
      padding:26px;
      margin-bottom:16px;
      box-shadow:0 14px 35px rgba(15,93,53,.08);
    }

    .report-cover:after{
      content:"";
      position:absolute;
      width:230px;
      height:230px;
      border-radius:50%;
      background:rgba(15,93,53,.06);
      left:-70px;
      bottom:-95px;
    }

    .report-cover-head{
      position:relative;
      z-index:1;
      display:grid;
      grid-template-columns:1fr auto;
      gap:16px;
      align-items:start;
    }

    .report-kicker{
      font-size:13px;
      font-weight:950;
      color:#0f7a45;
      margin-bottom:8px;
    }

    .report-main-title{
      margin:0;
      max-width:760px;
      font-size:34px;
      font-weight:950;
      color:#123d2a;
      line-height:1.25;
      letter-spacing:-.5px;
    }

    .report-main-subtitle{
      max-width:780px;
      margin-top:10px;
      font-size:14px;
      font-weight:850;
      color:#64748b;
      line-height:1.9;
    }

    .report-logo-box{
      min-width:120px;
      text-align:center;
      border:1px solid #dfe9e2;
      background:rgba(255,255,255,.82);
      border-radius:22px;
      padding:12px;
    }

    .report-logo-box img{
      width:54px;
      height:54px;
      object-fit:contain;
      opacity:.9;
    }

    .report-logo-box div{
      margin-top:6px;
      font-size:11px;
      font-weight:950;
      color:#14532d;
    }

    /* ===============================
       Executive summary
    =============================== */
    .executive-panel{
      display:grid;
      grid-template-columns:1.2fr .8fr;
      gap:14px;
      margin-bottom:16px;
    }

    .executive-reading{
      border:1px solid #dfe9e2;
      background:#fff;
      border-radius:24px;
      padding:18px;
      box-shadow:0 10px 26px rgba(15,93,53,.06);
    }

    .executive-reading h2{
      margin:0 0 8px;
      color:#123d2a;
      font-size:22px;
      font-weight:950;
    }

    .executive-reading p{
      margin:0;
      color:#475569;
      font-size:13px;
      font-weight:850;
      line-height:1.9;
    }

    .executive-badges{
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      margin-top:12px;
    }
    .executive-soft-notes{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  margin-top:12px;
}

.executive-soft-notes span{
  display:inline-flex;
  align-items:center;
  border:1px solid #e2e8f0;
  background:#f8fafc;
  color:#475569;
  border-radius:999px;
  padding:6px 11px;
  font-size:11.5px;
  font-weight:850;
  line-height:1.4;
}
    .executive-score-grid{
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:10px;
    }

    .executive-score{
      border:1px solid #e1ece4;
      background:#fbfdfb;
      border-radius:20px;
      padding:14px;
      text-align:center;
    }

    .executive-score b{
      display:block;
      font-size:28px;
      font-weight:950;
      color:#0f7a45;
      line-height:1;
    }

    .executive-score span{
      display:block;
      margin-top:8px;
      font-size:12px;
      font-weight:950;
      color:#475569;
    }

    /* ===============================
       Sections and cards
    =============================== */
    .report-section-head{
      border:1px solid #dfe9e2;
      background:linear-gradient(135deg,#ffffff,#f5fbf7);
      border-radius:24px;
      padding:18px;
      margin:18px 0 12px;
    }

    .report-section-head .section-title{
      margin:0;
      padding:0;
      border:0;
      font-size:22px;
    }

    .report-section-head .small-note{
      margin-top:6px;
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

    .ration-block > .print-analysis > .card:first-child{
      border-top:4px solid #0f7a45;
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

    /* ===============================
       Buttons
    =============================== */
    .screen-actions-row,
    .ration-print-actions{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      margin-top:10px;
    }

    .screen-actions-row a,
    .screen-actions-row button,
    .ration-print-actions button,
    .section-print-actions button{
      text-decoration:none;
      border:1px solid #dfe9e2;
      border-radius:12px;
      padding:9px 12px;
      font-weight:950;
      font-size:12px;
      cursor:pointer;
    }

    .screen-actions-row a,
    .screen-actions-row button,
    .ration-print-actions button.secondary{
      color:#134e2f;
      background:#eef7f0;
    }

    .ration-print-actions button,
    .section-print-actions button{
      background:#0f5d35;
      color:#fff;
    }

    .section-print-actions{
      margin:10px 0 12px;
    }

    /* ===============================
       Tables
    =============================== */
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

    /* ===============================
       Status chips
    =============================== */
    .status-chip{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border:1px solid #bbf7d0;
      border-radius:999px;
      background:#ecfdf3;
      color:#166534;
      padding:5px 10px;
      font-size:11px;
      font-weight:950;
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

    /* ===============================
       Mobile
    =============================== */
    @media(max-width:760px){
      .report-cover{
        padding:14px !important;
        border-radius:18px !important;
        margin:8px 0 12px !important;
        box-shadow:0 6px 16px rgba(15,93,53,.06) !important;
      }

      .report-cover:after{
        width:120px !important;
        height:120px !important;
        left:-45px !important;
        bottom:-55px !important;
      }

      .report-cover-head{
        display:block !important;
      }

      .report-logo-box{
        display:none !important;
      }

      .report-kicker{
        font-size:11px !important;
        margin-bottom:4px !important;
      }

      .report-main-title{
        max-width:100% !important;
        font-size:22px !important;
        line-height:1.35 !important;
        letter-spacing:0 !important;
        word-break:normal !important;
        overflow-wrap:normal !important;
      }

      .report-main-subtitle{
        font-size:11px !important;
        line-height:1.7 !important;
        margin-top:6px !important;
      }

      .executive-panel{
        grid-template-columns:1fr !important;
        gap:10px !important;
      }

      .executive-reading{
        padding:14px !important;
        border-radius:18px !important;
      }

      .executive-reading h2{
        font-size:18px !important;
      }

      .executive-reading p{
        font-size:12px !important;
      }

      .executive-score-grid,
      .compact-grid{
        grid-template-columns:repeat(2,minmax(0,1fr)) !important;
      }

      .executive-score{
        padding:10px !important;
        border-radius:16px !important;
      }

      .executive-score b{
        font-size:22px !important;
      }

      .metric-table{min-width:760px}
      .ration-head-grid{grid-template-columns:1fr}
    }

    /* ===============================
       Print modes
    =============================== */
    body.print-scope-one .stage-section{
      display:none !important;
    }

    body.print-scope-one .stage-section.print-stage-selected{
      display:block !important;
    }

    body.print-scope-one .ration-block{
      display:none !important;
    }

    body.print-scope-one .ration-block.print-selected{
      display:block !important;
    }

    body.print-scope-lactating .stage-section:not([data-stage="lactating"]){
      display:none !important;
    }

body.print-mode-operational .report-cover,
body.print-mode-operational .executive-panel,
body.print-mode-operational .report-tabs,
body.print-mode-operational .screen-actions-row,
body.print-mode-operational .stage-section > .report-section-head,
body.print-mode-operational .print-footer{
  display:none !important;
}

body.print-mode-operational .stage-section{
  display:none !important;
}

body.print-mode-operational .stage-section.print-stage-selected{
  display:block !important;
}

body.print-mode-operational .stage-section.print-stage-selected > *{
  display:none !important;
}

body.print-mode-operational .stage-section.print-stage-selected > .ration-block.print-selected{
  display:block !important;
  break-before:auto !important;
  page-break-before:auto !important;
}

body.print-mode-operational .ration-block.print-selected > *{
  display:none !important;
}

body.print-mode-operational .ration-block.print-selected .print-operation{
  display:block !important;
  position:static !important;
  width:100% !important;
  margin:0 !important;
  padding:0 !important;
  break-before:auto !important;
  page-break-before:auto !important;
}

body.print-mode-operational .ration-block.print-selected .print-operation *{
  visibility:visible !important;
}

body.print-mode-operational .ration-break{
  break-before:auto !important;
  page-break-before:auto !important;
}

    @media print{
    body.print-scope-one .report-cover,
body.print-scope-one .executive-panel,
body.print-scope-one .report-tabs,
body.print-scope-one .stage-section > .report-section-head,
body.print-scope-one .print-footer{
  display:none !important;
}

body.print-scope-one .stage-section{
  display:none !important;
}

body.print-scope-one .stage-section.print-stage-selected{
  display:block !important;
}

body.print-scope-one .ration-block{
  display:none !important;
}

body.print-scope-one .ration-block.print-selected{
  display:block !important;
  break-before:auto !important;
  page-break-before:auto !important;
}

body.print-scope-one .ration-block.print-selected .card:first-child{
  margin-top:0 !important;
}
      @page{
        size:A4 landscape;
        margin:8mm;
      }

      html, body{
        width:auto !important;
        overflow:visible !important;
      }

      .no-print,
      .report-tabs,
      .screen-actions-row,
      .ration-print-actions,
      .section-print-actions{
        display:none !important;
      }

      .report-cover,
      .executive-panel{
        break-inside:avoid;
        page-break-inside:avoid;
      }

      .report-cover{
        border-radius:0 !important;
        box-shadow:none !important;
      }

      .report-main-title{
        font-size:25pt !important;
      }

      .table-wrap{
        overflow:visible !important;
        width:100% !important;
      }

      .metric-table{
        width:100% !important;
        min-width:0 !important;
        table-layout:fixed !important;
      }

      .metric-table th,
      .metric-table td{
        white-space:normal !important;
        word-break:break-word !important;
        overflow-wrap:anywhere !important;
        font-size:8pt !important;
        padding:2mm !important;
        line-height:1.35 !important;
      }

      .decision-box{
        border-radius:0;
        box-shadow:none;
      }

      .decision-text{font-size:11pt}
      .decision-note{font-size:9pt}
      .status-chip{border-radius:0}
      .card{break-inside:auto;page-break-inside:auto}
    }
    /* ===== FINAL OVERRIDE: operational print ONLY ===== */
@media print{
  body.print-mode-operational .report-cover,
  body.print-mode-operational .executive-panel,
  body.print-mode-operational .report-tabs,
  body.print-mode-operational .screen-actions-row,
  body.print-mode-operational .ration-print-actions,
  body.print-mode-operational .section-print-actions,
  body.print-mode-operational .print-footer{
    display:none !important;
  }

  body.print-mode-operational #content > *{
    display:none !important;
  }

  body.print-mode-operational #content .stage-section.print-stage-selected{
    display:block !important;
  }

  body.print-mode-operational #content .stage-section.print-stage-selected > *{
    display:none !important;
  }

  body.print-mode-operational #content .stage-section.print-stage-selected .ration-block.print-selected{
    display:block !important;
    break-before:auto !important;
    page-break-before:auto !important;
  }

  body.print-mode-operational #content .stage-section.print-stage-selected .ration-block.print-selected > *{
    display:none !important;
  }

  body.print-mode-operational #content .stage-section.print-stage-selected .ration-block.print-selected .print-operation{
    display:block !important;
    position:static !important;
    width:100% !important;
    margin:0 !important;
    padding:0 !important;
    break-before:auto !important;
    page-break-before:auto !important;
  }

  body.print-mode-operational #content .stage-section.print-stage-selected .ration-block.print-selected .print-operation,
  body.print-mode-operational #content .stage-section.print-stage-selected .ration-block.print-selected .print-operation *{
    visibility:visible !important;
  }

  body.print-mode-operational .ration-break{
    break-before:auto !important;
    page-break-before:auto !important;
  }
}
  `;

  document.head.appendChild(style);
}



/* ============================================================
   HTML blocks
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
function renderDistributionSelector(){
  const opts = [1,2,3,4,5,6].map(n =>
    `<option value="${n}" ${Number(reportDistributionsPerDay) === n ? 'selected' : ''}>${n}</option>`
  ).join('');

  return `
    <div class="kpi no-print">
      <b>
        <select onchange="
          const p = new URLSearchParams(location.search);
          p.set('distributionsPerDay', this.value);
          location.search = p.toString();
        " style="font-weight:950;padding:6px 10px;border-radius:10px;border:1px solid #dfe9e2">
          ${opts}
        </select>
      </b>
      <span>عدد النقلات / اليوم</span>
    </div>
  `;
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
  p.set('distributionsPerDay', String(reportDistributionsPerDay));
  return `/api/nutrition/report/latest?${p.toString()}`;
}
function hideOldReportHeader(){
  const title = document.getElementById('reportTitle');
  const sub = document.getElementById('reportSub');
  const status = document.getElementById('statusBox');

  if(title) title.style.display = 'none';
  if(sub) sub.style.display = 'none';
  if(status) status.style.display = 'none';

  const box = title ? title.closest('.card, .hero, .report-head, section, header') : null;
  if(box) box.style.display = 'none';
}

function clearPrintMode(){
  document.body.classList.remove(
    'print-scope-one',
    'print-scope-lactating',
    'print-mode-operational'
  );

  document.querySelectorAll('.ration-block.print-selected').forEach(el => {
    el.classList.remove('print-selected');
  });

  document.querySelectorAll('.stage-section.print-stage-selected').forEach(el => {
    el.classList.remove('print-stage-selected');
  });
}

function markRationForPrint(el){
  document.body.classList.add('print-scope-one');
  el.classList.add('print-selected');

  const stageBox = el.closest('.stage-section');
  if(stageBox){
    stageBox.classList.add('print-stage-selected');
  }
}

function runPrint(scope = 'full'){
  clearPrintMode();

  if(scope === 'lactating'){
    document.body.classList.add('print-scope-lactating');
  }

  setTimeout(() => window.print(), 80);
}

function printRationById(id, operational = false){
  clearPrintMode();

  const el = id ? document.getElementById(id) : null;
  if(!el){
    alert('تعذر تحديد العليقة المطلوب طباعتها');
    return;
  }

  markRationForPrint(el);

  if(operational){
    document.body.classList.add('print-mode-operational');
  }

  setTimeout(() => window.print(), 80);
}

window.addEventListener('afterprint', clearPrintMode);
window.runPrint = runPrint;
window.printRationById = printRationById;

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

  const starchSafetyLimit =
    num(n.carbohydrateSafetyModel?.starchMaxPctDM) ??
    num(a.carbohydrateSafetyModel?.starchMaxPctDM) ??
    num(t.starchMax);

  if(finite(n.starchPctActual) && finite(starchSafetyLimit) && Number(n.starchPctActual) > Number(starchSafetyLimit)){
    return {
      title:'العليقة تحتاج مراجعة النشا وصحة الكرش.',
      action:'النشا تجاوز حد الأمان؛ راجع مصدر النشا وتوازن الخشن قبل رفع الطاقة.'
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
    title:'العليقة مقبولة حسب البيانات.',
    action:'استمر في متابعة اللبن والروث والمتبقي وتغيّر أسعار الخامات.'
  };
}

function renderDecisionBlock(e = {}, a = {}, stage = '', ctx = {}){
  const d = e?.nutrition?.reportDecision || {};
  const state = d.status || e?.nutrition?.reportStatus || 'muted';

  return `<div class="decision-box">
    <div class="decision-head">
      <div class="decision-title">قراءة مُرَبِّيك</div>
      ${badge(d.statusText || statusText(state), state)}
    </div>
    <div class="decision-text">${esc(d.title || 'قراءة مُرَبِّيك غير مكتملة.')}</div>
<div class="decision-note"><b>توجيه مُرَبِّيك:</b> ${esc(d.action || 'راجع بيانات العليقة قبل اعتماد التقرير.')}</div>
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

function nutrientCoverageStatus(cover, type = 'mineral'){
  const c = Number(cover);
  if(!Number.isFinite(c)) return 'muted';

  if(type === 'vitamin'){
    if(c < 95) return 'danger';
    if(c <= 105) return 'good';
    if(c <= 150) return 'warn';
    return 'danger';
  }

  // minerals: macro + trace
  if(c < 95) return 'danger';
  if(c <= 105) return 'good';
  if(c <= 130) return 'warn';
  return 'danger';
}

function nutrientCoverageAdvice(cover, type = 'mineral'){
  const c = Number(cover);
  if(!Number.isFinite(c)) return 'البيانات غير كافية للحكم؛ راجع اكتمال بيانات الخامات والإضافات.';

  if(type === 'vitamin'){
    if(c < 95) return 'الفيتامين أقل من المطلوب؛ راجع الإضافة المعدنية/الفيتامينية ومعدل استخدامها.';
    if(c <= 105) return 'الفيتامين يغطي المطلوب.';
    if(c <= 150) return 'الفيتامين أعلى من المطلوب غالبًا؛ راجع تكلفة الإضافة وتكرار مصادر الفيتامينات.';
    return 'الفيتامين أعلى بوضوح؛ راجع الإضافات المتكررة ولا تكرر مصادر الفيتامينات بدون داعٍ.';
  }

  if(c < 95) return 'العنصر أقل من المطلوب؛ راجع مصدر المعدن أو الإضافة المعدنية قبل اعتماد العليقة.';
  if(c <= 105) return 'العنصر يغطي المطلوب.';
  if(c <= 130) return 'العنصر أعلى من المطلوب؛ راجع الزيادة وتكلفة الإضافة، خصوصًا مع تكرار مصادر المعادن.';
  return 'العنصر أعلى بوضوح؛ يحتاج مراجعة فنية لتجنب زيادة غير ضرورية أو تداخلات معدنية.';
}

function mineralLabel(k){
  const labels = {
    Ca: 'كالسيوم Ca',
    P: 'فوسفور P',
    Mg: 'ماغنسيوم Mg',
    Na: 'صوديوم Na',
    K: 'بوتاسيوم K',
    Cl: 'كلوريد Cl',
    S: 'كبريت S',
    Co: 'كوبالت Co',
    Cu: 'نحاس Cu',
    Fe: 'حديد Fe',
    I: 'يود I',
    Mn: 'منجنيز Mn',
    Se: 'سيلينيوم Se',
    Zn: 'زنك Zn'
  };
  return labels[k] || k;
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
      const st = nutrientCoverageStatus(cover, 'mineral');

      return metricRow(
        mineralLabel(k),
        required == null ? '—' : `${nf(required, 2)} ${unit}`,
        supplied == null ? '—' : `${nf(supplied, 2)} ${unit}`,
        bal == null ? '—' : `${nf(bal, 2)} ${unit}`,
        st,
        Number.isFinite(cover)
          ? `تغطية ${nf(cover,1)}%. ${nutrientCoverageAdvice(cover, 'mineral')}`
          : nutrientCoverageAdvice(cover, 'mineral')
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
      const st = nutrientCoverageStatus(cover, 'vitamin');

      return metricRow(
        label,
        Number.isFinite(required) ? `${nf(required, 0)} وحدة دولية` : '—',
        Number.isFinite(supplied) ? `${nf(supplied, 0)} وحدة دولية` : '—',
        Number.isFinite(bal) ? `${nf(bal, 0)} وحدة دولية` : '—',
        st,
        Number.isFinite(cover)
          ? `تغطية ${nf(cover,1)}%. ${nutrientCoverageAdvice(cover, 'vitamin')}`
          : nutrientCoverageAdvice(cover, 'vitamin')
      );
    });
}
function renderServerReportRows(reportRows = [], event = {}){
  const rows = Array.isArray(reportRows) ? reportRows : [];

  if(!rows.length){
    return section(
      'تحليل العليقة الكامل',
      '<div class="small-note">لا توجد صفوف تقرير جاهزة لهذا التحليل.</div>'
    );
  }

  const groups = new Map();

for(const r of rows){
    const sec = r.section || 'تحليل العليقة';
    if(!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(r);
  }

  let html = '';

  for(const [sec, items] of groups.entries()){
    const isEconomy = String(sec || '').trim() === 'الاقتصاد';

    if(isEconomy){
      const body = items.map(r => `<tr>
        <td class="metric-name">${esc(r.label || r.name || '—')}</td>
        <td>${esc(r.actualText || '—')}</td>
        <td>${esc(r.balanceText || '—')}</td>
        <td>${badge(r.statusText || statusText(r.status), r.status || 'muted')}</td>
        <td>${esc(r.note || '—')}</td>
      </tr>`);

html += section(sec, table(
  ['المؤشر','القيمة المالية','النسبة الاقتصادية','قراءة مُرَبِّيك','توجيه مُرَبِّيك'],
  body,
  'لا توجد بيانات اقتصادية.'
));

      continue;
    }

    const body = items.map(r => `<tr>
      <td class="metric-name">${esc(r.label || r.name || '—')}</td>
      <td>${esc(r.targetText || '—')}</td>
      <td>${esc(r.actualText || '—')}</td>
      <td>${esc(r.balanceText || '—')}</td>
      <td>${badge(r.statusText || statusText(r.status), r.status || 'muted')}</td>
      <td>${esc(r.note || '—')}</td>
    </tr>`);

html += section(sec, table(
  ['البند','الاحتياج / الهدف','الفعلي','الفرق','الحالة','توجيه مُرَبِّيك'],
  body,
  'لا توجد بيانات.'
));
  }

  return html;
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

  const carbSafety =
    n.carbohydrateSafetyModel ||
    a.carbohydrateSafetyModel ||
    {};

  const ndfSafetyMin =
    num(carbSafety.minTotalNDFPctDM) ??
    num(t.ndfSafetyMin) ??
    num(t.ndfMin) ??
    num(t.ndfTarget);

  const starchSafetyLimit =
    num(carbSafety.starchMaxPctDM) ??
    num(t.starchMax);

  const fatSafetyLimit =
    num(t.fatSafeMax) ??
    num(t.fatMax) ??
    7;

  const rows = [
metricRow('قدرة الأكل / المادة الجافة المأكولة (DMI)', 'قراءة تشغيلية', kg(totals.dmKg,2), '—', 'muted', 'العلف يجب أن يكون أمام الأبقار 24 ساعة يوميًا لضمان الشبع وعدم إهدار العلف. الأهم هو اتزان الاحتياجات الفعلية؛ وأي زيادة يأكلها الحيوان حسب الشهية يجب أن يقابلها لبن زيادة.'),

metricRow('الطاقة الصافية للحليب (NEL)', `${nf(t.nelTarget,2)} ميجا كالوري/يوم`, `${nf(n.nelActual,2)} ميجا كالوري/يوم`, finite(nelBal) ? `${nf(nelBal,2)} ميجا كالوري` : '—', balanceState(nelBal, 0.5), mbkAdvice('energy', balanceState(nelBal, 0.5), 'balance')),

metricRow('البروتين الممثل القابل للاستفادة (MP)', g(t.mpTargetG,0), g(n.mpSupplyG,0), g(mpBal,0), balanceState(mpBal, 50), mbkAdvice('mp', balanceState(mpBal, 50), 'balance')),



metricRow(
  'الألياف المتعادلة (NDF)',
  finite(ndfSafetyMin) ? `حد أمان أدنى ${pct(ndfSafetyMin,1)}` : 'حد أمان أدنى للكرش',
  pct(n.ndfPctActual,1),
  finite(n.ndfPctActual) && finite(ndfSafetyMin)
    ? pct(Number(n.ndfPctActual) - Number(ndfSafetyMin),1)
    : '—',
  minLimitState(n.ndfPctActual, ndfSafetyMin),
  minLimitState(n.ndfPctActual, ndfSafetyMin) === 'warn'
    ? mbkAdvice('ndf', 'warn', 'min')
    : 'NDF يغطي حد أمان الكرش الأدنى. الارتفاع الكبير قد يضغط المأكول والطاقة حسب جودة الخشن وهضميته، ويُقرأ مع صحة الكرش والمأكول.'
),

metricRow(
  'النشا',
  finite(starchSafetyLimit) ? `حد الأمان ${pct(starchSafetyLimit,1)}` : 'حد الأمان',
  pct(n.starchPctActual,1),
  finite(n.starchPctActual) && finite(starchSafetyLimit)
    ? pct(Number(n.starchPctActual) - Number(starchSafetyLimit),1)
    : '—',
  highLimitState(n.starchPctActual, starchSafetyLimit),
  mbkAdvice('starch', highLimitState(n.starchPctActual, starchSafetyLimit), 'max')
),

metricRow(
  'دهن العليقة',
  finite(fatSafetyLimit) ? `حد الأمان ${pct(fatSafetyLimit,1)}` : 'حد الأمان',
  pct(n.fatPctActual,1),
  finite(n.fatPctActual) && finite(fatSafetyLimit)
    ? pct(Number(n.fatPctActual) - Number(fatSafetyLimit),1)
    : '—',
  highLimitState(n.fatPctActual, fatSafetyLimit),
  mbkAdvice('fat', highLimitState(n.fatPctActual, fatSafetyLimit), 'max')
),

metricRow('صحة الكرش', 'آمن', rh.title || n.rumenStatus || '—', '—', rumenState, rh.reason || n.rumenNote || '—'),

metricRow('نسبة الخشن من المادة الجافة', `حد أدنى ${pct(t.roughageMin,1)}`, pct(n.roughPctDM,1), finite(n.roughPctDM) && finite(t.roughageMin) ? pct(Number(n.roughPctDM) - Number(t.roughageMin),1) : '—', minLimitState(n.roughPctDM, t.roughageMin), mbkAdvice('roughage', minLimitState(n.roughPctDM, t.roughageMin), 'min')),

metricRow('الألياف المتعادلة من الخشن (Forage NDF)', `حد أدنى ${pct(t.forageNDFMin,1)}`, pct(n.forageNDFPctDM,1), finite(n.forageNDFPctDM) && finite(t.forageNDFMin) ? pct(Number(n.forageNDFPctDM) - Number(t.forageNDFMin),1) : '—', minLimitState(n.forageNDFPctDM, t.forageNDFMin), mbkAdvice('forageNdf', minLimitState(n.forageNDFPctDM, t.forageNDFMin), 'min'))
  ];

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
function economicStatusText(state){
  const s = String(state || '').toLowerCase();

  if(s.includes('danger')) return 'ضعيف';
  if(s.includes('warn') || s.includes('watch')) return 'جيد';
  if(s.includes('good') || s.includes('ok')) return 'ممتاز';
  return 'معلومة';
}

function economicRow(name, value, state, note = ''){
  return `<tr>
    <td class="metric-name">${esc(name)}</td>
    <td>${esc(value)}</td>
    <td>${badge(economicStatusText(state), state)}</td>
    <td>${esc(note || '—')}</td>
  </tr>`;
}

function renderEconomicAnalysis(a = {}, stage = '', ctx = {}, panels = {}){
  const totals = a.totals || {};
  const e = a.economics || {};
  const serverCards = Array.isArray(panels.economicsCards)
  ? panels.economicsCards.filter(c => c && c.uiHint)
  : [];

  if(serverCards.length){
    const rows = serverCards.map(c => economicRow(
      c.title || 'مؤشر اقتصادي',
      c.value || '—',
      c.status || 'muted',
      c.uiHint || c.targetText || '—'
    ));

    return section('التحليل الاقتصادي', table(
      ['البند','القيمة','قراءة مُرَبِّيك','توصية مُرَبِّيك'],
      rows,
      'لا توجد بيانات اقتصادية محفوظة.'
    ));
  }

  const rows = [];

  if(finite(totals.totCost)){
    rows.push(economicRow(
      'تكلفة العليقة / رأس / يوم',
      money(totals.totCost),
      'muted',
      'راجع أغلى الخامات إذا كانت التكلفة تضغط الهامش.'
    ));
  }

  if(finite(totals.mixPriceAsFed)){
    rows.push(economicRow(
      'سعر طن العليقة الطازجة',
      `${nf(totals.mixPriceAsFed, 2)} جنيه / طن`,
      'muted',
      'مؤشر لسعر الخلطة كما تُقدّم للحيوان.'
    ));
  }

  if(finite(totals.mixPriceDM)){
    rows.push(economicRow(
      'سعر طن المادة الجافة',
      `${nf(totals.mixPriceDM, 2)} جنيه / طن مادة جافة`,
      'muted',
      'استخدمه للمقارنة العادلة بين العلائق.'
    ));
  }

  if(isLactating(stage, ctx)){
    if(finite(e.feedCostPctOfMilkIncome)){
      rows.push(economicRow(
        'تكلفة العلف من دخل اللبن',
        `${nf(e.feedCostPctOfMilkIncome, 1)}%`,
        Number(e.feedCostPctOfMilkIncome) <= 40 ? 'good' : (Number(e.feedCostPctOfMilkIncome) <= 60 ? 'warn' : 'danger'),
        Number(e.feedCostPctOfMilkIncome) <= 40
          ? 'تكلفة قوية؛ لا تخفض جودة العليقة لمجرد تقليل الرقم.'
          : 'راجع أغلى الخامات مع الحفاظ على الطاقة والبروتين وصحة الكرش.'
      ));
    }

    if(finite(e.iofcPctOfMilkIncome)){
      rows.push(economicRow(
        'هامش اللبن بعد العلف',
        `${nf(e.iofcPctOfMilkIncome, 1)}%`,
        Number(e.iofcPctOfMilkIncome) >= 60 ? 'good' : (Number(e.iofcPctOfMilkIncome) >= 40 ? 'warn' : 'danger'),
        Number(e.iofcPctOfMilkIncome) >= 60
          ? 'هامش قوي؛ يمكن تصحيح التحذير الغذائي دون خوف من التكلفة.'
          : 'الهامش يحتاج مراجعة التكلفة والإنتاج قبل اعتماد العليقة.'
      ));
    }

    if(finite(e.feedEfficiencyECM)){
      rows.push(economicRow(
        'كفاءة اللبن المصحح',
        `${nf(e.feedEfficiencyECM, 2)} كجم لبن مصحح / كجم مادة جافة`,
        Number(e.feedEfficiencyECM) >= 1.6 ? 'good' : (Number(e.feedEfficiencyECM) >= 1.3 ? 'warn' : 'danger'),
        Number(e.feedEfficiencyECM) >= 1.6
          ? 'كفاءة ممتازة؛ لا تطارد رفعها قبل ضبط الكرش والبروتين.'
          : 'راجع جودة الخشن والطاقة والمأكول لتحسين الكفاءة.'
      ));
    }

    if(finite(e.costPerKgMilk)){
      rows.push(economicRow(
        'تكلفة كجم اللبن',
        `${nf(e.costPerKgMilk, 2)} جنيه / كجم`,
        'muted',
        'لا تُقرأ وحدها؛ القرار من الهامش وصحة العليقة.'
      ));
    }

    if(finite(e.milkRevenue)){
      rows.push(economicRow(
        'إيراد اللبن / رأس / يوم',
        money(e.milkRevenue),
        'muted',
        'دخل اللبن قبل خصم تكلفة العلف.'
      ));
    }

    if(finite(e.milkMargin)){
      rows.push(economicRow(
        'هامش لبن - علف / رأس / يوم',
        money(e.milkMargin),
        Number(e.milkMargin) < 0 ? 'danger' : 'good',
        Number(e.milkMargin) < 0
          ? 'الهامش سلبي؛ راجع سعر اللبن وتكلفة الخامات وتركيب العليقة.'
          : 'هامش جيد؛ القرار التالي من الاتزان الغذائي وصحة الكرش.'
      ));
    }

    if(finite(e.dmPerKgMilk)){
      rows.push(economicRow(
        'مادة جافة لكل كجم لبن',
        `${nf(e.dmPerKgMilk, 2)} كجم مادة جافة / كجم لبن`,
        'muted',
        'مؤشر مساعد؛ اقرأه مع كفاءة اللبن المصحح والهامش.'
      ));
    }
  }

  if(!rows.length) return '';

  return section('التحليل الاقتصادي', table(
    ['البند','القيمة','قراءة مُرَبِّيك','توصية مُرَبِّيك'],
    rows,
    'لا توجد بيانات اقتصادية محفوظة.'
  ));
}
function renderOperationalBatch(batch = {}){
  const b = batch || {};
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const totals = b.totals || {};
  const distributions = Number(b.distributionsPerDay || reportDistributionsPerDay || 2) || 2;

  if(!rows.length){
    return section('تقرير التشغيل والخلط الجماعي', `
      <div class="small-note">لا توجد بيانات كافية لبناء جدول الخلط الجماعي لهذه العليقة.</div>
    `);
  }

  const body = rows.map(r => `<tr>
    <td class="metric-name">${esc(r.name || 'خامة')}</td>
    <td>${kg(r.asFedKgPerHead,2)}</td>
    <td>${kg(r.asFedKgGroupDay,2)}</td>
    <td>${nf(distributions,0)}</td>
    <td>${kg(r.asFedKgPerDistribution,2)}</td>
    <td>${money(r.costGroupDay)}</td>
  </tr>`);

  body.push(`<tr>
    <td class="metric-name">الإجمالي</td>
    <td>${kg(totals.asFedKgPerHead,2)}</td>
    <td>${kg(totals.asFedKgGroupDay,2)}</td>
    <td>${nf(distributions,0)}</td>
    <td>${kg(totals.asFedKgPerDistribution,2)}</td>
    <td>${money(totals.costGroupDay)}</td>
  </tr>`);

  return section('تقرير التشغيل والخلط الجماعي', `
    <div class="compact-grid" style="margin-bottom:10px">
      ${kpi('عدد الرؤوس', finite(b.headCount) ? nf(b.headCount,0) : '—')}
      ${renderDistributionSelector()}
      ${kpi('إجمالي الخلطة / يوم', kg(totals.asFedKgGroupDay,2))}
      ${kpi('إجمالي كل نقلة', kg(totals.asFedKgPerDistribution,2))}
    </div>

    <div class="small-note" style="margin-bottom:8px">
      اختر عدد النقلات قبل الطباعة. الحساب يتم من السيرفر، والواجهة تعرض الناتج فقط.
    </div>

    ${table(
      ['الخامة','كجم/رأس/يوم','إجمالي المجموعة/يوم','عدد النقلات','كجم/كل نقلة','تكلفة المجموعة/يوم'],
      body,
      'لا توجد بيانات تشغيل.'
    )}
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

  return `<div id="${esc(id)}" class="ration-block ${breakClass}" data-stage="${esc(stage)}">

    <div class="print-analysis">
      ${section(`تقرير عليقة: ${groupName}`, `
        <div class="ration-head-grid">
          <div>${renderDecisionBlock(event, a, stage, ctx)}</div>
          <div>
            ${badge(stageLabel(stage, ctx), nDoc.reportStatus || nDoc.reportDecision?.status || 'muted')}
            ${badge(speciesLabelFromEvent(event), 'muted')}
          </div>
<div class="screen-actions-row">
  <a href="#top">أعلى التقرير</a>
  <a href="nutrition-report.html?scope=group&type=${encodeURIComponent(qp.get('type') || '')}&groupName=${encodeURIComponent(groupName)}">فتح منفرد</a>
</div>
<div class="ration-print-actions no-print">
  <button type="button" onclick="printRationById('${esc(id)}', false)">طباعة هذه العليقة</button>
  <button type="button" class="secondary" onclick="printRationById('${esc(id)}', true)">نسخة تشغيل العليقة</button>
</div>
      `)}

      ${renderServerReportRows(nDoc.reportRows || [], event)}
    </div>

<div class="print-operation">
  ${renderOperationalBatch(nDoc.operationalBatch || {})}
</div>

  </div>`;
}

function renderGroup(data){
  const e = data.event || {};
  const groupName = data.groupName || groupNameFromEvent(e);
  const stage = data.stage || eventStage(e);
  const rationId = `ration-${slug(groupName)}`;

  $('reportTitle').textContent = `تقرير تغذية: ${groupName}`;
  $('reportSub').textContent = `${stageLabel(stage, e?.nutrition?.context || {})} — تاريخ التحليل: ${safe(e.eventDate || e.date)} — تقرير عليقة منفردة`;
  $('statusBox').style.display = 'none';

  $('content').innerHTML = `
    <div id="top"></div>
    <nav class="report-tabs no-print">
      <a class="main" href="#${esc(rationId)}">العليقة</a>
      <a href="nutrition-report.html?scope=all&type=${encodeURIComponent(qp.get('type') || '')}">كل العلائق</a>
    </nav>
    ${renderOneRation(e, { groupName, stage, id: rationId, pageBreak:false })}
  `;
}

/* ============================================================
   التقرير الشامل/* ============================================================
   التقرير الشامل scope=all
============================================================ */
function renderExecutiveAll(report = {}, type = ''){
  const ex = report.executive || {};
  const typeLabel = String(type).toLowerCase().includes('buffalo')
    ? 'جاموس'
    : (String(type).toLowerCase().includes('cows') ? 'أبقار' : 'كل الأنواع');

  const first = ex.firstPriority || {};
  const highCost = ex.highestCost || {};
  const weak = ex.weakestMargin || {};
  const total = Number(ex.totalRations || report.count || 0) || 0;
  const danger = Number(ex.dangerCount || 0) || 0;
  const warn = Number(ex.warningCount || 0) || 0;
  const ok = Number(ex.okCount || 0) || 0;

  return `
    <section class="report-cover">
      <div class="report-cover-head">
        <div>
          <div class="report-kicker">مُرَبِّيك لإدارة مزارع الألبان</div>
          <h1 class="report-main-title">تقرير مُرَبِّيك الشامل للتغذية — ${esc(typeLabel)}</h1>
          <div class="report-main-subtitle">
            تقرير تحليلي منظم لعلائق القطيع حسب مرحلة التغذية: ملخص تنفيذي، فهرس العلائق، مقارنة مختصرة، ثم تفاصيل كل عليقة.
          </div>
        </div>

        <div class="report-logo-box">
          <img src="/images/logo.png" alt="Murabbik">
          <div>تقرير تغذية</div>
        </div>
      </div>
    </section>

    <section class="executive-panel">
      <div class="executive-reading">
        <h2>الملخص التنفيذي</h2>
        <p>
          يبدأ التقرير بقراءة عامة لحالة العلائق، ثم يوجّهك إلى العليقة الأولى التي تحتاج مراجعة.
          التفاصيل العلمية والتشغيلية موجودة داخل كل عليقة على حدة.
        </p>

 <div class="executive-soft-notes">
  ${
    first.groupName
      ? `<span>مراجعة مقترحة أولًا: ${esc(first.groupName)}</span>`
      : `<span>لا توجد أولوية حرجة في الملخص.</span>`
  }
  ${
    highCost.groupName
      ? `<span>راجع تكلفة: ${esc(highCost.groupName)}</span>`
      : ''
  }
  ${
    weak.groupName
      ? `<span>راجع الهامش: ${esc(weak.groupName)}</span>`
      : ''
  }
</div>
      </div>

      <div class="executive-score-grid">
        <div class="executive-score">
          <b>${nf(total,0)}</b>
          <span>عدد العلائق</span>
        </div>
        <div class="executive-score">
          <b>${nf(ok,0)}</b>
          <span>علائق متزنة</span>
        </div>
        <div class="executive-score">
          <b>${nf(warn,0)}</b>
          <span>تحتاج متابعة</span>
        </div>
        <div class="executive-score">
          <b>${nf(danger,0)}</b>
          <span>بها تنبيه</span>
        </div>
      </div>
    </section>
  `;
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
      <td>${x.reportStatus ? badge(x.reportStatusText || statusText(x.reportStatus), x.reportStatus) : badge('متابعة','muted')}</td>
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
    <td>${kg(x.dmActual,2)}</td>
    <td>${nf(x.nelActual,2)} / ${nf(x.nelTarget,2)}</td>
    <td>${g(x.mpSupplyG,0)} / ${g(x.mpTargetG,0)}</td>
    <td>${g(x.mpBalanceG,0)}</td>
    <td>${pct(x.ndfPctActual,1)}</td>
    <td>${pct(x.starchPctActual,1)}</td>
    <td>${money(x.costPerKgMilk)}</td>
    <td>${x.reportStatus ? badge(x.reportStatusText || statusText(x.reportStatus), x.reportStatus) : badge('متابعة','muted')}</td>
  </tr>`);

  return section('مقارنة مختصرة بين العلائق', table(
   ['العليقة','المرحلة','قدرة أكل / DMI','الطاقة الصافية للحليب (NEL)','البروتين الممثل (MP)','ميزان البروتين الممثل','الألياف المتعادلة (NDF)','نشا','تكلفة كجم اللبن','قراءة مُرَبِّيك'],
    rows,
    'لا توجد بيانات مقارنة.'
  ));
}

function renderTabs(report = {}){
  return `<nav class="report-tabs no-print">
    <a class="main" href="#top">بداية التقرير</a>
    <a href="#ration-index">فهرس العلائق</a>
    <a href="#comparison">مقارنة مختصرة</a>
  </nav>`;
}

function renderAll(data){
  const report = data.report || {};
  const type = data.type || qp.get('type') || '';
  const typeLabel = String(type).toLowerCase().includes('buffalo')
    ? 'جاموس'
    : (String(type).toLowerCase().includes('cows') ? 'أبقار' : 'كل الأنواع');

  $('reportTitle').textContent = 'تقرير مُرَبِّيك الشامل للتغذية';
  $('reportSub').textContent = `${typeLabel} — تقرير مقسم حسب مرحلة التغذية`;
  $('statusBox').style.display = 'none';

  if(Array.isArray(report.sections) && report.sections.length){
    const html = report.sections.map((sec, si) => {
      const secReport = sec.report || {};
      const events = Array.isArray(secReport.events) ? secReport.events : [];

      const displayReport = {
        ...secReport,
        index: Array.isArray(secReport.index) ? secReport.index : [],
        executive: secReport.executive || {},
        count: secReport.count || events.length
      };

      const rationReports = events.map((ev, i) => {
        const groupName = groupNameFromEvent(ev);
        const stage = eventStage(ev) || sec.stage || '';
        const rationId = `ration-${slug((sec.stage || 'stage') + '-' + (groupName || `r${i}`))}`;

return renderOneRation(ev, {
  groupName,
  stage,
  id: rationId,
  pageBreak: i > 0
});
      }).join('');

      const stageName = String(sec.stage || '').toLowerCase();
      const isLactatingSection = stageName === 'lactating';

      return `
        <div class="stage-section" data-stage="${esc(sec.stage || '')}">
          ${sec.showMilkEconomics ? renderExecutiveAll(displayReport, type) : ''}
          ${sec.showMilkEconomics ? `<div id="ration-index-${esc(sec.stage || si)}">${renderRationIndex(displayReport, type)}</div>` : ''}
          ${sec.showMilkEconomics ? `<div id="comparison-${esc(sec.stage || si)}">${renderAllComparison(displayReport)}</div>` : ''}

          <section class="report-section-head">
            <div class="section-title">${esc(sec.title || 'قسم تغذية')}</div>
            <div class="small-note">عدد العلائق في هذا القسم: ${nf(sec.count || events.length,0)}</div>
            ${isLactatingSection ? `
              <div class="section-print-actions no-print">
                <button type="button" onclick="runPrint('lactating')">طباعة علائق الحلاب فقط</button>
              </div>
            ` : ''}
          </section>

          ${rationReports}
        </div>
      `;
    }).join('');

    $('content').innerHTML = `
      <div id="top"></div>
      ${html}
    `;
    return;
  }

  const events = Array.isArray(report.events) ? report.events : [];

  const displayReport = {
    ...report,
    index: Array.isArray(report.index) ? report.index : [],
    executive: report.executive || {},
    count: report.count || (Array.isArray(report.index) ? report.index.length : events.length)
  };

  const rationReports = events.map((ev, i) => {
    const groupName = groupNameFromEvent(ev);
    const stage = eventStage(ev);
    const rationId = `ration-${slug(groupName || `r${i}`)}`;

    return renderOneRation(ev, {
      groupName,
      stage,
      id: rationId,
      pageBreak: true
    });
  }).join('');

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
   تشغيل/* ============================================================
   تشغيل
============================================================ */
async function main(){
 injectReportStyles();
hideOldReportHeader();

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
