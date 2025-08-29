// /js/firebase-config.js  — يعمل مباشرة من المتصفح (ESM عبر CDN)

// Firebase App + Auth + Firestore من الـ CDN
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, addDoc, collection, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ⚙️ ضعي هنا القيم التي تظهر لك في صفحة Web App في Firebase (apiKey, authDomain, ...)
// تلاقيها في Project settings → Your apps → murabbik (Web App) → Config
const firebaseConfig = {
  apiKey: "انسخي من صفحة Firebase",
  authDomain: "murabbik-470511.firebaseapp.com",
  projectId: "murabbik-470511",
  storageBucket: "murabbik-470511.appspot.com",
  messagingSenderId: "118468123456",
  appId: "1:118468123456:web:f26a0d1bad72b3792cf8a5",
  measurementId: "G-RQLB522T8B"
};

// تهيئة التطبيق (مرة واحدة)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// ✅ استخدمي قاعدة Firestore المسماة murabbikdata (مش الافتراضي)
export const db = getFirestore(app, "murabbikdata");

// Auth + تثبيت الجلسة
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(console.warn);

// دالة تسجيل مجهول مطلوبة من زر الحفظ
export async function ensureAuth(){
  if (auth.currentUser) return auth.currentUser;
  const { user } = await signInAnonymously(auth);
  return user;
}

// هذه الدوال هي التي يستعملها زر الحفظ
export { addDoc, collection, serverTimestamp };

// (اختياري) Analytics آمن — يتجاهل لو غير مدعوم
(async ()=>{ try{
  const { getAnalytics, isSupported } =
    await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js");
  if (await isSupported()) getAnalytics(app);
} catch {} })();
