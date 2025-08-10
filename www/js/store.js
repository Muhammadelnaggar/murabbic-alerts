// www/js/store.js
// يفترض إن window.firebaseConfig موجود في الصفحة قبل التحميل
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';
import {
  getFirestore, collection, addDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';

const app = initializeApp(window.firebaseConfig);
const db  = getFirestore(app);
const auth = getAuth(app);

// تاريخ اليوم بصيغة YYYY-MM-DD
function pad(n){ return String(n).padStart(2,'0'); }
export function todayYMD(){
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

async function getUID(){
  const u = auth.currentUser;
  if (!u) throw new Error('سجّل دخولك أولاً');
  return u.uid;
}

// حفظ حدث في Firestore + إرسال إشارة داخلية smart-tracker
export async function saveEvent({ animalNumber, eventDate, type, notes=null, meta=null, originEventId=null }){
  const userId = await getUID();
  const payload = {
    userId, animalNumber, eventDate, type,
    ...(notes?{notes}:{}), ...(meta?{meta}:{}), ...(originEventId?{originEventId}:{}),
    createdAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, 'events'), payload);

  // إشعار داخلي للمتابع الذكي
  window.dispatchEvent(new CustomEvent('event:saved', {
    detail: { id: ref.id, ...payload }
  }));

  return ref.id;
}

// إنشاء مهمة متابعة بسيطة
export async function saveTask({ animalNumber, dueDate, title, kind='followup', status='open', originEventId=null }){
  const userId = await getUID();
  const ref = await addDoc(collection(db, 'tasks'), {
    userId, animalNumber, dueDate, title, kind, status, originEventId,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

// مريح للاستخدام من الصفحات
export const Store = { saveEvent, saveTask, todayYMD };
window.Store = Store;
