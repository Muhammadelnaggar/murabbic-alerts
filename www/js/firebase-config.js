// /js/firebase-config.js
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ← حط إعدادات مشروعك هنا
const firebaseConfig = { /* ... */ };

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
// 👈 أهم سطر: خزّن الجلسة في localStorage (أكتر ثباتًا على الموبايل من IndexedDB)
await setPersistence(auth, browserLocalPersistence).catch(console.warn);

export const db = getFirestore(app);
