// ./js/firebase-config.js  (ESM)
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, addDoc, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ✳️ إعدادات مشروعك
const firebaseConfig = {
  apiKey: "AIzaSyB0dtFS3R-MQ-LJfd_dB1YOTxiwDVshIYc",
  authDomain: "murabbik.firebaseapp.com",
  projectId: "murabbik",
  storageBucket: "murabbik.firebasestorage.app", // (اختياري: غالبًا .appspot.com)
  messagingSenderId: "402719243568",
  appId: "1:402719243568:web:631114a260d23202dd5cf5"
};

// تهيئة واحدة
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// نصدر الكائنات المطلوبة
export const auth = getAuth(app);
export const db   = getFirestore(app);

// ثبات الجلسة محليًا
setPersistence(auth, browserLocalPersistence).catch(console.warn);

// ✅ تزويد ensureAuth التي يتوقعها النموذج
export async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  const { user } = await signInAnonymously(auth);
  return user;
}

// ✅ إعادة تصدير ما يحتاجه زر الحفظ
export { addDoc, collection, serverTimestamp };
