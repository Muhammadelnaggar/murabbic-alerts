
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// تعريف مجلد البيانات
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// المسارات الثابتة للملفات
const usersPath = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const alertsPath = path.join(dataDir, 'alerts.json');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'www')));

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

// === تسجيل حدث (ذكي) ===
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

  // تحديث ذكي لبيانات الحيوان إذا الحدث "ولادة"
  if (event.type === "ولادة") {
    if (fs.existsSync(animalsPath)) {
      let animals = JSON.parse(fs.readFileSync(animalsPath, 'utf8') || '[]');
      const index = animals.findIndex(a => a.number == event.animalId);

      if (index !== -1) {
        animals[index].lastCalvingDate = event.calvingDate;
        animals[index].reproductiveStatus = "حديث الولادة";
        animals[index].dailyMilkProduction = 0;
        delete animals[index].lastInseminationDate;

        fs.writeFileSync(animalsPath, JSON.stringify(animals, null, 2));
      }
    }
  }

  res.status(200).json({ message: '✅ تم تسجيل الحدث وتحديث بيانات الحيوان بنجاح', event });
});

// === باقي المسارات ===

// تسجيل التلقيح
app.post('/api/inseminations', (req, res) => {
  const newInsemination = req.body;
  const filePath = path.join(dataDir, 'inseminations.json');

  let list = [];
  if (fs.existsSync(filePath)) {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  list.push(newInsemination);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));

  res.status(200).json({ message: '✅ تم حفظ التلقيح بنجاح' });
});

// اللبن اليومي
app.post('/api/dailymilk', (req, res) => {
  const filePath = path.join(dataDir, 'dailymilk.json');
  const newRecord = req.body;

  let records = [];
  if (fs.existsSync(filePath)) {
    records = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  records.push(newRecord);

  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
  res.status(200).json({ message: '✅ تم حفظ اللبن اليومي بنجاح' });
});

// التحصينات
app.post('/api/vaccinations', (req, res) => {
  const filePath = path.join(dataDir, 'vaccinations.json');
  const vaccination = req.body;

  let list = [];
  if (fs.existsSync(filePath)) {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  list.push(vaccination);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));

  res.status(200).json({ message: '✅ تم حفظ التحصين بنجاح' });
});

// التهاب الضرع
app.post('/api/mastitis', (req, res) => {
  const filePath = path.join(dataDir, 'mastitis.json');
  const newEntry = req.body;

  let list = [];
  if (fs.existsSync(filePath)) {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  list.push(newEntry);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));

  res.status(200).send('✅ تم حفظ التهاب الضرع بنجاح');
});

// العرج
app.post('/api/lameness', (req, res) => {
  const filePath = path.join(dataDir, 'lameness.json');
  const newEntry = req.body;

  let list = [];
  if (fs.existsSync(filePath)) {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  list.push(newEntry);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));

  res.status(200).send('✅ تم حفظ حالة العرج بنجاح');
});

// التحضير للولادة
app.post('/api/closeups', (req, res) => {
  const filePath = path.join(dataDir, 'closeups.json');
  const newRecord = req.body;

  let list = [];
  if (fs.existsSync(filePath)) {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  list.push(newRecord);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));

  res.status(200).json({ message: '✅ تم حفظ التحضير بنجاح' });
});

// التجفيف
app.post('/api/dryoffs', (req, res) => {
  const filePath = path.join(dataDir, 'dryoffs.json');
  const newData = req.body;

  let list = [];
  if (fs.existsSync(filePath)) {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  list.push(newData);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));

  res.status(200).json({ message: '✅ تم حفظ التجفيف بنجاح' });
});

// تشخيص الحمل
app.post('/api/pregnancy-diagnosis', (req, res) => {
  const filePath = path.join(dataDir, 'pregnancy-diagnosis.json');
  const newEntry = req.body;

  let list = [];
  if (fs.existsSync(filePath)) {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  }

  list.push(newEntry);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));

  res.json({ success: true });
});

// قراءة كل الحيوانات
app.get('/api/animals', (req, res) => {
  if (!fs.existsSync(animalsPath)) {
    return res.json([]);
  }
  const data = fs.readFileSync(animalsPath, 'utf8') || '[]';
  res.json(JSON.parse(data));
});

// قراءة تنبيهات مستخدم معين
app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id);
  let alerts = [];

  if (fs.existsSync(alertsPath)) {
    alerts = JSON.parse(fs.readFileSync(alertsPath, 'utf8') || '[]');
  }

  const userAlerts = alerts.filter(a => a.user_id === userId);
  res.json({ alerts: userAlerts });
});

// قراءة animal.json القديم
app.get("/data/animal.json", (req, res) => {
  res.sendFile(path.join(dataDir, "animal.json"));
});

// توجيه افتراضي لواجهة التطبيق
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// تشغيل السيرفر
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Murabbik Server running on http://localhost:${PORT}`);
});
