// /js/firebase-config.js  (ضعه كـ <script type="module"> في الصفحات)
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ✳️ ضع القيم الحقيقية من Firebase Console هنا
const firebaseConfig = {
  apiKey: "AIza...YOUR_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",                // مهم جدًا
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};

// تهيئة واحدة فقط
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// نُصدّر الكائنات لاستخدامها في الصفحات
export const auth = getAuth(app);
export const db   = getFirestore(app);

// اجعل الجلسة محفوظة محليًا (بدون top-level await)
setPersistence(auth, browserLocalPersistence).catch(console.warn);
