// مُرَبِّيك — تقرير التغذية الكامل
// عرض فقط: يقرأ آخر تحليل محفوظ من السيرفر ولا يعيد حساب الاحتياجات أو الإمداد.
const API_BASE = window.API_BASE || 'https://murabbic-alerts.onrender.com';

const $ = (id) => document.getElementById(id);
const qp = new URLSearchParams(location.search);

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
