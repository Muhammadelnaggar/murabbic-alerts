const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const eventsPath = path.join(__dirname, 'data', 'events.json');
const animalsPath = path.join(__dirname, 'data', 'animals.json');

// 🐮 تسجيل حيوان جديد
app.post('/api/animals', (req, res) => {
  const newAnimal = req.body;

  fs.readFile(animalsPath, 'utf8', (err, data) => {
    let animals = [];
    if (!err && data) {
      try {
        animals = JSON.parse(data);
      } catch (e) {
        animals = [];
      }
    }

    newAnimal.id = animals.length + 1;
    animals.push(newAnimal);

    fs.writeFile(animalsPath, JSON.stringify(animals, null, 2), (err) => {
      if (err) return res.status(500).send('فشل في حفظ الحيوان');
      res.status(200).json({ message: 'تم تسجيل الحيوان بنجاح' });
    });
  });
});

// 🍼 ولادة
app.post('/events', (req, res) => {
  const { animalId, birthDate, birthEase, calfGender, calfId, calfFate } = req.body;
  registerEvent({ type: "ولادة", animalId, birthDate, birthEase, calfGender, calfId, calfFate }, res);
});

// 💉 تلقيح
app.post('/events/insemination', (req, res) => {
  const { animalId, inseminationDate, inseminationType, bullName, inseminatorName } = req.body;
  registerEvent({ type: "تلقيح", animalId, inseminationDate, inseminationType, bullName, inseminatorName }, res);
});

// 🧪 تحضير للولادة
app.post('/events/calving-prep', (req, res) => {
  const { animalId, expectedDate, preparationsDone, date } = req.body;
  registerEvent({ type: "تحضير للولادة", animalId, expectedDate, preparationsDone, date }, res);
});

// 🛡️ تحصين
app.post('/events/vaccine', (req, res) => {
  const { animalId, vaccineDate, vaccineType, vaccineName, veterinarian, notes } = req.body;
  registerEvent({ type: "تحصين", animalId, vaccineDate, vaccineType, vaccineName, veterinarian, notes }, res);
});

// 🥛 إنتاج اللبن
app.post('/events/milk', (req, res) => {
  const { animalId, date, morning, noon, evening, total } = req.body;
  registerEvent({ type: "إنتاج اللبن اليومي", animalId, date, morning, noon, evening, total }, res);
});

// 🧼 تجفيف
app.post('/events/dry', (req, res) => {
  const { animalId, date, pregnancyConfirmed, udderTreatment } = req.body;
  if (pregnancyConfirmed !== "عشار") return res.status(400).json({ error: "لا يمكن تجفيف حيوان غير عشار" });
  registerEvent({ type: "تجفيف", animalId, date, pregnancyConfirmed, udderTreatment }, res);
});

// 🧫 مرض
app.post('/events/disease', (req, res) => {
  const { animalId, diseaseDate, diseaseName, notes } = req.body;
  registerEvent({ type: "مرض", animalId, diseaseDate, diseaseName, notes }, res);
});

// ✨ دالة عامة لتسجيل أي حدث
function registerEvent(eventData, res) {
  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      try { events = JSON.parse(data); } catch (e) { events = []; }
    }

    const newEvent = {
      id: events.length + 1,
      ...eventData,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ الحدث:', err);
        return res.status(500).json({ error: 'خطأ في الحفظ' });
      }

      console.log(`✅ تم تسجيل الحدث: ${eventData.type}`, newEvent);
      res.status(200).json({ success: true });
    });
  });
}
// ✅ إرجاع قائمة الحيوانات
app.get('/api/animals', (req, res) => {
  fs.readFile(animalsPath, 'utf8', (err, data) => {
    if (err) {
      console.error('❌ فشل في قراءة animal.json:', err);
      return res.status(500).json({ error: 'خطأ في قراءة بيانات الحيوانات' });
    }

    try {
      const animals = JSON.parse(data || '[]');
      res.status(200).json(animals);
    } catch (e) {
      console.error('❌ JSON غير صالح:', e);
      res.status(500).json({ error: 'بيانات غير صالحة' });
    }
  });
});
// 📢 استرجاع التنبيهات حسب رقم المستخدم
const alertsPath = path.join(__dirname, 'data', 'alerts.json');

app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id);
  
  fs.readFile(alertsPath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('فشل في قراءة التنبيهات');

    let alertsData = JSON.parse(data);
    const userAlerts = alertsData.find(user => user.id === userId);

    if (!userAlerts) {
      return res.status(404).json({ alerts: [] });
    }

    res.json(userAlerts);
  });
});

const PORT = process.env.PORT || 3000;
const usersPath = path.join(__dirname, 'data', 'users.json');

// ✅ إنشاء حساب جديد
app.post('/api/users', (req, res) => {
  const { name, phone, password } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: "البيانات ناقصة" });
  }

  fs.readFile(usersPath, 'utf8', (err, data) => {
    let users = [];
    if (!err && data) {
      try { users = JSON.parse(data); } catch (e) { users = []; }
    }

    const newUser = {
      id: users.length + 1,
      name,
      phone,
      password  // ملاحظة: مستقبلاً يُفضل تشفير الباسورد
    };

    users.push(newUser);

    fs.writeFile(usersPath, JSON.stringify(users, null, 2), (err) => {
      if (err) return res.status(500).send("فشل في حفظ المستخدم");
      res.json({ message: "تم إنشاء الحساب", user: newUser });
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ السيرفر يعمل على http://localhost:${PORT}`);
});
