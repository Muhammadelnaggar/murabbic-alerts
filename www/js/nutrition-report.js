// مُرَبِّيك — تقرير التغذية الكامل
// عرض فقط: يقرأ آخر تحليل محفوظ من السيرفر ولا يعيد حساب الاحتياجات أو الإمداد.
const API_BASE = window.API_BASE || 'https://murabbic-alerts.onrender.com';

const $ = (id) => document.getElementById(id);
const qp = new URLSearchParams(location.search);

function getTenantId(){
  try{
    const T = window.__TENANT__ || {};
    return (// مُرَبِّيك — تقرير التغذية الاحترافي
// عرض فقط: يقرأ التحليلات المحفوظة من السيرفر ولا يعيد حساب الاحتياجات أو الإمداد.

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

function kg(v, d = 2){
  return `${nf(v, d)} كجم`;
}

function pct(v, d = 1){
  return `${nf(v, d)}%`;
}

function g(v, d = 0){
  return `${nf(v, d)} جم`;
}

function safe(v){
  return (v === null || v === undefined || v === '') ? '—' : String(v);
}

function finite(v){
  return Number.isFinite(Number(v));
}

function compact(arr){
  return (Array.isArray(arr) ? arr : []).filter(Boolean);
}

/* ============================================================
   ستايل إضافي للتقرير الاحترافي والطباعة
============================================================ */
function injectReportStyles(){
  if(document.getElementById('mbkNutritionReportStyle')) return;

  const style = document.createElement('style');
  style.id = 'mbkNutritionReportStyle';
  style.textContent = `
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
    }
    .ration-break{
      break-before:page;
      page-break-before:always;
    }
    .index-grid{
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:9px;
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
    .screen-actions-row a{
      text-decoration:none;
      border-radius:12px;
      padding:9px 12px;
      font-weight:950;
      font-size:12px;
      border:1px solid #dfe9e2;
      color:#134e2f;
      background:#eef7f0;
    }

    @media(max-width:760px){
      .executive-hero{grid-template-columns:1fr}
      .hero-side{grid-template-columns:repeat(2,minmax(0,1fr))}
      .index-grid{grid-template-columns:1fr}
      .metric-table{min-width:720px}
    }

    @media print{
      .executive-hero{grid-template-columns:1.1fr .9fr}
      .hero-main,
      .decision-box{
        border-radius:0;
        box-shadow:none;
      }
      .hero-title{font-size:20pt}
      .status-chip{border-radius:0}
      .screen-actions-row{display:none !important}
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
    }
  `;
  document.head.appendChild(style);
}

/* ============================================================
   حالات وحكم
============================================================ */
function stateClass(state){
  const s = String(state || '').toLowerCase();
  if(s.includes('danger') || s.includes('bad') || s.includes('deficit') || s.includes('excess') || s.includes('خطر')) return 'danger';
  if(s.includes('warn') || s.includes('watch') || s.includes('low') || s.includes('border') || s.includes('مراجعة') || s.includes('متابعة')) return 'warn';
  if(s.includes('good') || s.includes('ok') || s.includes('مقبول') || s.includes('مناسب')) return '';
  return 'muted';
}

function statusText(state){
  const s = String(state || '').toLowerCase();
  if(s.includes('danger')) return 'خطر';
  if(s.includes('warn') || s.includes('watch')) return 'مراجعة';
  if(s.includes('good') || s.includes('ok')) return 'مقبول';
  if(s.includes('deficit')) return 'نقص';
  if(s.includes('excess')) return 'زيادة';
  return 'غير محسوم';
}

function badge(text, state = ''){
  if(!text) return '';
  const cls = stateClass(state || text);
  return `<span class="status-chip ${cls}">${esc(text)}</span>`;
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
  if(!Number.isFinite(n)) return 'unknown';
  if(n < -Math.abs(tolerance)) return 'danger';
  if(n > Math.abs(tolerance)) return 'warn';
  return 'good';
}

function highLimitState(actual, max){
  if(!finite(actual) || !finite(max)) return 'unknown';
  return Number(actual) > Number(max) ? 'warn' : 'good';
}

function minLimitState(actual, min){
  if(!finite(actual) || !finite(min)) return 'unknown';
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
  return 'unknown';
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

  if(!scope && view) scope = 'lactating_summary';
  if(!scope) scope = 'group';

  const p = new URLSearchParams();
  p.set('scope', scope);
  if(type) p.set('type', type);
  if(qp.get('stage')) p.set('stage', qp.get('stage'));
  if(qp.get('groupName')) p.set('groupName', qp.get('groupName'));
  if(qp.get('group')) p.set('group', qp.get('group'));

  return `/api/nutrition/report/latest?${p.toString()}`;
}

/* ============================================================
   ملخص الحلاب القديم — محسّن
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
   تقرير منفرد / جزء داخل التقرير الشامل
============================================================ */
function renderDecisionBlock(e = {}, a = {}, stage = '', ctx = {}){
  const decision = decisionFromEvent(e);
  const priority = priorityFromEvent(e);
  const state = eventStatus(e);

  const fallbackDecision = buildAutoDecision(a, stage, ctx);
  const decisionText = decision?.value || fallbackDecision.title;
  const priorityText = priority?.value || priority?.targetText || fallbackDecision.action;

  return `<div class="decision-box">
    <div class="decision-head">
      <div class="decision-title">الحكم التنفيذي</div>
      ${badge(statusText(state), state)}
    </div>
    <div class="decision-text">${esc(decisionText)}</div>
    ${priorityText ? `<div class="decision-note"><b>الإجراء الأول:</b> ${esc(priorityText)}</div>` : ''}
  </div>`;
}

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
      action:'راجع المادة الجافة أولًا ثم كثافة الطاقة بدون كسر أمان الكرش.'
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

function renderContextBlock(ctx = {}, event = {}, stage = ''){
  const profile = ctx.groupNutritionProfile || {};
  const hom = ctx.homogeneity || {};
  const ft = ctx.formulationTarget || {};

  return section('بطاقة تعريف العليقة', `<div class="grid">
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

function renderCoreNutrients(a = {}, stage = '', ctx = {}){
  const n = a.nutrition || {};
  const t = a.targets || {};
  const totals = a.totals || {};
  const e = a.economics || {};

  const dmBal = finite(totals.dmKg) && finite(t.dmiTarget) ? Number(totals.dmKg) - Number(t.dmiTarget) : null;
  const nelBal = finite(n.nelActual) && finite(t.nelTarget) ? Number(n.nelActual) - Number(t.nelTarget) : null;
  const mpBal = finite(n.mpBalanceG) ? Number(n.mpBalanceG) : (finite(n.mpSupplyG) && finite(t.mpTargetG) ? Number(n.mpSupplyG) - Number(t.mpTargetG) : null);

  const rows = [
    metricRow('المادة الجافة DMI', kg(t.dmiTarget,2), kg(totals.dmKg,2), finite(dmBal) ? kg(dmBal,2) : '—', balanceState(dmBal, 0.5), 'مقارنة فعلية يومية بنفس المقياس.'),
    metricRow('الطاقة NEL', `${nf(t.nelTarget,2)} Mcal/يوم`, `${nf(n.nelActual,2)} Mcal/يوم`, finite(nelBal) ? `${nf(nelBal,2)} Mcal` : '—', balanceState(nelBal, 0.5), 'الاحتياج والإمداد يومي وليس كثافة.'),
    metricRow('البروتين الممثل MP', g(t.mpTargetG,0), g(n.mpSupplyG,0), g(mpBal,0), balanceState(mpBal, 50), 'الأولوية قبل تعديل CP.'),
    metricRow('البروتين الخام CP', pct(t.cpTarget,1), pct(n.cpPctTotal,1), finite(n.cpPctTotal) && finite(t.cpTarget) ? pct(Number(n.cpPctTotal) - Number(t.cpTarget),1) : '—', balanceState(finite(n.cpPctTotal) && finite(t.cpTarget) ? Number(n.cpPctTotal) - Number(t.cpTarget) : null, 0.7), 'مؤشر عام وليس بديلًا عن MP.'),
    metricRow('NDF الكلي', pct(t.ndfTarget,1), pct(n.ndfPctActual,1), finite(n.ndfPctActual) && finite(t.ndfTarget) ? pct(Number(n.ndfPctActual) - Number(t.ndfTarget),1) : '—', balanceState(finite(n.ndfPctActual) && finite(t.ndfTarget) ? Number(n.ndfPctActual) - Number(t.ndfTarget) : null, 1.5), 'يُراجع مع صحة الكرش وليس منفردًا.'),
    metricRow('peNDF', `حد أدنى ${pct(t.peNDFMin,1)}`, pct(n.peNDFPctActual,1), finite(n.peNDFPctActual) && finite(t.peNDFMin) ? pct(Number(n.peNDFPctActual) - Number(t.peNDFMin),1) : '—', minLimitState(n.peNDFPctActual, t.peNDFMin), 'ألياف فعالة للمضغ والاجترار.'),
    metricRow('النشا', `حد أقصى ${pct(t.starchMax,1)}`, pct(n.starchPctActual,1), finite(n.starchPctActual) && finite(t.starchMax) ? pct(Number(n.starchPctActual) - Number(t.starchMax),1) : '—', highLimitState(n.starchPctActual, t.starchMax), 'حد أمان وليس هدفًا للرفع.'),
    metricRow('دهن العليقة', 'حد تشغيلي', pct(n.fatPctActual,1), '—', finite(n.fatPctActual) && Number(n.fatPctActual) > 7 ? 'warn' : 'good', 'الزيادة قد تضغط هضم الألياف.')
  ];

  if(isLactating(stage, ctx)){
    rows.push(metricRow('تكلفة كجم اللبن', 'أقل أفضل', money(e.costPerKgMilk), '—', 'unknown', 'مؤشر اقتصادي للحلاب فقط.'));
    rows.push(metricRow('هامش لبن-علف/رأس', 'موجب', money(e.milkMargin), '—', finite(e.milkMargin) && Number(e.milkMargin) < 0 ? 'danger' : 'good', 'أهم مؤشر ربحية يومي.'));
  }

  if(isCloseUp(stage, ctx)){
    const dcadVal = n.dcadModel?.dcadMeqKgDM;
    rows.push(metricRow('DCAD', 'نطاق انتظار الولادة', finite(dcadVal) ? `${nf(dcadVal,0)} mEq/kg DM` : '—', '—', finite(dcadVal) && Number(dcadVal) > -50 ? 'warn' : 'good', 'يُراجع مع Ca/Mg وأملاح الأنيون.'));
  }

  return section('لوحة الاحتياج والإمداد', table(
    ['البند','الاحتياج / الحد','الإمداد / الفعلي','الميزان','الحكم','ملاحظة'],
    rows,
    'لا توجد بيانات احتياج وإمداد محفوظة.'
  ));
}

function renderRumen(a = {}){
  const n = a.nutrition || {};
  const t = a.targets || {};
  const rh = n.rumenHealthModel || {};
  const state = rh.status || n.rumenStatus || '';

  const rows = [
    metricRow('حالة الكرش', 'آمن', rh.title || n.rumenStatus || '—', '—', state, rh.reason || n.rumenNote || '—'),
    metricRow('الخشن من DM', `حد أدنى ${pct(t.roughageMin,1)}`, pct(n.roughPctDM,1), finite(n.roughPctDM) && finite(t.roughageMin) ? pct(Number(n.roughPctDM) - Number(t.roughageMin),1) : '—', minLimitState(n.roughPctDM, t.roughageMin), 'الخشن ليس رقمًا فقط؛ الفعالية مهمة.'),
    metricRow('Forage NDF', `حد أدنى ${pct(t.forageNDFMin,1)}`, pct(n.forageNDFPctDM,1), finite(n.forageNDFPctDM) && finite(t.forageNDFMin) ? pct(Number(n.forageNDFPctDM) - Number(t.forageNDFMin),1) : '—', minLimitState(n.forageNDFPctDM, t.forageNDFMin), 'حماية الكرش من مصدر خشن.'),
    metricRow('peNDF', `حد أدنى ${pct(t.peNDFMin,1)}`, pct(n.peNDFPctActual,1), finite(n.peNDFPctActual) && finite(t.peNDFMin) ? pct(Number(n.peNDFPctActual) - Number(t.peNDFMin),1) : '—', minLimitState(n.peNDFPctActual, t.peNDFMin), 'ألياف مؤثرة للمضغ واللعاب.'),
    metricRow('النشا', `حد أقصى ${pct(t.starchMax,1)}`, pct(n.starchPctActual,1), finite(n.starchPctActual) && finite(t.starchMax) ? pct(Number(n.starchPctActual) - Number(t.starchMax),1) : '—', highLimitState(n.starchPctActual, t.starchMax), 'يُفسّر مع الألياف وليس منفردًا.')
  ];

  return section('صحة الكرش', `
    ${rh.instruction ? `<div class="decision-box">
      <div class="decision-head">
        <div class="decision-title">توجيه صحة الكرش</div>
        ${badge(statusText(state), state)}
      </div>
      <div class="decision-text">${esc(rh.title || '—')}</div>
      <div class="decision-note">${esc(rh.instruction)}</div>
    </div>` : ''}
    ${table(['المؤشر','الهدف / الحد','الفعلي','الفرق','الحكم','التفسير'], rows)}
  `);
}

function renderEconomics(a = {}, stage = '', ctx = {}){
  if(!isLactating(stage, ctx)) return '';

  const totals = a.totals || {};
  const e = a.economics || {};

  const rows = [
    `<tr><td class="metric-name">تكلفة العلف/رأس/يوم</td><td>${money(totals.totCost)}</td></tr>`,
    `<tr><td class="metric-name">تكلفة كجم اللبن</td><td>${money(e.costPerKgMilk)}</td></tr>`,
    `<tr><td class="metric-name">إيراد اللبن/رأس/يوم</td><td>${money(e.milkRevenue)}</td></tr>`,
    `<tr><td class="metric-name">هامش اللبن بعد العلف/رأس</td><td>${money(e.milkMargin)} ${finite(e.milkMargin) ? badge(Number(e.milkMargin) < 0 ? 'خطر' : 'مقبول', Number(e.milkMargin) < 0 ? 'danger' : 'good') : ''}</td></tr>`,
    `<tr><td class="metric-name">DM / كجم لبن</td><td>${kg(e.dmPerKgMilk,2)}</td></tr>`,
    `<tr><td class="metric-name">سعر طن العليقة as-fed</td><td>${money(totals.mixPriceAsFed)}</td></tr>`
  ];

  return section('الاقتصاد — للحلاب', table(['البند','القيمة'], rows));
}

function renderRows(rows = []){
  const body = (Array.isArray(rows) ? rows : []).map(r => {
    const asFed = num(r.asFedKg ?? r.kg ?? r.amount);
    const dmPct = num(r.dmPct ?? r.dm);
    const cpPct = num(r.cpPct ?? r.cp);
    const ndfPct = num(r.ndfPct ?? r.ndf);
    const starchPct = num(r.starchPct ?? r.starch);
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
      <td>${money(cost)}</td>
    </tr>`;
  });

  return section('تركيبة العليقة ومساهمة الخامات', table(
    ['الخامة','الفئة','as-fed','DM kg','CP kg','NDF kg','نشا kg','تكلفة/رأس'],
    body,
    'لا توجد خامات محفوظة.'
  ));
}

/* ============================================================
   المعادن والفيتامينات — لا حكم بدون بيانات مكتملة
============================================================ */
function mineralVal(item, keyG, keyMg){
  const v = item?.[keyG] ?? item?.[keyMg];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function completeBalanceItem(item = {}, kind = 'mineral', unit = 'g'){
  if(!item || typeof item !== 'object') return false;

  const required = kind === 'vitamin'
    ? num(item.requiredIU)
    : (unit === 'mg'
        ? mineralVal(item, 'requiredMg', 'requiredG')
        : mineralVal(item, 'requiredG', 'requiredMg'));

  const supplied = kind === 'vitamin'
    ? num(item.suppliedIU)
    : (unit === 'mg'
        ? mineralVal(item, 'suppliedMg', 'suppliedG')
        : mineralVal(item, 'suppliedG', 'suppliedMg'));

  const balance = kind === 'vitamin'
    ? num(item.balanceIU)
    : (unit === 'mg'
        ? mineralVal(item, 'balanceMg', 'balanceG')
        : mineralVal(item, 'balanceG', 'balanceMg'));

  const cover = num(item.supplyPctOfRequirement);

  return Number.isFinite(required) && Number.isFinite(supplied) && (Number.isFinite(balance) || Number.isFinite(cover));
}

function itemStatusAr(item = {}, complete = false){
  if(!complete) return 'بيانات غير مكتملة';
  const s = String(item.status || '').toLowerCase();
  if(s.includes('deficit')) return 'نقص';
  if(s.includes('excess')) return 'زيادة';
  if(s.includes('ok')) return 'مقبول';
  if(s.includes('warn') || s.includes('watch')) return 'مراجعة';
  return 'محسوب';
}

function mineralTableRows(balance = {}, unit = 'g'){
  const orderMacro = ['Ca','P','Mg','Na','K','Cl','S'];
  const orderTrace = ['Co','Cu','Fe','I','Mn','Se','Zn'];
  const order = unit === 'mg' ? orderTrace : orderMacro;

  return order
    .filter(k => balance && balance[k])
    .map(k => {
      const item = balance[k] || {};
      const complete = completeBalanceItem(item, 'mineral', unit);

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
      const state = complete ? item.status : 'unknown';

      return `<tr>
        <td class="metric-name">${esc(k)}</td>
        <td>${required == null ? '—' : `${nf(required, 2)} ${unit}`}</td>
        <td>${supplied == null ? '—' : `${nf(supplied, 2)} ${unit}`}</td>
        <td>${bal == null ? '—' : `${nf(bal, 2)} ${unit}`}</td>
        <td>${Number.isFinite(cover) ? nf(cover, 1) + '%' : '—'}</td>
        <td>${badge(itemStatusAr(item, complete), state)}</td>
      </tr>`;
    });
}

function vitaminTableRows(balance = {}){
  return ['A','D','E']
    .filter(k => balance && balance[k])
    .map(k => {
      const item = balance[k] || {};
      const complete = completeBalanceItem(item, 'vitamin');

      const required = num(item.requiredIU);
      const supplied = num(item.suppliedIU);
      const bal = num(item.balanceIU);
      const cover = num(item.supplyPctOfRequirement);
      const state = complete ? item.status : 'unknown';

      return `<tr>
        <td class="metric-name">${esc(k)}</td>
        <td>${Number.isFinite(required) ? nf(required, 0) : '—'} IU</td>
        <td>${Number.isFinite(supplied) ? nf(supplied, 0) : '—'} IU</td>
        <td>${Number.isFinite(bal) ? nf(bal, 0) : '—'} IU</td>
        <td>${Number.isFinite(cover) ? nf(cover, 1) + '%' : '—'}</td>
        <td>${badge(itemStatusAr(item, complete), state)}</td>
      </tr>`;
    });
}

function collectDeficits(balance = {}, kind = 'mineral', unit = 'g'){
  return Object.entries(balance || {})
    .filter(([_, v]) => completeBalanceItem(v, kind, unit))
    .filter(([_, v]) => String(v?.status || '').toLowerCase().includes('deficit'))
    .map(([k, v]) => ({
      key: k,
      cover: num(v.supplyPctOfRequirement)
    }))
    .sort((a,b) => (Number(a.cover) || 0) - (Number(b.cover) || 0));
}

function hasAnyCompleteBalance(balance = {}, kind = 'mineral', unit = 'g'){
  return Object.values(balance || {}).some(v => completeBalanceItem(v, kind, unit));
}

function mineralAdvice(macroBalance = {}, traceBalance = {}, vitBalance = {}, close = false){
  const macroComplete = hasAnyCompleteBalance(macroBalance, 'mineral', 'g');
  const traceComplete = hasAnyCompleteBalance(traceBalance, 'mineral', 'mg');
  const vitComplete = hasAnyCompleteBalance(vitBalance, 'vitamin');

  const notes = [];

  if(!macroComplete && !traceComplete && !vitComplete){
    notes.push('بيانات الإمداد غير مكتملة — لا يمكن الحكم على نقص أو زيادة المعادن/الفيتامينات.');
    if(close){
      notes.push('في انتظار الولادة يجب مراجعة DCAD وCa/Mg فقط عند اكتمال بيانات الاحتياج والإمداد.');
    }
    return `<ul class="priority-list">${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }

  const macroDef = collectDeficits(macroBalance, 'mineral', 'g');
  const traceDef = collectDeficits(traceBalance, 'mineral', 'mg');
  const vitDef = collectDeficits(vitBalance, 'vitamin');

  if(macroDef.length){
    notes.push(`المعادن الكبرى الناقصة: ${macroDef.map(x => x.key).join('، ')}. ابدأ بتصحيح الأقل تغطية فقط.`);
  }

  if(traceDef.length){
    notes.push(`العناصر الصغرى الناقصة: ${traceDef.map(x => x.key).join('، ')}. راجع premix المعادن الصغرى ومعدل الإضافة الفعلي.`);
  }

  if(vitDef.length){
    notes.push(`الفيتامينات الناقصة: ${vitDef.map(x => x.key).join('، ')}. راجع مصدر A/D/E أو premix الفيتامينات.`);
  }

  if(close){
    notes.push('في انتظار الولادة راجع DCAD والكالسيوم والماغنسيوم مع أملاح الأنيون تحت إشراف فني.');
  }

  if(!notes.length){
    notes.push('البيانات المكتملة لا تُظهر عجزًا واضحًا في المعادن/الفيتامينات.');
  }

  return `<ul class="priority-list">${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

function renderMineralsVitamins(a = {}, stage = '', ctx = {}){
  const n = a.nutrition || {};
  const supply = n.mineralSupplyModel || {};
  const vitSupply = n.vitaminSupplyModel || {};
  const dcad = n.dcadModel || {};
  const close = isCloseUp(stage, ctx);

  const macroBalance = supply?.mineralBalanceModel?.balance || {};
  const traceBalance = supply?.traceMineralBalanceModel?.balance || {};
  const vitBalance = vitSupply?.vitaminBalanceModel?.balance || {};

  const macroRows = mineralTableRows(macroBalance, 'g');
  const traceRows = mineralTableRows(traceBalance, 'mg');
  const vitRows = vitaminTableRows(vitBalance);

  const hasComplete =
    hasAnyCompleteBalance(macroBalance, 'mineral', 'g') ||
    hasAnyCompleteBalance(traceBalance, 'mineral', 'mg') ||
    hasAnyCompleteBalance(vitBalance, 'vitamin');

  const dcadVal = num(dcad?.dcadMeqKgDM);
  const dcadHtml = close
    ? `<div style="margin-top:12px">
        ${table(['البند','القيمة','الحكم'], [
          `<tr>
            <td class="metric-name">DCAD انتظار الولادة</td>
            <td>${Number.isFinite(dcadVal) ? `${nf(dcadVal,0)} mEq/kg DM` : '—'}</td>
            <td>${Number.isFinite(dcadVal) ? badge(dcadVal > -50 ? 'مراجعة' : 'مقبول', dcadVal > -50 ? 'warn' : 'good') : badge('غير مكتمل','unknown')}</td>
          </tr>`
        ])}
      </div>`
    : '';

  return section('المعادن والفيتامينات', `
    <div class="small-note" style="margin-bottom:10px">
      قاعدة مُرَبِّيك: لا يظهر حكم نقص أو زيادة إلا عند اكتمال بيانات الاحتياج + الإمداد + الميزان أو التغطية.
    </div>

    ${!hasComplete ? `<div class="decision-box">
      <div class="decision-head">
        <div class="decision-title">حكم المعادن والفيتامينات</div>
        ${badge('غير مكتمل','unknown')}
      </div>
      <div class="decision-text">بيانات الإمداد غير مكتملة — لا يمكن الحكم.</div>
      <div class="decision-note">لن يتم اعتبار أي عنصر ناقصًا أو زائدًا حتى تكتمل بيانات الحكم.</div>
    </div>` : ''}

    ${table(['المعدن الكبير','الاحتياج','الإمداد','الميزان','التغطية','الحكم'], macroRows, 'لا توجد بيانات معادن كبرى محفوظة.')}
    ${table(['العنصر الصغير','الاحتياج','الإمداد','الميزان','التغطية','الحكم'], traceRows, 'لا توجد بيانات عناصر صغرى محفوظة.')}
    ${table(['الفيتامين','الاحتياج','الإمداد','الميزان','التغطية','الحكم'], vitRows, 'لا توجد بيانات فيتامينات محفوظة.')}
    ${dcadHtml}

    <div style="margin-top:12px">
      ${mineralAdvice(macroBalance, traceBalance, vitBalance, close)}
    </div>
  `);
}

/* ============================================================
   أولويات التدخل
============================================================ */
function renderActions(a = {}, stage = '', ctx = {}){
  const notes = [];
  const n = a.nutrition || {};
  const t = a.targets || {};
  const e = a.economics || {};

  if(finite(n.mpBalanceG) && Number(n.mpBalanceG) < -50){
    notes.push('تدخل بروتيني: راجع MP ومصدر البروتين الحقيقي قبل زيادة CP.');
  }

  if(finite(n.nelActual) && finite(t.nelTarget) && Number(n.nelActual) < Number(t.nelTarget) - 0.5){
    notes.push('تدخل طاقة: ابدأ بالمادة الجافة ثم كثافة الطاقة مع الحفاظ على أمان الكرش.');
  }

  if(finite(n.starchPctActual) && finite(t.starchMax) && Number(n.starchPctActual) > Number(t.starchMax)){
    notes.push('تدخل كرش: النشا أعلى من الحد؛ راجع الحبوب والألياف الفعالة.');
  }

  if(finite(n.peNDFPctActual) && finite(t.peNDFMin) && Number(n.peNDFPctActual) < Number(t.peNDFMin)){
    notes.push('تدخل ألياف: peNDF أقل من الحد؛ راجع طول تقطيع الخشن ومنع فرز الخلطة.');
  }

  if(isLactating(stage, ctx) && finite(e.milkMargin) && Number(e.milkMargin) < 0){
    notes.push('تدخل اقتصادي: الهامش سلبي؛ راجع تكلفة الخامات وسعر اللبن.');
  }

  if(isCloseUp(stage, ctx) && finite(n.dcadModel?.dcadMeqKgDM) && Number(n.dcadModel.dcadMeqKgDM) > -50){
    notes.push('تدخل انتظار ولادة: راجع DCAD وأملاح الأنيون تحت إشراف فني.');
  }

  if(!notes.length){
    notes.push('لا توجد أولوية تدخل حادة من التحليل المحفوظ.');
    notes.push('استمر في متابعة اللبن، المتبقي، الروث، والاجترار.');
  }

  return section('أولويات التدخل', `<ul class="priority-list">${notes.slice(0, 3).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
}

function renderOneRation(event = {}, opts = {}){
  const nDoc = event.nutrition || {};
  const a = nDoc.analysis || {};
  const ctx = nDoc.context || {};
  const rows = nDoc.rows || [];
  const stage = opts.stage || eventStage(event) || ctx.groupType || '';
  const groupName = opts.groupName || groupNameFromEvent(event);

  const breakClass = opts.pageBreak ? 'ration-break' : '';

  return `<div class="ration-block ${breakClass}">
    ${section(`تقرير عليقة: ${groupName}`, `
      ${renderDecisionBlock(event, a, stage, ctx)}
      <div class="screen-actions-row">
        <a href="nutrition-report.html?scope=group&type=${encodeURIComponent(qp.get('type') || '')}&groupName=${encodeURIComponent(groupName)}">فتح هذه العليقة منفردة</a>
      </div>
    `)}
    ${renderContextBlock(ctx, event, stage)}
    ${renderCoreNutrients(a, stage, ctx)}
    ${renderRumen(a)}
    ${renderEconomics(a, stage, ctx)}
    ${renderRows(rows)}
    ${renderMineralsVitamins(a, stage, ctx)}
    ${renderActions(a, stage, ctx)}
  </div>`;
}

function renderGroup(data){
  const e = data.event || {};
  const groupName = data.groupName || groupNameFromEvent(e);
  const stage = data.stage || eventStage(e);

  $('reportTitle').textContent = `تقرير تغذية: ${groupName}`;
  $('reportSub').textContent = `${stageLabel(stage, e?.nutrition?.context || {})} — تاريخ التحليل: ${safe(e.eventDate || e.date)} — تقرير عليقة منفردة`;
  $('statusBox').style.display = 'none';

  $('content').innerHTML = renderOneRation(e, { groupName, stage, pageBreak:false });
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
          هذا التقرير يجمع أحدث تحليل محفوظ لكل عليقة، ويعرض الحكم التنفيذي والفهرس والمقارنة ثم تفاصيل كل عليقة منفردة.
          الهدف أن تُعرف الأولوية من أول نظرة، بدون تكرار نفس البيانات بأكثر من صيغة.
        </div>
        <div style="margin-top:12px">
          ${first.groupName ? badge(`الأولوية: ${first.groupName}`, first.reportStatus) : badge('لا توجد أولوية محددة','unknown')}
        </div>
      </div>

      <div class="hero-side">
        ${kpi('عدد العلائق', nf(ex.totalRations,0))}
        ${kpi('علائق خطر', nf(ex.dangerCount,0), '', ex.dangerCount ? 'danger' : 'good')}
        ${kpi('علائق مراجعة', nf(ex.warningCount,0), '', ex.warningCount ? 'warn' : 'good')}
        ${kpi('علائق مقبولة', nf(ex.okCount,0), '', 'good')}
      </div>
    </div>

    <div class="cards" style="margin-top:12px">
      ${mini('أول تدخل', first.groupName || '—', first.priorityText || first.decisionText || '—', first.reportStatus)}
      ${mini('أعلى تكلفة كجم لبن', highCost.groupName || '—', finite(highCost.costPerKgMilk) ? money(highCost.costPerKgMilk) : '—', 'warn')}
      ${mini('أضعف هامش لبن-علف', weak.groupName || '—', finite(weak.milkMargin) ? money(weak.milkMargin) : '—', finite(weak.milkMargin) && Number(weak.milkMargin) < 0 ? 'danger' : 'warn')}
      ${mini('نمط التقرير', 'مجمّع + قابل للتفصيل', 'يمكن طباعة التقرير كله أو فتح أي عليقة منفردة.')}
    </div>
  `);
}

function renderRationIndex(report = {}, type = ''){
  const index = Array.isArray(report.index) ? report.index : [];

  const rows = index.map((x, i) => {
    const href = `nutrition-report.html?scope=group&type=${encodeURIComponent(type || x.species || '')}&groupName=${encodeURIComponent(x.groupName || '')}`;
    return `<tr class="click" onclick="location.href='${href}'">
      <td>${i + 1}</td>
      <td class="metric-name">${esc(x.groupName || '—')}</td>
      <td>${esc(x.stageLabel || '—')}</td>
      <td>${esc(x.speciesLabel || '—')}</td>
      <td>${nf(x.headCount,0)}</td>
      <td>${finite(x.milkTargetKg) ? kg(x.milkTargetKg,1) : '—'}</td>
      <td>${x.reportStatus ? badge(statusText(x.reportStatus), x.reportStatus) : badge('غير محسوم','unknown')}</td>
      <td>${esc(x.priorityText || x.decisionText || '—')}</td>
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
    <td>${x.reportStatus ? badge(statusText(x.reportStatus), x.reportStatus) : badge('غير محسوم','unknown')}</td>
  </tr>`);

  return section('مقارنة مختصرة بين العلائق', table(
    ['العليقة','المرحلة','DMI فعلي/هدف','NEL فعلي/هدف','MP فعلي/هدف','ميزان MP','NDF','نشا','تكلفة كجم اللبن','الحكم'],
    rows,
    'لا توجد بيانات مقارنة.'
  ));
}

function renderUnifiedPriorities(report = {}){
  const index = Array.isArray(report.index) ? report.index : [];
  const sorted = [...index].sort((a, b) => {
    const w = s => s === 'danger' ? 1 : s === 'warn' ? 2 : s === 'good' ? 3 : 4;
    return w(a.reportStatus) - w(b.reportStatus);
  });

  const rows = sorted.slice(0, 8).map((x, i) => `<tr>
    <td>${i + 1}</td>
    <td class="metric-name">${esc(x.groupName || '—')}</td>
    <td>${esc(x.stageLabel || '—')}</td>
    <td>${x.reportStatus ? badge(statusText(x.reportStatus), x.reportStatus) : badge('غير محسوم','unknown')}</td>
    <td>${esc(x.priorityText || x.decisionText || 'متابعة دورية')}</td>
  </tr>`);

  return section('ملخص التدخلات الموحد', table(
    ['الأولوية','العليقة','المرحلة','الحالة','الإجراء المقترح'],
    rows,
    'لا توجد تدخلات محددة.'
  ));
}

function renderAll(data){
  const report = data.report || {};
  const events = Array.isArray(report.events) ? report.events : [];
  const type = data.type || qp.get('type') || '';

  const typeLabel = String(type).toLowerCase().includes('buffalo') ? 'جاموس' : (String(type).toLowerCase().includes('cows') ? 'أبقار' : 'كل الأنواع');

  $('reportTitle').textContent = `تقرير التغذية الشامل — ${typeLabel}`;
  $('reportSub').textContent = `عدد العلائق داخل التقرير: ${nf(report.count || events.length,0)} — أحدث تحليل محفوظ لكل عليقة`;
  $('statusBox').style.display = 'none';

  const rationReports = events.map((ev, i) => renderOneRation(ev, {
    groupName: groupNameFromEvent(ev),
    stage: eventStage(ev),
    pageBreak: true
  })).join('');

  $('content').innerHTML = `
    ${renderExecutiveAll(report, type)}
    ${renderRationIndex(report, type)}
    ${renderAllComparison(report)}
    ${renderUnifiedPriorities(report)}
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
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}
function num(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clsByState(state){
  const s = String(state || '').toLowerCase();
  if(s.includes('danger') || s.includes('bad') || s.includes('deficit') || s.includes('high_risk') || s.includes('excess')) return 'danger';
  if(s.includes('warn') || s.includes('watch') || s.includes('limited') || s.includes('low') || s.includes('border')) return 'warn';
  return '';
}
function badge(text, state = ''){
  if(!text) return '';
  return `<span class="badge ${clsByState(state || text)}">${esc(text)}</span>`;
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
  const label = stageLabel(stage, ctx);
  return label === 'حلاب' || Number(ctx.avgMilkKg || 0) > 0;
}
function isCloseUp(stage, ctx = {}){
  return stageLabel(stage, ctx) === 'انتظار الولادة';
}
function statusForBalance(balance, tolerance = 0){
  const n = Number(balance);
  if(!Number.isFinite(n)) return '';
  if(n < -Math.abs(tolerance)) return 'danger';
  if(n > Math.abs(tolerance)) return 'warn';
  return '';
}
function card(label, value, sub = '', state = ''){
  return `<div class="kpi">
    <b>${esc(value)}</b>
    <span>${esc(label)}</span>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
    ${state ? `<div style="margin-top:6px">${badge(state, state)}</div>` : ''}
  </div>`;
}
function mini(title, value, note = '', state = ''){
  return `<div class="mini">
    <div class="name">${esc(title)} ${state ? badge(state, state) : ''}</div>
    <div class="value">${esc(value)}</div>
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
  </div>`;
}
function section(title, html){
  return `<section class="card"><div class="section-title">${esc(title)}</div>${html}</section>`;
}
function table(headers, rows, empty = 'لا توجد بيانات.'){
  const head = headers.map(h => `<th>${esc(h)}</th>`).join('');
  const body = rows && rows.length
    ? rows.join('')
    : `<tr><td colspan="${headers.length}">${esc(empty)}</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

async function apiGet(path){
  const uid = await waitTenant();
  const headers = { 'Cache-Control': 'no-store' };
  if(uid) headers['X-User-Id'] = uid;

  const res = await fetch(API_BASE + path, { headers, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if(!res.ok || data.ok === false) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

function buildPath(){
  const type = qp.get('type') || '';
  const view = qp.get('view') || '';
  let scope = qp.get('scope') || '';

  // كروت الداشبورد ترسل view، فنفتح الملخص التجميعي للحلاب.
  if(!scope && view) scope = 'lactating_summary';
  if(!scope) scope = 'group';

  const p = new URLSearchParams();
  p.set('scope', scope);
  if(type) p.set('type', type);
  if(qp.get('stage')) p.set('stage', qp.get('stage'));
  if(qp.get('groupName')) p.set('groupName', qp.get('groupName'));
  if(qp.get('group')) p.set('group', qp.get('group'));
  return `/api/nutrition/report/latest?${p.toString()}`;
}

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
  if(!notes.length) notes.push('المؤشرات العامة مستقرة. راجع تفاصيل كل مجموعة للتدخل الدقيق.');

  return notes;
}

function renderSummary(data){
  const s = data.summary || {};
  const totals = s.totals || {};
  const groups = Array.isArray(s.groups) ? s.groups : [];
  const type = qp.get('type') || data.type || '';
  const typeLabel = String(type).toLowerCase().includes('buffalo') ? 'جاموس' : 'أبقار';

  $('reportTitle').textContent = `تقرير الإنتاج الاقتصادي للحلاب — ${typeLabel}`;
  $('reportSub').textContent = 'تجميع آخر تحليلات التغذية المحفوظة لكل مجموعات الحلاب، بدون إعادة حساب.';
  $('statusBox').style.display = 'none';

  const rows = groups.map(gp => {
    const name = gp.groupName || 'مجموعة بدون اسم';
    const href = `nutrition-report.html?scope=group&type=${encodeURIComponent(type)}&groupName=${encodeURIComponent(name)}`;
    const state = Number(gp.marginPerHead || 0) < 0 ? 'danger' : (Number(gp.costPerKgMilk || 0) > Number(totals.costPerKgMilk || 0) ? 'warn' : '');
    return `<tr class="click" onclick="location.href='${href}'">
      <td>${esc(name)} ${state ? badge(state === 'danger' ? 'خطر' : 'متابعة', state) : ''}</td>
      <td>${nf(gp.headCount,0)}</td>
      <td>${nf(gp.avgMilkKg,1)}</td>
      <td>${nf(gp.totalMilkKg,1)}</td>
      <td>${money(gp.feedCostPerHead)}</td>
      <td>${money(gp.costPerKgMilk)}</td>
      <td>${money(gp.marginPerHead)}</td>
      <td>${money(gp.totalMargin)}</td>
    </tr>`;
  });

  const advice = adviceForSummary(groups, totals).map(x => `<li>${esc(x)}</li>`).join('');

  $('content').innerHTML = `
    ${section('ملخص كل الحلاب', `<div class="grid">
      ${card('عدد الرؤوس', nf(totals.headCount,0))}
      ${card('إجمالي اللبن اليومي', kg(totals.totalMilkKg,1))}
      ${card('إجمالي تكلفة العلف اليومية', money(totals.totalFeedCost))}
      ${card('هامش اللبن بعد العلف', money(totals.totalMargin), '', Number(totals.totalMargin) < 0 ? 'danger' : '')}
      ${card('متوسط تكلفة كجم اللبن', money(totals.costPerKgMilk))}
      ${card('متوسط اللبن/رأس', kg(totals.avgMilkKg,1))}
      ${card('أفضل مجموعة اقتصاديًا', s.best?.groupName || '—')}
      ${card('أولوية التدخل', s.weakest?.groupName || '—')}
    </div>`)}

    ${section('توصيات تنفيذية سريعة', `<ul class="sub" style="margin:0;padding-inline-start:22px;font-weight:900;color:#334155">${advice}</ul>`)}

    ${section('مقارنة مجموعات الحلاب', table(
      ['المجموعة','الرؤوس','لبن/رأس','إجمالي اللبن','تكلفة رأس','تكلفة كجم اللبن','هامش/رأس','إجمالي الهامش'],
      rows,
      'لا توجد مجموعات حلاب محفوظة.'
    ))}
  `;
}

function renderContextBlock(ctx = {}, event = {}, stage = ''){
  return section('بيانات السياق', `<div class="grid">
    ${card('المرحلة', stageLabel(stage, ctx))}
    ${card('اسم المجموعة', ctx.groupName || ctx.group || ctx.groupLabel || '—')}
    ${card('عدد الرؤوس', nf(event.groupSize || ctx.headCount,0))}
    ${card('النوع', safe(ctx.species))}
    ${card('السلالة', safe(ctx.breed))}
    ${card('أيام الحليب DIM', nf(ctx.daysInMilk,0))}
    ${card('متوسط اللبن/رأس', Number(ctx.avgMilkKg || 0) > 0 ? kg(ctx.avgMilkKg,1) : '—')}
    ${card('أيام الحمل DCC', nf(ctx.pregnancyDays,0))}
    ${card('متبقي للولادة', nf(ctx.daysToCalving,0))}
    ${card('الموسم', nf(ctx.parity || ctx.lactationNumber,0))}
    ${card('الوزن المستخدم', kg(ctx.bodyWeight || ctx.bodyWeightKg,0))}
    ${card('BCS', nf(ctx.bcs || ctx.groupBcs,2))}
  </div>`);
}

function renderCoreNutrients(a = {}, stage = '', ctx = {}){
  const lact = isLactating(stage, ctx);
  const close = isCloseUp(stage, ctx);
  const n = a.nutrition || {};
  const t = a.targets || {};
  const e = a.economics || {};

  const mpBal = num(n.mpBalanceG);
  const nelBal = (num(n.nelActual) != null && num(t.nelTarget) != null) ? num(n.nelActual) - num(t.nelTarget) : null;
  const dmBal = (num(a.totals?.dmKg) != null && num(t.dmiTarget) != null) ? num(a.totals.dmKg) - num(t.dmiTarget) : null;

  const cards = [
    card('المادة الجافة الفعلية', kg(a.totals?.dmKg,2), `الاحتياج: ${kg(t.dmiTarget,2)}`, statusForBalance(dmBal, 0.5)),
    card('الطاقة الفعلية NEL', `${nf(n.nelActual,2)} Mcal`, `الاحتياج: ${nf(t.nelTarget,2)} Mcal`, statusForBalance(nelBal, 0.5)),
    card('CP الفعلي', pct(n.cpPctTotal,1), `المستهدف: ${pct(t.cpTarget,1)}`),
    card('MP الإمداد', g(n.mpSupplyG,0), `الاحتياج: ${g(t.mpTargetG,0)} | الميزان: ${g(mpBal,0)}`, statusForBalance(mpBal, 50)),
    card('NDF الكلي', pct(n.ndfPctActual,1), `المستهدف: ${pct(t.ndfTarget,1)}`),
    card('peNDF', pct(n.peNDFPctActual,1), `الحد الأدنى: ${pct(t.peNDFMin,1)}`),
    card('النشا', pct(n.starchPctActual,1), `الحد الأقصى: ${pct(t.starchMax,1)}`, num(n.starchPctActual) > num(t.starchMax) ? 'warn' : ''),
    card('دهن العليقة', pct(n.fatPctActual,1), '')
  ];

  if(lact){
    cards.push(card('تكلفة كجم اللبن', money(e.costPerKgMilk)));
    cards.push(card('هامش اللبن بعد العلف/رأس', money(e.milkMargin), '', num(e.milkMargin) < 0 ? 'danger' : ''));
    cards.push(card('إيراد اللبن/رأس', money(e.milkRevenue)));
    cards.push(card('DM / كجم لبن', kg(e.dmPerKgMilk,2)));
  }

  if(close){
    cards.push(card('DCAD', `${nf(n.dcadModel?.dcadMeqKgDM,0)} mEq/kg DM`, n.dcadModel?.note || '', num(n.dcadModel?.dcadMeqKgDM) > -50 ? 'warn' : ''));
  }

  return section('احتياج وإمداد العليقة', `<div class="grid">${cards.join('')}</div>`);
}

function renderPanels(panels = {}){
  const all = [
    ...(Array.isArray(panels.analysisCards) ? panels.analysisCards : []),
    ...(Array.isArray(panels.advancedCards) ? panels.advancedCards : []),
    ...(Array.isArray(panels.economicsCards) ? panels.economicsCards : [])
  ];

  const html = all.map(c => {
    const title = c.title || c.label || c.key || 'مؤشر';
    const value = c.value ?? c.actual ?? c.balance ?? '—';
    const note = c.targetText || c.note || c.reason || '';
    const state = c.status || c.state || '';
    return mini(title, value, note, state);
  }).join('');

  return section('كروت التحليل المحفوظة', `<div class="cards">${html || '<div class="empty">لا توجد كروت محفوظة لهذا التحليل.</div>'}</div>`);
}

function renderRumen(a = {}){
  const n = a.nutrition || {};
  const t = a.targets || {};
  const rh = n.rumenHealthModel || {};
  return section('صحة الكرش والألياف', `<div class="cards">
    ${mini('حالة الكرش', rh.title || n.rumenStatus || '—', n.rumenNote || rh.reason || '', rh.status || n.rumenStatus)}
    ${mini('الخشن من DM', pct(n.roughPctDM,1), `المركز: ${pct(n.concPctDM,1)}`)}
    ${mini('Forage NDF من DM', pct(n.forageNDFPctDM,1), `الحد الأدنى: ${pct(t.forageNDFMin,1)}`)}
    ${mini('نسبة NDF الخشن من NDF الكلي', pct(n.forageNDFShareOfTotalNDF,1), '')}
    ${mini('النشا', pct(n.starchPctActual,1), `الحد الأقصى: ${pct(t.starchMax,1)}`, num(n.starchPctActual) > num(t.starchMax) ? 'warn' : '')}
    ${mini('peNDF', pct(n.peNDFPctActual,1), `الحد الأدنى: ${pct(t.peNDFMin,1)}`, num(n.peNDFPctActual) < num(t.peNDFMin) ? 'warn' : '')}
  </div>`);
}

function statusAr(status){
  const s = String(status || '').toLowerCase();
  if (s.includes('deficit')) return 'نقص';
  if (s.includes('excess')) return 'زيادة';
  if (s.includes('ok')) return 'مقبول';
  if (s.includes('warn') || s.includes('watch')) return 'مراجعة';
  return 'محسوب';
}

function mineralVal(item, keyG, keyMg){
  const v = item?.[keyG] ?? item?.[keyMg];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function mineralTableRows(balance = {}, unit = 'g'){
  const orderMacro = ['Ca','P','Mg','Na','K','Cl','S'];
  const orderTrace = ['Co','Cu','Fe','I','Mn','Se','Zn'];
  const order = unit === 'mg' ? orderTrace : orderMacro;

  return order
    .filter(k => balance && balance[k])
    .map(k => {
      const item = balance[k] || {};

      const required = unit === 'mg'
        ? mineralVal(item, 'requiredG', 'requiredMg')
        : mineralVal(item, 'requiredG', 'requiredMg');

      const supplied = unit === 'mg'
        ? mineralVal(item, 'suppliedG', 'suppliedMg')
        : mineralVal(item, 'suppliedG', 'suppliedMg');

      const bal = unit === 'mg'
        ? mineralVal(item, 'balanceG', 'balanceMg')
        : mineralVal(item, 'balanceG', 'balanceMg');

      const cover = num(item.supplyPctOfRequirement);
      const st = item.status || '';

      return `<tr>
        <td>${esc(k)} ${badge(statusAr(st), st)}</td>
        <td>${required == null ? '—' : nf(required, 2)} ${unit}</td>
        <td>${supplied == null ? '—' : nf(supplied, 2)} ${unit}</td>
        <td>${bal == null ? '—' : nf(bal, 2)} ${unit}</td>
        <td>${Number.isFinite(cover) ? nf(cover, 1) + '%' : '—'}</td>
      </tr>`;
    });
}

function vitaminTableRows(balance = {}){
  return ['A','D','E']
    .filter(k => balance && balance[k])
    .map(k => {
      const item = balance[k] || {};
      const required = num(item.requiredIU);
      const supplied = num(item.suppliedIU);
      const bal = num(item.balanceIU);
      const cover = num(item.supplyPctOfRequirement);
      const st = item.status || '';

      return `<tr>
        <td>${esc(k)} ${badge(statusAr(st), st)}</td>
        <td>${Number.isFinite(required) ? nf(required, 0) : '—'} IU</td>
        <td>${Number.isFinite(supplied) ? nf(supplied, 0) : '—'} IU</td>
        <td>${Number.isFinite(bal) ? nf(bal, 0) : '—'} IU</td>
        <td>${Number.isFinite(cover) ? nf(cover, 1) + '%' : '—'}</td>
      </tr>`;
    });
}

function collectDeficits(balance = {}){
  return Object.entries(balance || {})
    .filter(([_, v]) => String(v?.status || '').toLowerCase().includes('deficit'))
    .map(([k, v]) => ({
      key: k,
      cover: num(v.supplyPctOfRequirement)
    }))
    .sort((a,b) => (Number(a.cover) || 0) - (Number(b.cover) || 0));
}

function mineralAdvice(macroBalance = {}, traceBalance = {}, vitBalance = {}, close = false){
  const macroDef = collectDeficits(macroBalance);
  const traceDef = collectDeficits(traceBalance);
  const vitDef = collectDeficits(vitBalance);

  const notes = [];

  if (macroDef.length){
    const keys = macroDef.map(x => x.key).join('، ');
    notes.push(`المعادن الكبرى الناقصة: ${keys}. ابدأ بتصحيح الأقل تغطية ولا ترفع كل الأملاح عشوائيًا.`);

    if (macroDef.some(x => x.key === 'Na')) {
      notes.push('نقص الصوديوم غالبًا يحتاج مراجعة ملح الطعام/مصدر NaCl في الخلطة.');
    }
    if (macroDef.some(x => x.key === 'Ca' || x.key === 'P')) {
      notes.push('نقص الكالسيوم أو الفوسفور يحتاج مراجعة الحجر الجيري/ثنائي فوسفات الكالسيوم أو مصدر Ca/P المستخدم.');
    }
    if (macroDef.some(x => x.key === 'Mg')) {
      notes.push('نقص الماغنسيوم يحتاج مراجعة مصدر Mg مناسب، خصوصًا مع علائق عالية البوتاسيوم.');
    }
  }

  if (traceDef.length){
    const keys = traceDef.map(x => x.key).join('، ');
    notes.push(`العناصر الصغرى الناقصة: ${keys}. راجع premix المعادن الصغرى ومعدل الإضافة الفعلي لكل رأس.`);
  }

  if (vitDef.length){
    const keys = vitDef.map(x => x.key).join('، ');
    notes.push(`الفيتامينات الناقصة: ${keys}. راجع premix الفيتامينات أو مصدر A/D/E في الخلطة.`);
  }

  if (close) {
    notes.push('في انتظار الولادة راجع DCAD والكالسيوم والماغنسيوم مع أملاح الأنيون تحت إشراف فني، ولا تعتمد على رقم واحد فقط.');
  }

  if (!notes.length){
    notes.push('المعادن والفيتامينات المحفوظة لا تظهر عجزًا واضحًا. استمر في المراجعة مع تغيّر الخامات والأسعار.');
  }

  return `<ul class="sub" style="margin:0;padding-inline-start:22px;font-weight:900;color:#334155;line-height:1.9">
    ${notes.map(x => `<li>${esc(x)}</li>`).join('')}
  </ul>`;
}

function renderMineralsVitamins(a = {}, stage = '', ctx = {}){
  const n = a.nutrition || {};
  const supply = n.mineralSupplyModel || {};
  const vitSupply = n.vitaminSupplyModel || {};
  const dcad = n.dcadModel || {};
  const close = isCloseUp(stage, ctx);

  const macroBalance = supply?.mineralBalanceModel?.balance || {};
  const traceBalance = supply?.traceMineralBalanceModel?.balance || {};
  const vitBalance = vitSupply?.vitaminBalanceModel?.balance || {};

  const macroRows = mineralTableRows(macroBalance, 'g');
  const traceRows = mineralTableRows(traceBalance, 'mg');
  const vitRows = vitaminTableRows(vitBalance);

  const dcadVal = num(dcad?.dcadMeqKgDM);
  const dcadHtml = close
    ? `<div class="cards" style="margin-top:12px">
        ${mini(
          close ? 'DCAD انتظار الولادة' : 'ميزان الأملاح DCAD',
          Number.isFinite(dcadVal) ? `${nf(dcadVal,0)} mEq/kg DM` : '—',
          close
            ? 'مؤشر مهم قبل الولادة ويُراجع مع أملاح الأنيون والكالسيوم والماغنسيوم.'
            : 'مؤشر أملاح للمتابعة، وليس وحده قرار تعديل لعليقة الحلاب.',
          close && Number.isFinite(dcadVal) && dcadVal > -50 ? 'warn' : ''
        )}
      </div>`
    : '';

  return section('المعادن والفيتامينات', `
    <div class="sub" style="font-weight:900;color:#334155;margin-bottom:10px">
      يعرض التقرير الاحتياج، الإمداد، الميزان، ونسبة التغطية لكل عنصر محفوظ في التحليل.
    </div>

    ${table(
      ['المعدن الكبير', 'الاحتياج', 'الإمداد', 'الميزان', 'التغطية'],
      macroRows,
      'لا توجد بيانات معادن كبرى محفوظة.'
    )}

    ${table(
      ['العنصر الصغير', 'الاحتياج', 'الإمداد', 'الميزان', 'التغطية'],
      traceRows,
      'لا توجد بيانات عناصر صغرى محفوظة.'
    )}

    ${table(
      ['الفيتامين', 'الاحتياج', 'الإمداد', 'الميزان', 'التغطية'],
      vitRows,
      'لا توجد بيانات فيتامينات محفوظة.'
    )}

    ${dcadHtml}

    <div style="margin-top:12px">
      ${mineralAdvice(macroBalance, traceBalance, vitBalance, close)}
    </div>
  `);
}

function renderRows(rows = []){
  const body = (Array.isArray(rows) ? rows : []).map(r => `<tr>
    <td>${esc(r.name || r.nameAr || r.feedName || r.id || 'خامة')}</td>
    <td>${esc(r.cat || r.category || '—')}</td>
    <td>${kg(r.asFedKg ?? r.kg ?? r.amount,2)}</td>
    <td>${pct(r.dmPct ?? r.dm,1)}</td>
    <td>${pct(r.cpPct ?? r.cp,1)}</td>
    <td>${pct(r.ndfPct ?? r.ndf,1)}</td>
    <td>${pct(r.starchPct ?? r.starch,1)}</td>
    <td>${pct(r.fatPct ?? r.fat,1)}</td>
    <td>${money(r.pricePerTon ?? r.pTon ?? r.price ?? r.pTonRaw)}</td>
  </tr>`);

  return section('تركيبة العليقة المحفوظة', table(
    ['الخامة','الفئة','كجم as-fed','DM%','CP%','NDF%','نشا%','دهن%','السعر/طن'],
    body,
    'لا توجد خامات محفوظة.'
  ));
}

function renderActions(a = {}, stage = '', ctx = {}){
  const notes = [];
  const n = a.nutrition || {};
  const t = a.targets || {};
  const e = a.economics || {};

  if(num(n.mpBalanceG) != null && num(n.mpBalanceG) < -50) notes.push('يوجد عجز MP؛ راجع مصدر البروتين الحقيقي والهضم/الـRUP قبل زيادة البروتين الخام عشوائيًا.');
  if(num(n.nelActual) != null && num(t.nelTarget) != null && num(n.nelActual) < num(t.nelTarget) - 0.5) notes.push('الطاقة اليومية أقل من الاحتياج؛ راجع كثافة الطاقة والمأكول الفعلي.');
  if(num(n.starchPctActual) != null && num(t.starchMax) != null && num(n.starchPctActual) > num(t.starchMax)) notes.push('النشا أعلى من الحد؛ راجع الحبوب وسرعة التخمر وحافظ على الألياف الفعالة.');
  if(num(n.peNDFPctActual) != null && num(t.peNDFMin) != null && num(n.peNDFPctActual) < num(t.peNDFMin)) notes.push('الألياف الفعالة أقل من المطلوب؛ راجع طول تقطيع الخشن وتوزيع الخلط.');
  if(isLactating(stage, ctx) && num(e.milkMargin) != null && num(e.milkMargin) < 0) notes.push('هامش اللبن بعد العلف سلبي؛ راجع تكلفة الخامات وسعر اللبن والمجموعة الأقل كفاءة.');
  if(isCloseUp(stage, ctx) && num(n.dcadModel?.dcadMeqKgDM) != null && num(n.dcadModel.dcadMeqKgDM) > -50) notes.push('DCAD غير مناسب لانتظار الولادة؛ راجع أملاح الأنيون تحت إشراف فني.');
  if(!notes.length) notes.push('لا توجد أولوية تدخل حادة من التحليل المحفوظ. استمر في المتابعة اليومية للمأكول واللبن والصحة.');

  return section('أولويات التدخل', `<ul class="sub" style="margin:0;padding-inline-start:22px;font-weight:900;color:#334155;line-height:1.9">${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
}

function renderGroup(data){
  const e = data.event || {};
  const nDoc = e.nutrition || {};
  const a = nDoc.analysis || {};
  const ctx = nDoc.context || {};
  const panels = nDoc.panels || {};
  const rows = nDoc.rows || [];
  const stage = data.stage || ctx.groupType || '';
  const groupName = data.groupName || ctx.groupName || ctx.group || ctx.groupLabel || 'مجموعة تغذية';

  $('reportTitle').textContent = `تقرير تغذية: ${groupName}`;
  $('reportSub').textContent = `${stageLabel(stage, ctx)} — تاريخ التحليل: ${safe(e.eventDate || e.date)} — عدد الرؤوس: ${safe(e.groupSize || ctx.headCount)}`;
  $('statusBox').style.display = 'none';

  $('content').innerHTML = `
    ${renderContextBlock(ctx, e, stage)}
    ${renderCoreNutrients(a, stage, ctx)}
    ${renderPanels(panels)}
    ${renderRows(rows)}
    ${renderRumen(a)}
    ${renderMineralsVitamins(a, stage, ctx)}
    ${renderActions(a, stage, ctx)}
  `;
}

async function main(){
  try{
    const data = await apiGet(buildPath());
    if(data.scope === 'lactating_summary') renderSummary(data);
    else renderGroup(data);
  }catch(e){
    $('reportTitle').textContent = 'تعذر تحميل تقرير التغذية';
    $('reportSub').textContent = 'تأكد من وجود تحليل تغذية محفوظ مطابق ومن تسجيل الدخول.';
    $('statusBox').style.display = 'block';
    $('statusBox').textContent = '⚠️ ' + (e.message || String(e));
  }
}

main();
