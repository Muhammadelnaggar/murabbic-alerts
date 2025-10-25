<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>تسجيل إجهاض — مُرَبِّك</title>
  <link rel="stylesheet" href="css/forms.css" />
  <script src="/js/forms-init.js"></script>
  <style>
    :root {
      --green: #0ea05a;
      --green-600: #0b7f47;
      --bg: #f7faf7;
      --text: #0f172a;
      --muted: #64748b;
      --card: #ffffff;
      --danger: #c2410c;
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:'Cairo',system-ui,Segoe UI,Tahoma,Arial;background:var(--bg);color:var(--text)}
    header{position:sticky;top:0;background:var(--card);border-bottom:1px solid #e2e8f0;padding:12px 16px;text-align:center;font-weight:bold;color:var(--green-600)}
    form{padding:16px}
    label{display:block;margin:8px 0 4px;font-weight:bold}
    input,textarea,select{width:100%;padding:8px;border:1px solid #ccc;border-radius:6px}
    button{width:100%;padding:12px;margin-top:20px;background:var(--green);color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:bold}
    .infobar{margin:10px 0;padding:8px;border-radius:8px;font-size:14px}
    .infobar.ok{background:#dcfce7;color:#065f46}
    .infobar.err{background:#fee2e2;color:#991b1b}
  </style>
</head>
<body>
  <header>تسجيل إجهاض</header>
  <form id="abortionForm">
    <div id="infobar" class="infobar"></div>

    <label>رقم الحيوان</label>
    <input id="animalNumber" data-field="animalNumber" readonly />

    <label>تاريخ الحدث</label>
    <input id="eventDate" data-field="eventDate" type="date" readonly />

    <label>عمر الحمل (بالأشهر)</label>
    <input id="abortionAge" data-field="abortionAgeMonths" readonly />

    <label>التشخيص المحتمل</label>
    <input id="probableCause" data-field="probableCause" readonly />

    <label>ملاحظات</label>
    <textarea id="notes" data-field="notes" rows="3"></textarea>

    <button type="submit">حفظ الإجهاض</button>
  </form>

  <script>
  (async () => {
    // تحميل Firebase و Firestore
    const { db, auth, app } = await import('/js/firebase-config.js');
    const { collection, addDoc, getDocs, query, where, orderBy, limit, serverTimestamp } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

    // عناصر النموذج
    const form = document.getElementById('abortionForm');
    const info = document.getElementById('infobar');
    const animalInput = document.getElementById('animalNumber');
    const dateInput = document.getElementById('eventDate');
    const ageInput = document.getElementById('abortionAge');
    const causeInput = document.getElementById('probableCause');
    const notesInput = document.getElementById('notes');
    const btn = form.querySelector('button');

    // تمرير الرقم والتاريخ من add-event.html أو localStorage
    const url = new URL(window.location.href);
    const num = url.searchParams.get('number') || localStorage.getItem('lastAnimalNumber');
    const dt = url.searchParams.get('date') || localStorage.getItem('lastEventDate') || new Date().toISOString().slice(0,10);

    animalInput.value = num || '';
    dateInput.value = dt || '';

    if (!num) {
      info.className = 'infobar err';
      info.textContent = '⚠️ لم يتم تمرير رقم الحيوان.';
      btn.disabled = true;
      return;
    }

    // 🔹 التحقق الذكي فورًا
    async function runGuard(){
      try {
        const qInsem = query(
          collection(db, "events"),
          where("animalNumber", "==", num),
          where("eventType", "in", ["تلقيح","تلقيح مُخصِّب","insemination"]),
          orderBy("eventDate","desc"),
          limit(1)
        );
        const snap = await getDocs(qInsem);
        if (snap.empty){
          info.className = 'infobar err';
          info.textContent = '⚠️ لا يوجد تلقيح سابق مسجّل.';
          btn.disabled = true;
          return;
        }
        const last = snap.docs[0].data();
        const d1 = new Date(last.eventDate);
        const d2 = new Date(dt);
        const months = (d2 - d1) / (1000*60*60*24*30.44);
        const cause = months >= 6 ? "احتمال بروسيلا (≥6 شهور)" : "احتمال BVD (<6 شهور)";
        ageInput.value = months.toFixed(1);
        causeInput.value = cause;
        info.className = 'infobar ok';
        info.textContent = `✅ تم التحقق: عمر الحمل ${months.toFixed(1)} شهر، ${cause}`;
        btn.disabled = false;
      } catch(err){
        console.error(err);
        info.className = 'infobar err';
        info.textContent = '⚠️ خطأ في التحقق من البيانات.';
        btn.disabled = true;
      }
    }
    await runGuard();

    // 🔹 حفظ الحدث
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      btn.disabled = true;
      try{
        await addDoc(collection(db,"events"),{
          animalNumber: num,
          eventType: "إجهاض",
          eventDate: dt,
          abortionAgeMonths: parseFloat(ageInput.value)||null,
          probableCause: causeInput.value||"",
          notes: notesInput.value||"",
          userId: auth.currentUser?.uid || null,
          createdAt: serverTimestamp()
        });
        info.className='infobar ok';
        info.textContent='✅ تم حفظ حدث الإجهاض بنجاح.';
        localStorage.setItem('lastAnimalNumber',num);
        localStorage.setItem('lastEventDate',dt);
      }catch(err){
        console.error(err);
        info.className='infobar err';
        info.textContent='❌ حدث خطأ أثناء الحفظ.';
      }
      btn.disabled = false;
    });
  })();
  </script>
</body>
</html>
