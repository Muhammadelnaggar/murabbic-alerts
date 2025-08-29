// ./js/firebase-config.js  (ESM على المتصفح)
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, addDoc, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ⚙️ إعدادات مشروع murabbik-470511
const firebaseConfig = {
  apiKey: "AIzaSyCnkVBmRIyDZDpUX4yMH3SeR0hbnBqrh-4",
  authDomain: "murabbik-470511.firebaseapp.com",
  projectId: "murabbik-470511",
  // يفضَّل bucket الافتراضي appspot.com إن هتستخدمي Storage
  storageBucket: "murabbik-470511.appspot.com",
  messagingSenderId: "118468123456",
  appId: "1:118468123456:web:f26a0d1bad72b3792cf8a5",
  measurementId: "G-RQLB522T8B"
};

// تهيئة واحدة فقط
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// ✅ لو عندك قاعدة مسماة (مثال: murabbikdata) استخدمي السطر التالي:
export const db = getFirestore(app, "murabbikdata");
// لو بتستخدمي القاعدة الافتراضية استخدمي:
// export const db = getFirestore(app);

// Auth + ثبات الجلسة
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(console.warn);

// ✅ دالة الدخول المجهول المتوقَّعة من صفحة الحفظ
export async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  const { user } = await signInAnonymously(auth);
  return user;
}

// ✅ إعادة تصدير دوال Firestore التي يستعملها زر الحفظ
export { addDoc, collection, serverTimestamp };

// (اختياري) Analytics عبر استيراد ديناميكي آمن
(async () => {
  try {
    const { getAnalytics, isSupported } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js");
    if (await isSupported()) getAnalytics(app);
  } catch { /* تجاهل إن لم يُدعَم */ }
})();
