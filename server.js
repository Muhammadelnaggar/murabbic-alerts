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
