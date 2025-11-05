// Gauge بسيط بسهم وإضاءة نطاقات — لا يعتمد على أي مكتبة
export function renderGauge(el, opts){
  const cfg = Object.assign({
    min:0, max:100, value:0, unit:'%', label:'',
    bands:[ // من - إلى - لون
      {from:0, to:60, color:'var(--red)'},
      {from:60, to:80, color:'var(--yellow)'},
      {from:80, to:100, color:'var(--green)'},
    ],
  }, opts||{});

  // قياس وزوايا
  const clamp = (v,min,max)=>Math.max(min, Math.min(max,v));
  const v = clamp(cfg.value, cfg.min, cfg.max);
  const span = cfg.max - cfg.min || 1;
  const t = (v - cfg.min) / span;              // 0..1
  const start = Math.PI;                        // 180°
  const end   = 0;                              //   0°
  const theta = start + (end-start)*t;          // زاوية الإبرة

  // دوال رسم أقواس
  const polar = (cx,cy,r,ang)=>[cx+r*Math.cos(ang), cy+r*Math.sin(ang)];
  const arc = (cx,cy,r,a0,a1,color)=> {
    const [x0,y0]=polar(cx,cy,r,a0), [x1,y1]=polar(cx,cy,r,a1);
    const large = (a1-a0) <= Math.PI ? 0 : 1;
    return `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>`;
  };

  // توليد نطاقات الألوان
  const cx=90, cy=110, r=75;
  let bands = '';
  for(const b of cfg.bands){
    const a0 = start + (end-start)*((b.from-cfg.min)/span);
    const a1 = start + (end-start)*((b.to  -cfg.min)/span);
    bands += arc(cx,cy,r,a0,a1,b.color);
  }

  // الإبرة
  const [nx,ny] = polar(cx,cy,r-8,theta);
  const needle = `
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--needle)" stroke-width="4" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="var(--needle)"/>
  `;

  // المسار الخلفي
  const track = arc(cx,cy,r,start,end,'var(--track)');

  el.innerHTML = `
    <div class="gauge">
      <svg viewBox="0 0 180 120" role="img" aria-label="${cfg.label}">
        ${track}
        ${bands}
        ${needle}
        <!-- تدريجات خفيفة -->
        ${[0,25,50,75,100].map(p=>{
          const a = start + (end-start)*(p/100);
          const [x0,y0]=polar(cx,cy,r-2,a);
          const [x1,y1]=polar(cx,cy,r-12,a);
          return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#c5e1a5" stroke-width="2"/>`;
        }).join('')}
      </svg>
      <div class="label">
        <span class="value">${Number(v).toFixed(0)}${cfg.unit}</span>
        <span class="unit">${cfg.label}</span>
      </div>
    </div>
  `;
}

/* خرائط ألوان معيار مربيّك */
export const MBK_BANDS = {
  production: [
    {from:0, to:60, color:'var(--red)'},
    {from:60, to:80, color:'var(--yellow)'},
    {from:80, to:100, color:'var(--green)'},
  ],
  reproduction: [
    {from:0, to:40, color:'var(--red)'},
    {from:40, to:60, color:'var(--yellow)'},
    {from:60, to:100, color:'var(--green)'},
  ],
  health: [
    {from:0, to:70, color:'var(--red)'},
    {from:70, to:85, color:'var(--yellow)'},
    {from:85, to:100, color:'var(--green)'},
  ],
  thi: [
    {from:0, to:68, color:'var(--green)'},
    {from:68, to:78, color:'var(--yellow)'},
    {from:78, to:100, color:'var(--red)'},
  ]
};
