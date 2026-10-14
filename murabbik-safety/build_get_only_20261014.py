from pathlib import Path
import difflib
HERE=Path(__file__).resolve().parent
p=HERE/'server_original.js'
s=p.read_text(encoding='utf-8')
base=s

def replace(old,new,label):
 global s
 count=s.count(old)
 if count!=1: raise RuntimeError(f'{label}: expected 1 match got {count}')
 s=s.replace(old,new,1)

replace('''async function vaccinationDashboardAlertsDataSrv({
  userId = "",
  profileUid = ""
} = {}) {''','''async function vaccinationDashboardAlertsDataSrv({
  userId = "",
  profileUid = "",
  // GET Smart Alerts فقط: مشاركة القراءة داخل نفس الطلب.
  // الراوت المستقل للتحصين يظل على القراءة الأصلية.
  loadInitialEventsSnapshot = null
} = {}) {''','vaccination-arg')
replace('''    const loadInitialEventsSnap = () => {
      if (!initialEventsPromise) {
        initialEventsPromise = db
          .collection("events")
          .where("userId", "==", uid)
          .limit(5000)
          .get();
      }

      return initialEventsPromise;
    };''','''    const loadInitialEventsSnap = () => {
      if (!initialEventsPromise) {
        initialEventsPromise =
          typeof loadInitialEventsSnapshot === "function"
            ? Promise.resolve().then(loadInitialEventsSnapshot)
            : db
                .collection("events")
                .where("userId", "==", uid)
                .limit(5000)
                .get();
      }

      return initialEventsPromise;
    };''','vaccination-loader')
needle='''const MURABBIK_SMART_ALERT_EVENTS_LIMIT = 8000;

async function murabbikSmartAlertEventsIndexSrv(context) {'''
replace(needle,'''const MURABBIK_SMART_ALERT_EVENTS_LIMIT = 8000;

// قراءة واحدة لكل طلب Smart Alerts، وليست Cache بين الطلبات.
// لا تمس أحداث المزرعة ولا تاريخ التحصينات أو مسارات الحفظ.
async function murabbikSmartAlertEventsSnapshotSrv(context) {
  return await context.load(
    "smart-alerts:events-raw-snapshot",
    () => db.collection("events")
      .where("userId", "==", context.userId)
      .limit(MURABBIK_SMART_ALERT_EVENTS_LIMIT)
      .get()
  );
}

// المحرك القديم للتحصين يقرأ أول 5000 وثيقة.
// إذا كان المشترك 8000، نمرر *نفس أول 5000*، لا جميع الـ8000.
// عند تعذر القراءة المشتركة تعود التحصينات لاستعلامها المستقل.
async function murabbikSmartAlertVaccinationEventsSnapshotSrv(context) {
  let snapshot;
  try {
    snapshot = await murabbikSmartAlertEventsSnapshotSrv(context);
  } catch (e) {
    console.warn("smart-alert-shared-events-fallback", e?.message || e);
    return db.collection("events")
      .where("userId", "==", context.userId)
      .limit(5000)
      .get();
  }

  if (snapshot.docs.length <= 5000) return snapshot;

  const docs = snapshot.docs.slice(0, 5000);
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach(callback, thisArg) {
      docs.forEach(callback, thisArg);
    }
  };
}

async function murabbikSmartAlertEventsIndexSrv(context) {''','shared-helper')
replace('''      const snap =
        await db
          .collection("events")
          .where("userId", "==", context.userId)
          .limit(MURABBIK_SMART_ALERT_EVENTS_LIMIT)
          .get();''','''      const snap =
        await murabbikSmartAlertEventsSnapshotSrv(context);''','shared-index')
replace('''      await vaccinationDashboardAlertsDataSrv({
        userId: context.userId,
        profileUid: context.profileUid
      })''','''      await vaccinationDashboardAlertsDataSrv({
        userId: context.userId,
        profileUid: context.profileUid,
        loadInitialEventsSnapshot:
          context.shareLargeEventsSnapshot === true &&
          tenantKey(context.userId) === context.userId
            ? () => murabbikSmartAlertVaccinationEventsSnapshotSrv(context)
            : null
      })''','vaccination-source')

replace('async function murabbikSmartAlertCollectSrv(req) {\n  const context = {\n    req,\n    userId: req.userId,\n    profileUid: req.authSession?.uid || req.userId,\n    today: await farmTodayISOSrv(req.authSession?.uid || req.userId),\n    nowMs: Date.now(),\n    memo: new Map()\n  };','async function murabbikSmartAlertCollectSrv(req) {\n  const context = {\n    req,\n    userId: req.userId,\n    profileUid: req.authSession?.uid || req.userId,\n    today: await farmTodayISOSrv(req.authSession?.uid || req.userId),\n    nowMs: Date.now(),\n    shareLargeEventsSnapshot: true,\n    memo: new Map()\n  };','collect-only-sharing')

target=HERE/'server_get_only_shared_events_candidate.js'
target.write_text(s,encoding='utf-8')
diff=''.join(difflib.unified_diff(base.splitlines(keepends=True),s.splitlines(keepends=True),fromfile='server_stage2_navigation_candidate.js',tofile=target.name))
(HERE/'get_only_shared_events.diff').write_text(diff,encoding='utf-8')
print('OK',target,'bytes',target.stat().st_size,'changed lines',len(diff.splitlines()))