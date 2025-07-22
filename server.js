const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public')); // ملفات HTML و CSS

const alertsPath = path.join(__dirname, 'data', 'alerts.json');

// ✅ جلب تنبيهات مستخدم معيّن
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
// 🚀 API لجلب بيانات الحيوانات
app.get('/api/animals', (req, res) => {
  const animalsFile = path.join(__dirname, 'data', 'animals.json');
  fs.readFile(animalsFile, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'فشل تحميل بيانات الحيوانات' });

    const animals = JSON.parse(data);
    res.json(animals);
  });
});
