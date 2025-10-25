// /js/firebase-config.js  (ESM عبر CDN)
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ⚙️ إعدادات مشروعك (زي ما عندك)
const firebaseConfig = {
  apiKey: "AIzaSyCnkVBmRIyDZDpUX4yMH3SeR0hbnBqrh-4",
  authDomain: "murabbik-470511.firebaseapp.com",
  projectId: "murabbik-470511",
  storageBucket: "murabbik-470511.appspot.com",
  messagingSenderId: "118468123456",
  appId: "1:118468123456:web:f26a0d1bad72b3792cf8a5"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// 👈 قاعدة Firestore المسماة
export const db = getFirestore(app, "murabbikdata");

// Auth + تخزين الجلسة في المتصفح
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(console.warn);

// للصفحات اللي عايزة تحقّق بدون تحويل (هترمي LOGIN_REQUIRED لو مش داخل)
export async function requireAuth(){
  if (auth.currentUser) return auth.currentUser;
  throw new Error('LOGIN_REQUIRED');
}

// ✅ الواجهة المتوافقة مع كودك الحالي
// لو مش داخل → نحفظ الصفحة الحالية في sessionStorage ونحوّل لـ login.html
export async function ensureAuth(loginUrl = '/login.html'){
  if (auth.currentUser) return auth.currentUser;

  // فرصة قصيرة لو المتصفح يرجّع جلسة محفوظة بسرعة
  const user = await new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => { off(); resolve(u || null); });
  });
  if (user) return user;

  try { sessionStorage.setItem('postLogin', location.href); } catch {}
  location.href = loginUrl;
  throw new Error('LOGIN_REQUIRED_REDIRECT'); // يوقف تنفيذ الصفحة الحالية
}
