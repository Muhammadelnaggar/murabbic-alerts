const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

const eventsPath = path.join(__dirname, 'data', 'events.json');
// ✅ تسجيل حدث تلقيح
app.post('/events/insemination', (req, res) => {
  const {
    animalId,
    inseminationDate,
    inseminationType,
    bullName,
    inseminatorName
  } = req.body;

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      try {
        events = JSON.parse(data);
      } catch (e) {
        console.error('❌ خطأ في قراءة ملف الأحداث:', e);
      }
    }

    const newEvent = {
      id: events.length + 1,
      type: "تلقيح",
      animalId,
      inseminationDate,
      inseminationType,
      bullName,
      inseminatorName,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ التلقيح:', err);
        return res.status(500).json({ error: 'خطأ في الحفظ' });
      }

      console.log('✅ تم تسجيل التلقيح:', newEvent);
      res.status(200).json({ success: true });
    });
  });
});
// 📆 تحضير للولادة
app.post('/events/calving-prep', (req, res) => {
  const {
    animalId,
    expectedDate,
    preparationsDone,
    date
  } = req.body;

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      events = JSON.parse(data);
    }

    const newEvent = {
      id: events.length + 1,
      type: "تحضير للولادة",
      animalId,
      expectedDate,
      preparationsDone,
      date,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ حدث التحضير للولادة:', err);
        return res.status(500).send('خطأ في الحفظ');
      }

      console.log('✅ تم تسجيل حدث التحضير للولادة:', newEvent);
      res.status(200).json({ status: 'ok' });
    });
  });
});

// ✅ تسجيل حدث تحصين
app.post('/events/vaccine', (req, res) => {
  const {
    animalId,
    vaccineDate,
    vaccineType,
    vaccineName,
    veterinarian,
    notes
  } = req.body;

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      events = JSON.parse(data);
    }

    const newEvent = {
      id: events.length + 1,
      type: "تحصين",
      animalId,
      vaccineDate,
      vaccineType,
      vaccineName,
      veterinarian,
      notes,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error("❌ فشل في حفظ التحصين:", err);
        return res.status(500).send("فشل في حفظ التحصين");
      }

      console.log("✅ تم تسجيل التحصين:", newEvent);
      res.status(200).send("OK");
    });
  });
});
// 🥛 تسجيل إنتاج اللبن اليومي
app.post('/events/milk', (req, res) => {
  const {
    animalId,
    date,
    morning,
    noon,
    evening,
    total
  } = req.body;

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      events = JSON.parse(data);
    }

    const newEvent = {
      id: events.length + 1,
      type: "إنتاج اللبن اليومي",
      animalId,
      date,
      morning,
      noon,
      evening,
      total,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ إنتاج اللبن:', err);
        return res.status(500).send('خطأ في الحفظ');
      }

      console.log('✅ تم تسجيل إنتاج اللبن:', newEvent);
      res.status(200).json({ status: 'ok' });
    });
  });
});
// 🐄 تسجيل حدث تجفيف
app.post('/events/dry', (req, res) => {
  const {
    animalId,
    date,
    pregnancyConfirmed,
    udderTreatment
  } = req.body;

  if (pregnancyConfirmed !== "عشار") {
    return res.status(400).json({ error: "لا يمكن تجفيف حيوان غير عشار" });
  }

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      events = JSON.parse(data);
    }

    const newEvent = {
      id: events.length + 1,
      type: "تجفيف",
      animalId,
      date,
      pregnancyConfirmed,
      udderTreatment,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ حدث التجفيف:', err);
        return res.status(500).send('خطأ في الحفظ');
      }

      console.log('✅ تم تسجيل حدث التجفيف:', newEvent);
      res.status(200).json({ status: 'ok' });
    });
  });
});

// ✅ تسجيل حدث ولادة
app.post('/events', (req, res) => {
  const {
    animalId,
    birthDate,
    birthEase,
    calfGender,
    calfId,
    calfFate
  } = req.body;

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      try {
        events = JSON.parse(data);
      } catch (e) {
        console.error('❌ خطأ في قراءة ملف الأحداث:', e);
      }
    }

    const newEvent = {
      id: events.length + 1,
      type: "ولادة",
      animalId,
      birthDate,
      birthEase,
      calfGender,
      calfId,
      calfFate,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ الحدث:', err);
        return res.status(500).json({ error: 'خطأ في الحفظ' });
      }

      console.log('✅ تم تسجيل حدث الولادة:', newEvent);
      res.status(200).json({ success: true });
    });
  });
});
// ✅ استقبال بيانات مرض
app.post('/events/disease', (req, res) => {
  const { animalId, diseaseDate, diseaseName, notes } = req.body;

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      events = JSON.parse(data);
    }

    const newDisease = {
      id: events.length + 1,
      type: "مرض",
      animalId,
      diseaseDate,
      diseaseName,
      notes,
      timestamp: new Date().toISOString()
    };

    events.push(newDisease);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ المرض:', err);
        return res.status(500).send('فشل في الحفظ');
      }

      console.log('✅ تم تسجيل المرض:', newDisease);
      res.status(200).json({ status: 'ok' });
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ السيرفر يعمل على http://localhost:${PORT}`);
});
