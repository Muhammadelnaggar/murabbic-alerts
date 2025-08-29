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
  apiKey: "AIzaSyCnkVBmRIyDZDpUX4yMH3SeR0hbnBqrh-4",
  authDomain: "murabbik-470511.firebaseapp.com",
  projectId: "murabbik-470511",
  storageBucket: "murabbik-470511.firebasestorage.app",
  messagingSenderId: "118468123456",
  appId: "1:118468123456:web:f26a0d1bad72b3792cf8a5",
  measurementId: "G-RQLB522T8B"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

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
