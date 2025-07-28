const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const cors = require('cors');
app.use(cors());
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('www')); // تأكد أن مجلد www هو المستخدم

// === مسارات البيانات ===
const dataDir = path.join(__dirname, 'data');
const usersPath = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const eventsPath = path.join(dataDir, 'events.json');
const alertsPath = path.join(dataDir, 'alerts.json');

// === تسجيل مستخدم جديد ===
app.post('/api/users', (req, res) => {
  const { name, phone, password } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: "البيانات ناقصة" });
  }

  fs.readFile(usersPath, 'utf8', (err, data) => {
    let users = [];
    if (!err && data) {
      try { users = JSON.parse(data); } catch (e) {}
    }

    const existing = users.find(u => u.phone === phone);
    if (existing) {
      return res.status(409).json({ error: "رقم الهاتف مستخدم مسبقًا" });
    }

    const newUser = {
      id: users.length + 1,
      name,
      phone,
      password
    };

    users.push(newUser);

    fs.writeFile(usersPath, JSON.stringify(users, null, 2), err => {
      if (err) return res.status(500).send("فشل في حفظ المستخدم");
      res.json({ message: "تم إنشاء الحساب", user: newUser });
    });
  });
});

// === تسجيل الدخول ===
app.post('/api/users/login', (req, res) => {
  const { phone, password } = req.body;

  fs.readFile(usersPath, 'utf8', (err, data) => {
    if (err) return res.status(500).send("فشل في قراءة المستخدمين");

    let users = [];
    try { users = JSON.parse(data); } catch (e) {}

    const user = users.find(u => u.phone === phone && u.password === password);
    if (!user) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });

    res.json({ message: "تم تسجيل الدخول", user });
  });
});

// === تسجيل حيوان جديد ===
app.post('/api/animals', (req, res) => {
  const newAnimal = req.body;

  fs.readFile(animalsPath, 'utf8', (err, data) => {
    let animals = [];
    if (!err && data) {
      try { animals = JSON.parse(data); } catch (e) {}
    }

    newAnimal.id = animals.length + 1;
    animals.push(newAnimal);

    fs.writeFile(animalsPath, JSON.stringify(animals, null, 2), err => {
      if (err) return res.status(500).send('فشل في حفظ الحيوان');
      res.status(200).json({ message: 'تم تسجيل الحيوان بنجاح' });
    });
  });
});

// === استرجاع التنبيهات حسب user_id ===
app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id);

  fs.readFile(alertsPath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('فشل في قراءة التنبيهات');

    let alertsData = [];
    try { alertsData = JSON.parse(data); } catch (e) {}

    const userAlerts = alertsData.filter(alert => alert.user_id === userId);
    res.json({ alerts: userAlerts });
  });
});

// === تشغيل الخادم على IP المحلي لربطه بالموبايل ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running at http://192.168.1.5:${PORT}`);
});
