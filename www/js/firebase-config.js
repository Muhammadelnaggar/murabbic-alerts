// www/js/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// نحتاج export عشان الاستيراد الديناميكي يلاقيه
export const firebaseConfig = {
  apiKey: "AIzaSyB0dtFS3R-MQ-LJfd_dB1YOTxiwDVshIYc",
  authDomain: "murabbik.firebaseapp.com",
  projectId: "murabbik",
  storageBucket: "murabbik.appspot.com", // ← دي الصح لاسم البكت
  messagingSenderId: "402719243568",
  appId: "1:402719243568:web:631114a260d23202dd5cf5"
};

const app  = initializeApp(firebaseConfig);
export const db   = getFirestore(app);
export const auth = getAuth(app);
export { app };
