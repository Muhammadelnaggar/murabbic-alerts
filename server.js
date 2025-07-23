const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const alertsPath = path.join(__dirname, 'data', 'alerts.json');
const eventsPath = path.join(__dirname, 'data', 'events.json');

// ✅ استقبال حدث جديد وحفظه
app.post('/events', (req, res) => {
  const newEvent = req.body;

  fs.readFile(eventsPath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'فشل في قراءة ملف الأحداث' });

    let events = [];
    try {
      events = JSON.parse(data);
    } catch (e) {
      return res.status(500).json({ error: 'فشل في تحويل البيانات من JSON' });
    }

    newEvent.id = events.length + 1;
    newEvent.timestamp = new Date().toISOString();
    events.push(newEvent);

    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), err => {
      if (err) return res.status(500).json({ error: 'فشل في حفظ الحدث' });
      res.json({ status: 'ok', message: 'تم حفظ الحدث بنجاح' });
    });
  });
});

// ✅ جلب التنبيهات حسب المستخدم
app.get('/alerts/:user_id', (req, res) => {
  const userId = parseInt(req.params.user_id);
  fs.readFile(alertsPath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'فشل تحميل التنبيهات' });

    const alerts = JSON.parse(data);
    const userAlerts = alerts.filter(alert => alert.user_id === userId);
    res.json({ alerts: userAlerts });
  });
});

// ✅ استقبال رد فعل المستخدم على تنبيه
app.post('/alerts/resolve', (req, res) => {
  const { id, action } = req.body;
  console.log(`🔔 تنبيه ${id} تم اتخاذ إجراء: ${action}`);
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ السيرفر شغّال – http://localhost:${PORT}`);
});

