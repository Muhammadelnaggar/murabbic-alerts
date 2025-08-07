// ✅ النسخة النهائية الصحيحة 100% من serve.js

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, "data");
const usersPath = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const alertsPath = path.join(dataDir, 'alerts.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'www')));

// تسجيل مستخدم جديد
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

// تسجيل الدخول
app.post('/api/users/login', (req, res) => {
  const { phone, password } = req.body;
  if (!fs.existsSync(usersPath)) return res.status(500).send("ملف المستخدمين غير موجود");

  const users = JSON.parse(fs.readFileSync(usersPath, 'utf8') || '[]');
  const user = users.find(u => u.phone === phone && u.password === password);

  if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  res.json({ message: 'تم تسجيل الدخول', user });
});

// تسجيل حيوان جديد
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

// تسجيل حدث عام ذكي
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

  if (event.type === "ولادة") {
    if (fs.existsSync(animalsPath)) {
      let animals = JSON.parse(fs.readFileSync(animalsPath, 'utf8') || '[]');
      const index = animals.findIndex(a => a.number == event.animalId);

      if (index !== -1) {
        animals[index].lastCalvingDate = event.calvingDate;
        animals[index].reproductiveStatus = "حديث الولادة";
        animals[index].dailyMilkProduction = 0;
        if (animals[index].lastInseminationDate) {
          delete animals[index].lastInseminationDate;
        }
        fs.writeFileSync(animalsPath, JSON.stringify(animals, null, 2));
      }
    }
  }

  res.status(200).json({ message: '✅ تم تسجيل الحدث وتحديث بيانات الحيوان بنجاح', event });
});

// باقي المسارات كما هي بدون تغيير
app.get('/api/animals', (req, res) => {
  fs.readFile(animalsPath, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'فشل في قراءة البيانات' });
    }
    try {
      const animals = JSON.parse(data);
      res.json(animals);
    } catch (e) {
      res.status(500).json({ error: 'خطأ في البيانات' });
    }
  });
});

app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id);
  let alerts = [];

  if (fs.existsSync(alertsPath)) {
    alerts = JSON.parse(fs.readFileSync(alertsPath, 'utf8') || '[]');
  }

  const userAlerts = alerts.filter(a => a.user_id === userId);
  res.json({ alerts: userAlerts });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

app.get("/data/animal.json", (req, res) => {
  res.sendFile(path.join(dataDir, "animal.json"));
});

// تشغيل السيرفر
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
