from pathlib import Path
import hashlib,difflib,subprocess
root=Path('/mnt/data/murabbik_stage4_work')
old=Path('/mnt/data/murabbik_work/server_stage2_navigation_candidate.js').read_text()
original=Path('/mnt/data/MURABBIK_RESTORE_ORIGINAL_AFTER_DIAGNOSTIC_20261013/server.js').read_bytes()
assert hashlib.sha1(b'blob '+str(len(original)).encode()+b'\0'+original).hexdigest()=='f124c029dba301d07c5430e58cf665b55308bc30'
original_get='''const result =
  await murabbikSmartAlertCollectSrv(
    req
  );

const stateResult =
'''
assert old.count(original_get)==1,old.count(original_get)
new_get='''// Prepared reads are opt-in AND require four durable, independently
// established certifications. Without them, retain the original live collector.
const result =
  await murabbikSmartAlertReadPreparedCandidateSrv(req) ||
  await murabbikSmartAlertCollectSrv(req);

const stateResult =
'''
helper='''// BEGIN PREPARED SMART ALERT READ CANDIDATE — disabled by default.
async function murabbikSmartAlertReadPreparedCandidateSrv(req) {
  if (process.env.MURABBIK_PREPARED_READ_ENABLE !== '1') return null;
  try {
    const model = require('./server/smart-alert-prepared-read');
    // Registry drift must fail closed even if persisted certification is stale.
    const liveSources = [...murabbikSmartAlertSourcesSrv.keys()].sort();
    const certifiedSources = [...model.EXPECTED_SOURCES].sort();
    if (liveSources.length !== certifiedSources.length ||
        liveSources.some((name, i) => name !== certifiedSources[i])) return null;
    const tenant = tenantKey(req.userId);
    const actorUid = murabbikSmartAlertActorUidSrv(req);
    if (!tenant || !actorUid) return null;
    const farmDay = await farmTodayISOSrv(req.authSession?.uid || req.userId);
    const nowMs = Date.now();
    const ready = await model.readIfFresh({
      db,
      controlRef: db.collection('smart_alert_prepared_meta').doc(tenant),
      preparedRef: db.collection('smart_alert_prepared_results').doc(tenant)
        .collection('by_actor').doc(actorUid),
      actorUid, farmDay, nowMs
    });
    // If the due boundary arrived during the read, never return stale data.
    if (!ready || !Number.isSafeInteger(ready.validUntilMs) ||
        Date.now() >= ready.validUntilMs) return null;
    return {context: {today: farmDay, nowMs: Date.now()}, alerts: ready.alerts, sourceErrors: []};
  } catch (error) {
    // Never treat prepared-read errors as evidence of an empty alert list.
    console.warn('smart-alert-prepared-fallback', Number.isInteger(error?.code) ? error.code : 'error');
    return null;
  }
}
// END PREPARED SMART ALERT READ CANDIDATE.

'''
needle='app.get("/api/smart-alerts", requireUserId, async (req, res) => {'
assert old.count(needle)==1
updated=old.replace(needle,helper+needle).replace(original_get,new_get)
p=root/'server_stage4_get_candidate.js';p.write_text(updated)
subprocess.run(['node','--check',str(p)],check=True)
(root/'server_stage4_get.patch').write_text(''.join(difflib.unified_diff(old.splitlines(keepends=True),updated.splitlines(keepends=True),fromfile='server_stage2_navigation_candidate.js',tofile='server_stage4_get_candidate.js')))
(root/'integrated_get_old_new.md').write_text('# مُرَبِّيك — استبدال GET حرفي (مرشح غير منشور)\n\n**القديم الكامل:**\n\n```javascript\n'+original_get.rstrip()+'\n```\n\n**البديل الكامل:**\n\n```javascript\n'+new_get.rstrip()+'\n```\n\n**الإضافة قبل GET:**\n\n```javascript\n'+helper.rstrip()+'\n```\n\n**ملف جديد:** `server/smart-alert-prepared-read.js` (مرفق كاملًا في الحزمة).\n')
print('candidate',p,'sha256',hashlib.sha256(p.read_bytes()).hexdigest(),'bytes',len(p.read_bytes()))