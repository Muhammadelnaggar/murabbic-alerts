// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// لا تحط الـ API key أو config داخل ملفات HTML مباشرة
const firebaseConfig = {
  apiKey: "AIzaSyB0dtFS3R-MQ-LJfd_dB1YOTxiwDVshIYc",
  authDomain: "murabbik.firebaseapp.com",
  projectId: "murabbik",
  storageBucket: "murabbik.firebasestorage.app",
  messagingSenderId: "402719243568",
  appId: "1:402719243568:web:6b05a3c62e8bfa86dd5cf5"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };
