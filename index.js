const express = require('express');
const path = require('path');
const app = express();

// 1. إعدادات عامة
app.use(express.json());
app.use(express.static('public')); // لقراءة ملفات HTML وCSS

// 2. صفحة البداية
app.get('/', (req, res) => {
  res.send('✅ السيرفر شغال – مرحبًا بك في مربيك 🐄');
});

// 3. API لاستقبال بيانات الحيوان
app.post('/animal', (req, res) => {
  const animalData = req.body;

  // التحقق البسيط من وجود رقم الحيوان
  if (!animalData.animal_id) {
    return res.status(400).json({ message: '❌ رقم الحيوان مطلوب' });
  }

  // عرض البيانات في الكونسول (لمجرد التأكد أثناء التطوير)
  console.log('📥 تم استلام بيانات الحيوان:');
  console.log(animalData);

  // رد ناجح
  res.status(200).json({ message: '✅ تم حفظ البيانات بنجاح' });
});

// 4. تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر شغال على http://localhost:${PORT}`);
});
