# مُرَبِّيك — المرحلة الأولى: حماية طلبات وأزرار التنبيهات على الداش

**المرجع:** GitHub `main/www/dashboard.html` Git blob `7ab54a030f2b5a6af0acbc2f513333486f4f03e1`.
**فحص التطابق:** تمّت مطابقة المقاطع الستة حرفيًا مع `main/www/dashboard.html` الحالي بعد توحيد أسطر CRLF/LF، عن طريق مطابقة بصمات المقاطع. جرى تركيبها واختبارها على نسخة 8 أكتوبر فقط؛ لا تستبدل ملف GitHub الحالي كاملًا بالملف التجريبي القديم. طبّق الاستبدالات المحددة على ملف GitHub الحالي ثم اختبره قبل النشر.
المرحلة لا تلغي فترة الدقيقة، ولا تغير GET/POST، ولا تعتمد مؤشرات التنبيهات في الداش كحقيقة طبية. وتحتاج اختبار runtime على نسخة GitHub الحالية.
## 1. State and single-decision guard
### القديم كاملًا
```javascript
function dashboardMurabbikUiAlert(
  alert = {}
) {
  const priority =
    String(
      alert.priority ||
      'normal'
    ).toLowerCase();

  return {
    ...alert,

    dashboardSource:
      'murabbik_smart',

    level:
      priority === 'urgent'
        ? 'danger'
        : priority === 'high'
          ? 'warn'
          : 'info',

    actionText:
      alert?.action?.label ||
      '',

    actionUrl:
      alert?.action?.url ||
      '',

    actionDisabled:
      alert?.action?.type !==
      'navigate'
  };
}
```
### البديل كاملًا
```javascript
function dashboardMurabbikUiAlert(
  alert = {}
) {
  const priority =
    String(
      alert.priority ||
      'normal'
    ).toLowerCase();

  return {
    ...alert,

    dashboardSource:
      'murabbik_smart',

    level:
      priority === 'urgent'
        ? 'danger'
        : priority === 'high'
          ? 'warn'
          : 'info',

    actionText:
      alert?.action?.label ||
      '',

    actionUrl:
      alert?.action?.url ||
      '',

    actionDisabled:
      alert?.action?.type !==
      'navigate'
  };
}

// Smart Alerts browser coordination — no server decisions are made here.
let mbkSmartAlertsGetPending = false;
let mbkSmartAlertsDecisionPending = false;
let mbkSmartAlertsResponseEpoch = 0;

async function mbkSmartAlertsRunDecision(actions, clickedButton, execute) {
  if (mbkSmartAlertsDecisionPending) return;

  mbkSmartAlertsDecisionPending = true;
  // Discard any GET that began before this user decision.
  mbkSmartAlertsResponseEpoch += 1;

  const buttons = Array.from(actions.querySelectorAll('button'));
  const wasDisabled = buttons.map(button => button.disabled);
  const originalText = clickedButton.textContent;

  buttons.forEach(button => { button.disabled = true; });
  clickedButton.textContent = 'جارٍ التنفيذ…';

  try {
    return await execute();
  } catch (error) {
    buttons.forEach((button, index) => {
      button.disabled = wasDisabled[index];
    });
    clickedButton.textContent = originalText;
    throw error;
  } finally {
    mbkSmartAlertsDecisionPending = false;
  }
}
```

## 2. Action button shared lock
### القديم كاملًا
```javascript
    .addEventListener(
      'click',
      async () => {
        primaryButton.disabled =
          true;

        try {
          const data =
            await respondMurabbikSmartAlert(
              alert,
              'acknowledged',
              true
            );

          /*
           * السيرفر رجّع التنبيه التالي بالفعل.
           * نسمح للمتصفح برسمه أولًا،
           * ثم نفتح صفحة الحدث.
           */
          await new Promise(
            resolve =>
              requestAnimationFrame(
                () =>
                  requestAnimationFrame(
                    resolve
                  )
              )
          );

          if (!data.navigateUrl) {
            throw new Error(
              'smart_alert_action_url_missing'
            );
          }

          location.href =
            String(
              data.navigateUrl
            );

        } catch (e) {
          primaryButton.disabled =
            false;

          console.warn(
            'murabbik smart alert action response failed',
            e
          );
        }
      }
    );
```
### البديل كاملًا
```javascript
    .addEventListener(
      'click',
      async () => {
        try {
          await mbkSmartAlertsRunDecision(actions, primaryButton, async () => {
            const data = await respondMurabbikSmartAlert(
              alert, 'acknowledged', true
            );
            // Preserve the existing server-approved navigation contract.
            await new Promise(resolve => requestAnimationFrame(
              () => requestAnimationFrame(resolve)
            ));
            if (!data.navigateUrl) {
              throw new Error('smart_alert_action_url_missing');
            }
            location.href = String(data.navigateUrl);
          });
        } catch (e) {
          console.warn('murabbik smart alert action response failed', e);
        }
      }
    );
```

## 3. Snooze button shared lock
### القديم كاملًا
```javascript
      .addEventListener(
        'click',
        async () => {
          laterButton.disabled =
            true;

          try {
            await respondMurabbikSmartAlert(
              alert,
              'snoozed'
            );

          } catch (e) {
            laterButton.disabled =
              false;

            console.warn(
              'murabbik smart alert snooze failed',
              e
            );
          }
        }
      );
```
### البديل كاملًا
```javascript
      .addEventListener(
        'click',
        async () => {
          try {
            await mbkSmartAlertsRunDecision(actions, laterButton,
              () => respondMurabbikSmartAlert(alert, 'snoozed')
            );
          } catch (e) {
            console.warn('murabbik smart alert snooze failed', e);
          }
        }
      );
```

## 4. Acknowledge button shared lock
### القديم كاملًا
```javascript
    .addEventListener(
      'click',
      async () => {
        okButton.disabled =
          true;

        try {
          await respondMurabbikSmartAlert(
            alert,
            'acknowledged'
          );

        } catch (e) {
          okButton.disabled =
            false;

          console.warn(
            'murabbik smart alert acknowledge failed',
            e
          );
        }
      }
    );
```
### البديل كاملًا
```javascript
    .addEventListener(
      'click',
      async () => {
        try {
          await mbkSmartAlertsRunDecision(actions, okButton,
            () => respondMurabbikSmartAlert(alert, 'acknowledged')
          );
        } catch (e) {
          console.warn('murabbik smart alert acknowledge failed', e);
        }
      }
    );
```

## 5. GET single-flight and stale response guard
### القديم كاملًا
```javascript
async function loadMurabbikSmartAlerts() {
  try {
    if (!currentUserId) return;

    const r = await fetch(
      API_BASE + '/api/smart-alerts',
      {
        method: 'GET',

        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-store'
        },

        credentials: 'same-origin',
        cache: 'no-store'
      }
    );

    const data = await r
      .json()
      .catch(() => null);

    dashboardAlertSources.murabbik =
      data?.ok === true &&
      data?.currentAlert
        ? [
            dashboardMurabbikUiAlert(
              data.currentAlert
            )
          ]
        : [];

  } catch (e) {
    console.warn(
      'murabbik smart alerts failed',
      e
    );

    dashboardAlertSources.murabbik = [];
  }

 
  refreshDashboardSmartAlert();
}
```
### البديل كاملًا
```javascript
async function loadMurabbikSmartAlerts() {
  if (!currentUserId || mbkSmartAlertsGetPending ||
      mbkSmartAlertsDecisionPending || document.hidden) return;

  mbkSmartAlertsGetPending = true;
  const startedEpoch = mbkSmartAlertsResponseEpoch;
  try {
    const r = await fetch(
      API_BASE + '/api/smart-alerts',
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-store'
        },
        credentials: 'same-origin',
        cache: 'no-store'
      }
    );
    const data = await r.json().catch(() => null);

    // A user decision made while GET was pending takes precedence.
    if (startedEpoch !== mbkSmartAlertsResponseEpoch ||
        mbkSmartAlertsDecisionPending) return;

    dashboardAlertSources.murabbik =
      data?.ok === true && data?.currentAlert
        ? [dashboardMurabbikUiAlert(data.currentAlert)]
        : [];
  } catch (e) {
    if (startedEpoch !== mbkSmartAlertsResponseEpoch ||
        mbkSmartAlertsDecisionPending) return;
    console.warn('murabbik smart alerts failed', e);
    dashboardAlertSources.murabbik = [];
  } finally {
    mbkSmartAlertsGetPending = false;
  }

  refreshDashboardSmartAlert();
}
```

## 6. Visibility-aware 60-second poll preserved
### القديم كاملًا
```javascript
      setInterval(

        loadMurabbikSmartAlerts,
        60 * 1000
      );
```
### البديل كاملًا
```javascript
      setInterval(
        loadMurabbikSmartAlerts,
        60 * 1000
      );
      // Hidden tabs make no expensive request; resume refreshes once.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadMurabbikSmartAlerts();
      });
```