// /js/firebase-config.js  (ضعه كـ <script type="module"> في الصفحات)
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ✳️ ضع القيم الحقيقية من Firebase Console هنا
const firebaseConfig = {
  apiKey: "AIzaSyB0dtFS3R-MQ-LJfd_dB1YOTxiwDVshIYc",
  authDomain: "murabbik.firebaseapp.com",
  projectId: "murabbik",
  storageBucket: "murabbik.firebasestorage.app",
  messagingSenderId: "402719243568",
  appId: "1:402719243568:web:631114a260d23202dd5cf5"
};

// تهيئة واحدة فقط
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// نُصدّر الكائنات لاستخدامها في الصفحات
export const auth = getAuth(app);
export const db   = getFirestore(app);

// اجعل الجلسة محفوظة محليًا (بدون top-level await)
setPersistence(auth, browserLocalPersistence).catch(console.warn);
