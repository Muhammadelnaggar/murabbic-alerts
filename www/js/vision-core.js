// /js/vision-core.js
(function () {
  async function blobToDataURL(blob){
    return await new Promise(res=>{
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(blob);
    });
  }

  async function enableQuality(track){
    try{
      const caps = track.getCapabilities?.() || {};
      const adv = [];
      if (caps.focusMode?.includes('continuous')) adv.push({ focusMode: 'continuous' });
      if (caps.whiteBalanceMode?.includes('continuous')) adv.push({ whiteBalanceMode: 'continuous' });
      if (caps.exposureMode?.includes('continuous')) adv.push({ exposureMode: 'continuous' });
      if (adv.length) await track.applyConstraints({ advanced: adv });
    }catch{}
  }

  async function startCameraHD({ state, preview, overlay, drawGuide, populateTorchSupport, deviceId }){
    if (state.stream) state.stream.getTracks().forEach(t=>t.stop());

    const want43  = [{ width:2560, height:1920 }, { width:1920, height:1440 }, { width:1280, height:960 }];
    const want169 = [{ width:2560, height:1440 }, { width:1920, height:1080 }, { width:1280, height:720 }];

    const constraints = {
      video: {
        facingMode: deviceId ? undefined : { ideal: 'environment' },
        deviceId: deviceId ? { exact: deviceId } : undefined,
        frameRate: { ideal: 30, max: 60 },
        width:  { ideal: 1920 },
        height: { ideal: 1440 },
        advanced: [
          ...want43, ...want169,
          { aspectRatio: 4/3 },
          { aspectRatio: 16/9 }
        ]
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    const [track] = stream.getVideoTracks();
    state.track = track;
    state.capabilities = track.getCapabilities?.() || null;

    await enableQuality(track);

    preview.srcObject = stream;
    await preview.play();

    // معايرة الكانفس/الـ overlay حسب الصفحة
    try { drawGuide && drawGuide(); } catch {}
    try { populateTorchSupport && populateTorchSupport(); } catch {}

    return stream;
  }

  async function captureHD({ state, preview }){
    if ('ImageCapture' in window && state?.track) {
      try {
        const ic = state.imageCapture || new ImageCapture(state.track);
        state.imageCapture = ic;
        try {
          const caps = await ic.getPhotoCapabilities();
          const w = caps?.imageWidth?.max || 0, h = caps?.imageHeight?.max || 0;
          const blob = await ic.takePhoto(w && h ? { imageWidth: w, imageHeight: h } : {});
          return await blobToDataURL(blob);
        } catch {
          const blob = await ic.takePhoto();
          return await blobToDataURL(blob);
        }
      } catch {}
    }

    // fallback من الفيديو (لو ImageCapture غير مدعوم)
    const c = document.createElement('canvas');
    const w = preview.videoWidth || preview.clientWidth;
    const h = preview.videoHeight || preview.clientHeight;
    if (!w || !h) return null;
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(preview, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.92);
  }

  // تصدير على النافذة لاستخدام سهل في كل الصفحات
   function dataURLToImage(dataURL){
    return new Promise((resolve, reject)=>{
      const img = new Image();
      img.onload = ()=> resolve(img);
      img.onerror = reject;
      img.src = dataURL;
    });
  }
  function detectCharucoScale(imgData){

  const cv = window.cv;

  const src = cv.matFromImageData(imgData);
  const gray = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const dictionary =
    cv.aruco.getPredefinedDictionary(cv.aruco.DICT_4X4_50);

  const board =
    new cv.aruco_CharucoBoard(
      5,      // squares X
      7,      // squares Y
      0.025,  // square size meters
      0.018,  // marker size meters
      dictionary
    );

  const corners = new cv.MatVector();
  const ids = new cv.Mat();

  cv.aruco.detectMarkers(gray, dictionary, corners, ids);

  if(ids.rows < 1){
    src.delete(); gray.delete();
    return null;
  }

  const charucoCorners = new cv.Mat();
  const charucoIds = new cv.Mat();

  cv.aruco.interpolateCornersCharuco(
    corners,
    ids,
    gray,
    board,
    charucoCorners,
    charucoIds
  );

  if(charucoIds.rows < 4){
    src.delete(); gray.delete();
    return null;
  }

  const p1 = charucoCorners.data32F;
  const dx = p1[2] - p1[0];
  const dy = p1[3] - p1[1];

  const px = Math.sqrt(dx*dx + dy*dy);

  const cm = 2.5; // square size

  const scale = px / cm;

  src.delete(); gray.delete();

  return scale;
}
  function drawFrameToCanvas(preview){
    const c = document.createElement('canvas');
    const w = preview.videoWidth || preview.clientWidth;
    const h = preview.videoHeight || preview.clientHeight;
    if (!w || !h) return null;
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently:true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(preview, 0, 0, w, h);
    return c;
  }

  function computeSharpnessFromCanvas(c){
    try{
      const g = c.getContext('2d', { willReadFrequently:true });
      const { data, width, height } = g.getImageData(0,0,c.width,c.height);
      let sum = 0, sumSq = 0, n = 0;

      const gray = new Uint8Array(width * height);
      for(let i=0, p=0; i<data.length; i+=4, p++){
        gray[p] = (0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]) | 0;
      }

      for(let y=1; y<height-1; y++){
        for(let x=1; x<width-1; x++){
          const p = y*width + x;
          const lap =
            gray[p-width] + gray[p-1] + gray[p+1] + gray[p+width] - 4*gray[p];
          sum += lap;
          sumSq += lap * lap;
          n++;
        }
      }
      if(!n) return 0;
      const mean = sum / n;
      return Math.max(0, (sumSq / n) - (mean * mean));
    }catch{
      return 0;
    }
  }

  function computeBrightnessFromCanvas(c){
    try{
      const g = c.getContext('2d', { willReadFrequently:true });
      const { data } = g.getImageData(0,0,c.width,c.height);
      let s = 0, n = 0;
      for(let i=0; i<data.length; i+=4){
        s += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
        n++;
      }
      return n ? (s / n) : 0;
    }catch{
      return 0;
    }
  }

  async function captureBurst({ preview, count = 5, delayMs = 120 }){
    const frames = [];
    for(let i=0; i<count; i++){
      const c = drawFrameToCanvas(preview);
      if(c){
        frames.push({
          canvas: c,
          sharpness: computeSharpnessFromCanvas(c),
          brightness: computeBrightnessFromCanvas(c),
          dataURL: c.toDataURL('image/jpeg', 0.92)
        });
      }
      if(i < count - 1){
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return frames;
  }

  function pickBestFrame(frames = []){
    if(!Array.isArray(frames) || !frames.length) return null;

    const scored = frames.map(f=>{
      const sharp = Number(f.sharpness || 0);
      const bright = Number(f.brightness || 0);

      let brightnessPenalty = 0;
      if (bright < 60) brightnessPenalty = 25;
      else if (bright < 85) brightnessPenalty = 10;
      else if (bright > 210) brightnessPenalty = 15;

      const score = sharp - brightnessPenalty * 100;
      return { ...f, score };
    });

    scored.sort((a,b)=> b.score - a.score);
    return scored[0] || null;
  }

  window.vision = {
    startCameraHD,
    captureHD,
    captureBurst,
    pickBestFrame,
    computeSharpnessFromCanvas,
    computeBrightnessFromCanvas,
    dataURLToImage
  };
})();
