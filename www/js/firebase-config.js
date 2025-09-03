// /js/firebase-config.js — يعمل في المتصفح (ESM عبر CDN)
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, addDoc, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ⚙️ انسخ القيم من Project settings → Web App → Config
const firebaseConfig = {
  apiKey: "AIzaSyCnkVBmRIyDZDpUX4yMH3SeR0hbnBqrh-4",
  authDomain: "murabbik-470511.firebaseapp.com",
  projectId: "murabbik-470511",
  storageBucket: "murabbik-470511.appspot.com",
  messagingSenderId: "118468123456",
  appId: "1:118468123456:web:f26a0d1bad72b3792cf8a5"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// ✅ لو عندك قاعدة بيانات مسماة اسمها murabbikdata فعلاً، اترك السطر التالي كما هو.
// ⚠️ لو لا، استخدم getFirestore(app) بدون اسم.
export const db = getFirestore(app /*, "murabbikdata"*/);

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(console.warn);

// دالة مطابقة لما تستدعيه صفحتك:
export async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;      // جلسة محفوظة
  try {
    // تسجيل دخول مجهول تلقائيًا — غرضه تمكين UID للفلاتر والقواعد
    await signInAnonymously(auth);
    return auth.currentUser;
  } catch (e) {
    console.error("ensureAuth/signInAnonymously failed", e);
    throw e;
  }
}

// (اختياري) احتفظ بـ requireAuth إن كنت تحتاجها في صفحات أخرى
export async function requireAuth() {
  if (auth.currentUser) return auth.currentUser;
  throw new Error("LOGIN_REQUIRED");
}

// إعادة تصدير أدوات Firestore التي قد تحتاجها صفحات أخرى
export { addDoc, collection, serverTimestamp };
