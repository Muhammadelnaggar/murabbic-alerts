// sensor-bluetooth.js

// حجر الأساس: وحدة استقبال بيانات من الحساسات عبر Bluetooth (مستقبلاً)
// هذا الكود لا يعمل فعليًا الآن، لكنه يمثل البنية القابلة للتفعيل لاحقًا

// يعتمد على Web Bluetooth API (مدعوم جزئيًا في متصفحات Android/Chrome)

async function readSensorViaBluetooth() {
  try {
    // طلب الاتصال بجهاز Bluetooth باسم معين أو خدمة محددة
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true, // يمكن تخصيصه لاسم الحساس مثل "MurabbikSensor"
      optionalServices: ['battery_service']
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('battery_service');
    const characteristic = await service.getCharacteristic('battery_level');

    const value = await characteristic.readValue();
    const batteryLevel = value.getUint8(0);

    // إرسال القراءة إلى السيرفر
    await fetch('https://murabbic-alerts.onrender.com/api/sensors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        animalId: prompt("📌 أدخل رقم الحيوان"),
        readingType: 'battery_level',
        value: batteryLevel,
        timestamp: new Date().toISOString()
      })
    });

    alert('✅ تم استقبال وإرسال قراءة الحساس');
  } catch (error) {
    console.error('❌ فشل في الاتصال بالحساس:', error);
    alert('❌ تعذر الاتصال بالحساس');
  }
}

