import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
getFirestore, collection, addDoc, serverTimestamp,
enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


const _db = getFirestore(getApp());
// تفعيل العمل أوفلاين إن توفر
enableIndexedDbPersistence(_db).catch(() => {});


const _q = []; let _flushing = false;
async function _flush(){
if (_flushing) return; _flushing = true;
while(_q.length){
const { tenantId, payload } = _q.shift();
try {
await addDoc(collection(_db, `tenants/${tenantId}/activity`), payload);
} catch (e) {
// أرجع الحدث للطابور وتوقف (شبكة/صلاحيات)
_q.unshift({ tenantId, payload }); break;
}
}
_flushing = false;
}


window.timeline = {
init({ tenantId, userId }){
this.tenantId = tenantId || localStorage.getItem('tenantId') || 'default';
this.userId = userId || localStorage.getItem('userId') || null;
},
log(name, props={}){
try {
const tenantId = this.tenantId || 'default';
const payload = {
name,
props,
userId: this.userId || localStorage.getItem('userId') || null,
path: location.pathname,
ts: serverTimestamp()
};
_q.push({ tenantId, payload });
_flush();
} catch (e) { console.warn('timeline/log failed', e); }
}
};

