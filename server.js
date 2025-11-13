// ==================
// server.js — FINAL
// Murabbik Alerts
// ==================

const path = require("path");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- FIREBASE ADMIN ----------
let db = null;

try {
  // قراءة الـ Service Account من المتغير FIREBASE_SERVICE_ACCOUNT
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!saRaw) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT not found!");
  }

  const sa = JSON.parse(saRaw);

  // تشغيل Firebase Admin مرة واحدة فقط
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      // **الداتابيز الوحيدة عندنا: murabbikdata**
      databaseURL: "https://firestore.googleapis.com/v1/projects/murabbik/databases/(default)/documents"
    });
  }

  // الاتصال الفعلي بالقاعدة الصحيحة murabbikdata
  db = admin.firestore(admin.app(), "murabbikdata");

  console.log("🔥 Firestore connected to:", db._databaseId.database);

} catch (err) {
  console.error("❌ Firebase Admin Init Error:", err);
}

// ======================================================
//   ROUTES — كلها تعمل بصلاحيات ADMIN فقط
// ======================================================


// -------- Test route ----------
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, message: "Murabbik Alerts server is alive" });
});


// -------- Herd Stats ----------
app.get("/api/herd-stats", async (req, res) => {
  try {
    const userId = req.header("X-User-Id");

    if (!userId) {
      return res.status(400).json({ error: "Missing X-User-Id header" });
    }

    // Query كمسؤول Admin — لا قواعد ولا قيود
    const snap = await db
      .collection("animals")
      .where("userId", "==", userId)
      .get();

    console.log("🐮 herd-stats tenant =", userId);

    const animals = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({
      ok: true,
      count: animals.length,
      animals
    });

  } catch (err) {
    console.error("❌ herd-stats error:", err);
    res.status(500).json({ error: "herd-stats failed" });
  }
});


// -------- Animals list ----------
app.get("/api/animals", async (req, res) => {
  try {
    const userId = req.header("X-User-Id");
    if (!userId) return res.status(400).json({ error: "Missing X-User-Id header" });

    const q = await db
      .collection("animals")
      .where("userId", "==", userId)
      .get();

    console.log("❗ animals query count =", q.size);

    const list = q.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, animals: list });

  } catch (err) {
    console.error("❌ animals route error:", err);
    res.status(500).json({ error: "animals query failed" });
  }
});


// -------- Serve frontend (www/) --------
app.use(express.static(path.join(__dirname, "www")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "www", "index.html"));
});

// -------- Start server --------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
