// /js/vision-core.js  (ESM)
import * as tf from "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";

const VISION = {
  model: null,
  refs: {}, // { group: [{id, img, emb, meta}], ... }
  useTF: false,
};

export async function loadModel() {
  try {
    if (!VISION.model) {
      // نموذج خفيف – MobileNetV2 (تعويض عبر tf.loadGraphModel أو tf.loadLayersModel)
      // سنستخدم نسخة community مضغوطة؛ إن فشل التحميل نعمل Fallback.
      // رابط عام شائع لموبيلاين (قد يتغير لاحقًا): جرّب ثم fallback
      VISION.model = await tf.loadGraphModel(
        "https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v2_1.0_224/model.json"
      );
      VISION.useTF = true;
    }
  } catch (e) {
    console.warn("TFJS model load failed, fallback to classic:", e);
    VISION.useTF = false;
  }
}

export function laplacianVariance(grayUint8, w, h) {
  // تقدير الحِدّة (بسيط وسريع)
  const k = [-1, -1, -1, -1, 8, -1, -1, -1, -1];
  let sum = 0, sumSq = 0, n = 0;
  for (let y=1; y<h-1; y++) {
    for (let x=1; x<w-1; x++) {
      let v = 0, idx=0;
      for (let j=-1; j<=1; j++) {
        for (let i=-1; i<=1; i++) {
          const p = grayUint8[(y+j)*w + (x+i)];
          v += p * k[idx++];
        }
      }
      sum += v; sumSq += v*v; n++;
    }
  }
  const mean = sum/n, varr = (sumSq/n) - mean*mean;
  return varr;
}

export function toCanvas(imgOrVideo, W=224, H=224) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(imgOrVideo, 0, 0, W, H);
  return c;
}

// Gray-World + HE-lite على قناة الإضاءة (Y)
export function normalizeCanvas(cnv) {
  const g = cnv.getContext('2d', { willReadFrequently: true });
  const { data, width, height } = g.getImageData(0,0,cnv.width,cnv.height);
  const img = new Uint8ClampedArray(data);

  // Gray-World
  let rSum=0,gSum=0,bSum=0, n = (img.length/4)|0;
  for (let i=0;i<img.length;i+=4){ rSum+=img[i]; gSum+=img[i+1]; bSum+=img[i+2]; }
  const rAvg=rSum/n, gAvg=gSum/n, bAvg=bSum/n;
  const k = (rAvg+gAvg+bAvg)/3 || 1;
  const kr = k/(rAvg||1), kg = k/(gAvg||1), kb = k/(bAvg||1);
  for (let i=0;i<img.length;i+=4){
    img[i]   = Math.min(255, img[i]*kr);
    img[i+1] = Math.min(255, img[i+1]*kg);
    img[i+2] = Math.min(255, img[i+2]*kb);
  }

  // HE-lite على Y = 0.2126R + 0.7152G + 0.0722B
  const Y = new Uint8Array(n);
  for (let i=0,j=0;i<img.length;i+=4,j++){
    Y[j] = (0.2126*img[i] + 0.7152*img[i+1] + 0.0722*img[i+2])|0;
  }
  // histogram + cdf
  const hist = new Uint32Array(256);
  for (let i=0;i<Y.length;i++) hist[Y[i]]++;
  const cdf = new Uint32Array(256);
  let acc=0; for (let i=0;i<256;i++){ acc += hist[i]; cdf[i]=acc; }
  const cdfMin = cdf.find(v=>v>0) || 1, total = Y.length;
  for (let i=0,j=0;i<img.length;i+=4,j++){
    const y = Y[j];
    const yEq = Math.round((cdf[y]-cdfMin)/(total-cdfMin)*255);
    const ratio = yEq/(y||1);
    img[i]   = Math.max(0, Math.min(255, img[i]*ratio));
    img[i+1] = Math.max(0, Math.min(255, img[i+1]*ratio));
    img[i+2] = Math.max(0, Math.min(255, img[i+2]*ratio));
  }

  const out = new ImageData(img, width, height);
  g.putImageData(out, 0, 0);
  return cnv;
}

function tensorFromCanvas(cnv){
  return tf.tidy(()=> tf.browser.fromPixels(cnv).toFloat().div(255).expandDims());
}

export async function embed(cnv){
  if (!VISION.useTF) return null;
  const x = tensorFromCanvas(cnv);
  const y = VISION.model.execute(x, 'module_apply_default/MobilenetV2/Logits/AvgPool');
  const emb = await y.data(); tf.dispose([x,y]);
  // normalize
  let norm=0; for (let i=0;i<emb.length;i++) norm+=emb[i]*emb[i];
  norm = Math.sqrt(norm)||1;
  return emb.map(v=>v/norm);
}

export function cosine(a,b){
  let s=0; for (let i=0;i<a.length;i++) s+=a[i]*b[i];
  return s; // بفرض التطبيع
}

// SSIM مبسّط على نسخة 64×64 Grayscale
export function ssim64(a,b){
  // a,b Float32Arrays بنفس الطول
  const N=a.length;
  const mean = v => { let s=0; for (let i=0;i<N;i++) s+=v[i]; return s/N; };
  const ma=mean(a), mb=mean(b);
  let va=0,vb=0, cab=0;
  for (let i=0;i<N;i++){ const da=a[i]-ma, db=b[i]-mb; va+=da*da; vb+=db*db; cab+=da*db; }
  va/=N; vb/=N; cab/=N;
  const c1=0.01**2, c2=0.03**2;
  return ((2*ma*mb + c1)*(2*cab + c2))/((ma*ma + mb*mb + c1)*(va + vb + c2));
}

export function toGray64(cnv){
  const g = cnv.getContext('2d', { willReadFrequently: true });
  const W=64, H=64;
  const r = document.createElement('canvas'); r.width=W; r.height=H;
  const gg = r.getContext('2d', { willReadFrequently: true });
  gg.drawImage(cnv,0,0,W,H);
  const { data } = gg.getImageData(0,0,W,H);
  const out = new Float32Array(W*H);
  for (let i=0,j=0;i<data.length;i+=4,j++){
    out[j] = (0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2])/255;
  }
  return out;
}

// تحميل مراجع مجموعة (مرة واحدة)
export async function preloadRefs(group, urlsOrImgs){
  const items = [];
  for (const it of urlsOrImgs){
    const img = await loadImage(it.url || it);
    let cnv = toCanvas(img, 224, 224);
    cnv = normalizeCanvas(cnv);
    let emb = null, gray64 = null;
    if (VISION.useTF) emb = await embed(cnv);
    gray64 = toGray64(cnv);
    items.push({ id: it.id || it, img, emb, gray64, meta: it.meta||{} });
  }
  VISION.refs[group] = items;
}

function loadImage(src){
  return new Promise((res, rej)=>{
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = ()=>res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// اختيار أفضل إطار من Burst
export function pickBestFrame(frames){ // frames: [{cnv, sharpness, tooDark}]
  const good = frames.filter(f=>!f.tooDark).sort((a,b)=>b.sharpness-a.sharpness);
  return (good[0]?.cnv) || frames.sort((a,b)=>b.sharpness-a.sharpness)[0].cnv;
}

// تقييم لقطة مقابل مراجع مجموعة
export function evaluateAgainst(group, cnv){
  const refs = VISION.refs[group] || [];
  if (!refs.length) return null;

  const norm = normalizeCanvas(cnv);
  const gray64 = toGray64(norm);

  let emb = null;
  if (VISION.useTF) emb = tf.tidy(()=>null), emb = null; // placeholder to ensure tf tidy
  // نحاول استخراج embedding إن كان الموديل جاهز
  // (نستدعي embed خارجًا لتفادي زمن إضافي هنا)
  return { refs, norm, gray64 };
}

export async function score(group, cnv){
  const refs = VISION.refs[group] || [];
  if (!refs.length) return null;

  const ncnv = normalizeCanvas(cnv);
  const g64 = toGray64(ncnv);
  const emb = VISION.useTF ? (await embed(ncnv)) : null;

  // نسجّل أعلى تشابه لكل مرجع + نَعمل Voting بالمجاميع (درجات feces: 1..5)
  const votes = {};
  for (const r of refs){
    let sim = 0;
    if (emb && r.emb) {
      const c = cosine(emb, r.emb);              // 0..1
      const s = ssim64(g64, r.gray64);           // 0..1
      sim = 0.7*c + 0.3*s;
    } else {
      const s = ssim64(g64, r.gray64);           // fallback
      sim = s;
    }
    const label = r.meta?.label ?? "ref";
    if (!votes[label]) votes[label] = [];
    votes[label].push(sim);
  }
  // تجميع: متوسط أعلى 2 لكل فئة
  const agg = Object.entries(votes).map(([label, arr])=>{
    arr.sort((a,b)=>b-a);
    const top = arr.slice(0,2);
    const mean = top.reduce((s,v)=>s+v,0)/top.length;
    return { label, score: mean };
  }).sort((a,b)=>b.score-a.score);

  return { winner: agg[0]?.label, details: agg };
}

// تخزين/قراءة EMA محليًا (تنعيم)
export function smoothEMA(key, value, alpha=0.4){
  try{
    const prev = Number(localStorage.getItem(key) || "NaN");
    const sm = isNaN(prev) ? value : (alpha*value + (1-alpha)*prev);
    localStorage.setItem(key, String(sm));
    return sm;
  }catch{ return value; }
}

export async function initVision(groupsAndRefs){
  await loadModel();
  for (const [group, refs] of Object.entries(groupsAndRefs)){
    await preloadRefs(group, refs);
  }
}
