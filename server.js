const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true })); // دعم بيانات form
app.use(express.json());
app.use(express.static('public'));

const eventsPath = path.join(__dirname, 'data', 'events.json');

// ✅ استقبال البيانات من نموذج تسجيل الحدث
app.post('/api/events', (req, res) => {
  const { animalId, eventType, eventDate } = req.body;

  // تحميل الأحداث الحالية من الملف
  fs.readFile(eventsPath, 'utf8', (err, data) => {
    let events = [];
    if (!err && data) {
      events = JSON.parse(data);
    }

    const newEvent = {
      id: events.length + 1,
      animalId,
      eventType,
      eventDate,
      timestamp: new Date().toISOString()
    };

    events.push(newEvent);

    // حفظ التحديثات
    fs.writeFile(eventsPath, JSON.stringify(events, null, 2), (err) => {
      if (err) {
        console.error('❌ فشل في حفظ الحدث:', err);
        return res.status(500).send('خطأ في الحفظ');
      }

      console.log('✅ تم تسجيل الحدث:', newEvent);
      res.redirect('/events.html'); // إعادة توجيه المستخدم بعد التسجيل
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ السيرفر يعمل على http://localhost:${PORT}`);
});
