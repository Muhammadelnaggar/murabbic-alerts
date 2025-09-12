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
  window.vision = { startCameraHD, captureHD };
})();
