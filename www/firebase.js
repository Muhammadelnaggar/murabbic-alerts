<!-- www/firebase.js -->
<!-- تحميل مكتبة Firebase -->
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js"></script>

<script>
  // تهيئة Firebase
  const firebaseConfig = {
    apiKey: "AIzaSyChRCOdiqEcrdL9MK1NCjxHqWK_H1wPu1E",
    authDomain: "murabbik.firebaseapp.com",
    projectId: "murabbik",
    storageBucket: "murabbik.firebasestorage.app",
    messagingSenderId: "402719243568",
    appId: "1:402719243568:web:631114a260d23202dd5cf5"
  };

  // تهيئة التطبيق وقاعدة البيانات
  firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();
</script>
