
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'www')));



// إنشاء مجلد data إذا لم يكن موجودًا
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// نقطة النهاية لتسجيل التحصينات
app.post("/api/vaccinations", (req, res) => {
  const vaccination = req.body;
  const filePath = path.join(dataDir, "vaccinations.json");

  // تحميل الملف أو تهيئة مصفوفة جديدة
  let vaccinations = [];
  if (fs.existsSync(filePath)) {
    vaccinations = JSON.parse(fs.readFileSync(filePath));
  }

  // حفظ التحصين الجديد
  vaccinations.push(vaccination);
  fs.writeFileSync(filePath, JSON.stringify(vaccinations, null, 2));

  res.status(200).json({ message: "✅ تم حفظ التحصين بنجاح" });
});

// تسجيل الحالات الصحية
app.post('/api/diseases', (req, res) => {
  const filePath = path.join(dataDir, 'diseases.json');
  const newRecord = req.body;

  fs.readFile(filePath, 'utf8', (err, data) => {
    let records = [];
    if (!err && data) {
      records = JSON.parse(data);
    }
    records.push(newRecord);

    fs.writeFile(filePath, JSON.stringify(records, null, 2), err => {
      if (err) {
        res.status(500).json({ message: 'فشل في حفظ البيانات' });
      } else {
        res.status(200).json({ message: 'تم حفظ الحالة الصحية بنجاح' });
      }
    });
  });
});

// POST route to save insemination event
app.post('/api/inseminations', (req, res) => {
  const newInsemination = req.body;
  const filePath = path.join(__dirname, 'data', 'inseminations.json');

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('خطأ في قراءة ملف التلقيحات:', err);
      return res.status(500).json({ error: 'فشل في قراءة البيانات' });
    }

    let inseminations = [];
    try {
      inseminations = JSON.parse(data);
    } catch (parseErr) {
      console.error('خطأ في تحويل البيانات:', parseErr);
    }

    inseminations.push(newInsemination);

    fs.writeFile(filePath, JSON.stringify(inseminations, null, 2), (err) => {
      if (err) {
        console.error('خطأ في حفظ بيانات التلقيح:', err);
        return res.status(500).json({ error: 'فشل في حفظ التلقيح' });
      }

      res.status(200).json({ message: 'تم حفظ التلقيح بنجاح' });
    });
  });
});

// هذا الجزء يجيب كل الحيوانات المسجلة
app.get('/api/animals', (req, res) => {
  const filePath = path.join(__dirname, 'data', 'animals.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('❌ فشل في قراءة ملف الحيوانات:', err);
      return res.status(500).json({ error: 'فشل في قراءة البيانات' });
    }

    try {
      const animals = JSON.parse(data);
      res.json(animals);
    } catch (parseError) {
      console.error('❌ خطأ في تحليل ملف JSON:', parseError);
      res.status(500).json({ error: 'خطأ في البيانات' });
    }
  });
});

// === مسارات ملفات البيانات ===

const usersPath = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const alertsPath = path.join(dataDir, 'alerts.json');

// === تسجيل مستخدم جديد ===
app.post('/api/users', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'البيانات ناقصة' });
  }

  let users = [];
  if (fs.existsSync(usersPath)) {
    users = JSON.parse(fs.readFileSync(usersPath, 'utf8') || '[]');
  }

  if (users.find(u => u.phone === phone)) {
    return res.status(409).json({ error: 'رقم الهاتف مستخدم مسبقًا' });
  }

  const newUser = { id: users.length + 1, name, phone, password };
  users.push(newUser);

  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
  res.json({ message: 'تم إنشاء الحساب بنجاح', user: newUser });
});

// === تسجيل الدخول ===
app.post('/api/users/login', (req, res) => {
  const { phone, password } = req.body;
  if (!fs.existsSync(usersPath)) return res.status(500).send("ملف المستخدمين غير موجود");

  const users = JSON.parse(fs.readFileSync(usersPath, 'utf8') || '[]');
  const user = users.find(u => u.phone === phone && u.password === password);

  if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  res.json({ message: 'تم تسجيل الدخول', user });
});

// === تسجيل حيوان جديد ===
app.post('/api/animals', (req, res) => {
  const newAnimal = req.body;
  let animals = [];

  if (fs.existsSync(animalsPath)) {
    animals = JSON.parse(fs.readFileSync(animalsPath, 'utf8') || '[]');
  }

  newAnimal.id = animals.length + 1;
  animals.push(newAnimal);

  fs.writeFileSync(animalsPath, JSON.stringify(animals, null, 2));
  res.status(200).json({ message: 'تم تسجيل الحيوان بنجاح' });
});
// === تسجيل حدث (مثل الولادة) ===
app.post('/api/events', (req, res) => {
  const event = req.body;

  if (!event || !event.type || !event.animalId) {
    return res.status(400).json({ error: 'بيانات الحدث ناقصة' });
  }

  const eventsPath = path.join(dataDir, 'events.json');
  let events = [];

  if (fs.existsSync(eventsPath)) {
    events = JSON.parse(fs.readFileSync(eventsPath, 'utf8') || '[]');
  }

  event.id = events.length + 1;
  events.push(event);

  fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  res.status(200).json({ message: '✅ تم تسجيل الحدث بنجاح', event });
});

// === استرجاع تنبيهات المستخدم ===
app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id);
  let alerts = [];

  if (fs.existsSync(alertsPath)) {
    alerts = JSON.parse(fs.readFileSync(alertsPath, 'utf8') || '[]');
  }

  const userAlerts = alerts.filter(a => a.user_id === userId);
  res.json({ alerts: userAlerts });
});

// === توجيه افتراضي لملف index.html عند زيارة /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// === تشغيل السيرفر ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
