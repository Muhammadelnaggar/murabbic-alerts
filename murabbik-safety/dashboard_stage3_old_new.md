# مُرَبِّيك — إغلاق سباق العودة للداش أثناء GET

مرشح محلي فقط، مبني على حزمة حماية الداش السابقة (وليس بديلًا جاهزًا للنسخ فوق ملف GitHub بالكامل). يجب تطبيق OLD→NEW على `www/dashboard.html` الحالي.

## تعديل 1

### OLD COMPLETE
```javascript
let mbkSmartAlertsGetPending = false;
let mbkSmartAlertsDecisionPending = false;
```

### NEW COMPLETE
```javascript
let mbkSmartAlertsGetPending = false;
let mbkSmartAlertsRefreshQueued = false;
let mbkSmartAlertsDecisionPending = false;
```

## تعديل 2

### OLD COMPLETE
```javascript
  } finally {
    mbkSmartAlertsGetPending = false;
  }

  refreshDashboardSmartAlert();
}
```

### NEW COMPLETE
```javascript
  } finally {
    mbkSmartAlertsGetPending = false;
    // If a visible tab resumed during an old request, read fresh data once.
    // Queue on the microtask boundary so that requests never overlap.
    if (mbkSmartAlertsRefreshQueued && !mbkSmartAlertsDecisionPending &&
        !document.hidden) {
      mbkSmartAlertsRefreshQueued = false;
      Promise.resolve().then(loadMurabbikSmartAlerts);
    }
  }

  refreshDashboardSmartAlert();
}
```

## تعديل 3

### OLD COMPLETE
```javascript
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadMurabbikSmartAlerts();
      });
```

### NEW COMPLETE
```javascript
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (mbkSmartAlertsGetPending) {
          // A request made before resuming could be stale after other devices changed data.
          mbkSmartAlertsResponseEpoch += 1;
          mbkSmartAlertsRefreshQueued = true;
          return;
        }
        if (!mbkSmartAlertsDecisionPending) loadMurabbikSmartAlerts();
      });
```
