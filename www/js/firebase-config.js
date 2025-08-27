// /js/firebase-config.js
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ← حط إعدادات مشروعك هنا
const firebaseConfig = {
  apiKey: "AIzaSyB0dtFS3R-MQ-LJfd_dB1YOTxiwDVshIYc",
  authDomain: "murabbik.firebaseapp.com",
  projectId: "murabbik",
  storageBucket: "murabbik.firebasestorage.app",
  messagingSenderId: "402719243568",
  appId: "1:402719243568:web:631114a260d23202dd5cf5"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
// 👈 أهم سطر: خزّن الجلسة في localStorage (أكتر ثباتًا على الموبايل من IndexedDB)
await setPersistence(auth, browserLocalPersistence).catch(console.warn);

export const db = getFirestore(app);
