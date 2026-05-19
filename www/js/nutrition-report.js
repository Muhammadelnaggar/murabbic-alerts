// مُرَبِّيك — تقرير التغذية
// عرض فقط: يقرأ آخر تحليل محفوظ من السيرفر ولا يعيد حساب الاحتياجات أو الإمداد.
const API_BASE = window.API_BASE || 'https://murabbic-alerts.onrender.com';

const $ = id => document.getElementById(id);
const qp = new URLSearchParams(location.search);

function getTenantId(){
  try{
    const T = window.__TENANT__ || {};
    return T.userId || T.uid || T.id || T.tenantId || localStorage.getItem('userId') || localStorage.getItem('uid') || localStorage.getItem('tenantId') || null;
  }catch(_){ return null; }
}
async function waitTenant(ms=1800){
  const start=Date.now();
  while(Date.now()-start<ms){ const id=getTenantId(); if(id) return id; await new Promise(r=>setTimeout(r,120)); }
  return getTenantId();
}
function nf(v,d=2){
  const n=Number(v);
  if(!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(d);
}
function safe(v){ return (v===null||v===undefined||v==='') ? '—' : String(v); }
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function statusBadge(state){
  const s=String(state||'').toLowerCase();
  if(s.includes('deficit')||s.includes('danger')||s.includes('bad')) return 'danger';
  if(s.includes('watch')||s.includes('warn')||s.includes('limited')) return 'warn';
  return '';
}
function stageLabel(stage){
  if(stage==='lactating') return 'حلاب';
  if(stage==='far_dry') return 'جاف بعيد';
  if(stage==='close_up') return 'انتظار الولادة';
  return 'غير محدد';
}
function card(label,value,sub=''){
  return `<div class="kpi"><b>${esc(value)}</b><span>${esc(label)}</span>${sub?`<div class="sub">${esc(sub)}</div>`:''}</div>`;
}
function mini(title,value,note='',state=''){
  return `<div class="mini"><div class="name">${esc(title)} ${state?`<span class="badge ${statusBadge(state)}">${esc(state)}</span>`:''}</div><div class="value">${esc(value)}</div>${note?`<div class="note">${esc(note)}</div>`:''}</div>`;
}
async function apiGet(path){
  const uid = await waitTenant();
  const headers = {'Cache-Control':'no-store'};
  if(uid) headers['X-User-Id']=uid;
  const res = await fetch(API_BASE + path,{headers,cache:'no-store'});
  const data = await res.json().catch(()=>({}));
  if(!res.ok || data.ok===false) throw new Error(data.message || data.error || `HTTP ${res.status}`);
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
function renderSummary(data){
  const s = data.summary || {};
  const totals = s.totals || {};
  const groups = Array.isArray(s.groups) ? s.groups : [];
  $('reportTitle').textContent = 'تقرير الإنتاج الاقتصادي للحلاب';
  $('reportSub').textContent = 'تجميع آخر تحليلات التغذية المحفوظة لكل مجموعات الحلاب.';
  $('statusBox').style.display='none';

  const rows = groups.map(g => {
    const type = qp.get('type') || '';
    const name = g.groupName || 'مجموعة بدون اسم';
    const href = `nutrition-report.html?scope=group&type=${encodeURIComponent(type)}&groupName=${encodeURIComponent(name)}`;
    return `<tr class="click" onclick="location.href='${href}'">
      <td>${esc(name)}</td><td>${nf(g.headCount,0)}</td><td>${nf(g.avgMilkKg,1)}</td><td>${nf(g.totalMilkKg,1)}</td>
      <td>${nf(g.feedCostPerHead,2)}</td><td>${nf(g.costPerKgMilk,2)}</td><td>${nf(g.marginPerHead,2)}</td><td>${nf(g.totalMargin,2)}</td>
    </tr>`;
  }).join('');

  $('content').innerHTML = `
    <section class="card"><div class="section-title">ملخص كل الحلاب</div><div class="grid">
      ${card('عدد الرؤوس', nf(totals.headCount,0))}
      ${card('إجمالي اللبن اليومي', nf(totals.totalMilkKg,1)+' كجم')}
      ${card('إجمالي تكلفة العلف اليومية', nf(totals.totalFeedCost,2)+' جنيه')}
      ${card('هامش اللبن بعد العلف', nf(totals.totalMargin,2)+' جنيه')}
      ${card('متوسط تكلفة كجم اللبن', nf(totals.costPerKgMilk,2)+' جنيه')}
      ${card('متوسط اللبن/رأس', nf(totals.avgMilkKg,1)+' كجم')}
      ${card('أفضل مجموعة', s.best?.groupName || '—')}
      ${card('أولوية تدخل', s.weakest?.groupName || '—')}
    </div></section>
    <section class="card"><div class="section-title">مقارنة مجموعات الحلاب</div><div class="table-wrap"><table><thead><tr><th>المجموعة</th><th>الرؤوس</th><th>لبن/رأس</th><th>إجمالي اللبن</th><th>تكلفة رأس</th><th>تكلفة كجم اللبن</th><th>هامش/رأس</th><th>إجمالي الهامش</th></tr></thead><tbody>${rows || '<tr><td colspan="8">لا توجد مجموعات محفوظة.</td></tr>'}</tbody></table></div></section>
  `;
}
function renderGroup(data){
  const e = data.event || {};
  const n = e.nutrition || {};
  const a = n.analysis || {};
  const ctx = n.context || {};
  const panels = n.panels || {};
  const stage = data.stage || '';
  const groupName = data.groupName || ctx.groupName || ctx.group || ctx.groupLabel || 'مجموعة تغذية';
  $('reportTitle').textContent = `تقرير تغذية: ${groupName}`;
  $('reportSub').textContent = `${stageLabel(stage)} — تاريخ التحليل: ${safe(e.eventDate || e.date)} — عدد الرؤوس: ${safe(e.groupSize || ctx.headCount)}`;
  $('statusBox').style.display='none';

  const cards = [];
  cards.push(card('المادة الجافة الفعلية', nf(a?.totals?.dmKg,2)+' كجم'));
  cards.push(card('احتياج المادة الجافة', nf(a?.targets?.dmiTarget,2)+' كجم'));
  cards.push(card('الطاقة الفعلية NEL', nf(a?.nutrition?.nelActual,2)+' Mcal'));
  cards.push(card('احتياج الطاقة NEL', nf(a?.targets?.nelTarget,2)+' Mcal'));
  cards.push(card('CP الفعلي', nf(a?.nutrition?.cpPctTotal,1)+'%'));
  cards.push(card('CP المستهدف', nf(a?.targets?.cpTarget,1)+'%'));
  cards.push(card('MP الإمداد', nf(a?.nutrition?.mpSupplyG,0)+' جم'));
  cards.push(card('MP الميزان', nf(a?.nutrition?.mpBalanceG,0)+' جم'));

  const analysisCards = [...(panels.analysisCards||[]), ...(panels.advancedCards||[]), ...(panels.economicsCards||[])];
  const panelHtml = analysisCards.slice(0,18).map(c => mini(c.title || c.label || c.key, c.value ?? c.actual ?? '—', c.targetText || c.note || '', c.status || '')).join('');

  const mineral = a?.nutrition?.mineralSupplyModel?.mineralBalanceModel;
  const trace = a?.nutrition?.mineralSupplyModel?.traceMineralSupplyModel?.traceMineralBalanceModel;
  const vit = a?.nutrition?.vitaminSupplyModel?.vitaminBalanceModel;

  $('content').innerHTML = `
    <section class="card"><div class="section-title">ملخص سريع</div><div class="grid">${cards.join('')}</div></section>
    <section class="card"><div class="section-title">قراءة الكروت المحفوظة</div><div class="cards">${panelHtml || '<div class="empty">لا توجد panels محفوظة لهذا التحليل.</div>'}</div></section>
    <section class="card"><div class="section-title">صحة الكرش والمكونات</div><div class="cards">
      ${mini('NDF الكلي', nf(a?.nutrition?.ndfPctActual,1)+'%', 'المستهدف: '+nf(a?.targets?.ndfTarget,1)+'%')}
      ${mini('النشا', nf(a?.nutrition?.starchPctActual,1)+'%', 'الحد الأقصى: '+nf(a?.targets?.starchMax,1)+'%')}
      ${mini('الدهون', nf(a?.nutrition?.fatPctActual,1)+'%', '')}
      ${mini('صحة الكرش', a?.nutrition?.rumenHealthModel?.title || a?.nutrition?.rumenStatus || '—', a?.nutrition?.rumenNote || '')}
    </div></section>
    <section class="card"><div class="section-title">المعادن والفيتامينات</div><div class="cards">
      ${mini('المعادن الكبرى', mineral?.status || '—', mineral?.note || '', mineral?.status)}
      ${mini('العناصر الصغرى', trace?.status || '—', trace?.note || '', trace?.status)}
      ${mini('الفيتامينات A/D/E', vit?.status || '—', vit?.note || '', vit?.status)}
      ${mini('DCAD', nf(a?.nutrition?.dcadModel?.dcadMeqKgDM,0)+' mEq/kg DM', a?.nutrition?.dcadModel?.note || '')}
    </div></section>
  `;
}
async function main(){
  try{
    const data = await apiGet(buildPath());
    if(data.scope === 'lactating_summary') renderSummary(data);
    else renderGroup(data);
  }catch(e){
    $('reportTitle').textContent = 'تعذر تحميل تقرير التغذية';
    $('reportSub').textContent = 'تأكد من وجود تحليل تغذية محفوظ مطابق.';
    $('statusBox').textContent = '⚠️ ' + (e.message || String(e));
  }
}
main();
