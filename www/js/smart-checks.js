// smart-checks.js — نسخة Stub بدون منطق تشغيل
// الهدف: تعريف واجهة window.smart بدون أي قواعد أو تنبيهات حالياً
// بحيث لا يحدث أي خطأ لو استدعيت الدوال من صفحات مختلفة.

(function(){
  'use strict';
  if (!window.smart) window.smart = {};

  // إعدادات افتراضية (غير مُستخدمة حالياً — للاتساق فقط)
  window.smart.cfg = {
    vwpDays: 60,
    placentaCheckHours: 24,
    heatStartDays: 21,
    pregCheckDays: 35
  };

  // ضابط فوري قبل التلقيح — يسمح دائماً حالياً
  window.smart.beforeInsemination = async function(/* { lastCalvingDate } */){
    return true; // لا منع ولا تنبيه في وضع الـ Stub
  };

  // أحداث بعد التسجيل — لا تفعل شيئاً حالياً
  window.smart.onCalvingRecorded = async function(/* { tenantId, userId, animalId, calvingDate } */){};
  window.smart.onInseminationRecorded = async function(/* { tenantId, userId, animalId, inseminationDate } */){};

  // مراقب التنبيهات — لا يراقب شيئاً حالياً، ويُعيد دالة لإيقافه (لا تفعل شيئاً)
  window.smart.startAlertsWatcher = function(/* { tenantId, userId, onAlert } */){
    return function stop(){ /* no-op */ };
  };
})();
