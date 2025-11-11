// =======================================================
// server.js — Murabbik Production Build (Render)
// =======================================================

const path = require("path");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =======================================================
// 🔹 Firebase Admin Initialization — explicit murabbikdata DB
// =======================================================
let db = null;

try {
  // تحميل بيانات الحساب الخدمي (Service Account) من متغير البيئة
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  // إنشاء التطبيق إذا لم يكن موجوداً
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: sa
        ? admin.credential.cert(sa)
        : admin.credential.applicationDefault(),
    });
  }

  // ✅ الاتصال الصريح بقاعدة البيانات المسماة murabbikdata
  const appInstance = admin.app();
  db = admin.firestore(appInstance, "murabbikdata");

  // 🔍 طباعة تأكيد في اللوج لتتبع الاتصال
  const dbName =
    db._databaseId && db._databaseId.database
      ? db._databaseId.database
      : "(default)";
  console.log("✅ Firestore connected successfully to:", dbName);
} catch (err) {
  console.error("❌ Firestore initialization failed:", err);
}

// =======================================================
// 🔸 REST API Endpoints
// =======================================================

// اختبار الاتصال
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, service: "murabbik-alerts", time: new Date().toISOString() });
});

// إرجاع بيانات الحيوانات (من Firestore murabbikdata)
app.get("/api/animals", async (req, res) => {
  try {
    const userId = req.query.userId || req.header("X-User-Id");
    if (!userId) return res.status(400).json({ ok: false, error: "Missing userId" });

    const snapshot = await db
      .collection("animals")
      .where("userId", "==", userId)
      .get();

    const animals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, animals });
  } catch (err) {
    console.error("❌ /api/animals error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// إرجاع إحصاءات القطيع
app.get("/api/herd-stats", async (req, res) => {
  try {
    const userId = req.query.userId || req.header("X-User-Id");
    if (!userId) return res.status(400).json({ ok: false, error: "Missing userId" });

    const animalsSnap = await db
      .collection("animals")
      .where("userId", "==", userId)
      .get();

    const animals = animalsSnap.docs.map(d => d.data());
    const totalActive = animals.length;
    const pregnant = animals.filter(a => a.reproductiveStatus === "عشار").length;
    const lactating = animals.filter(a => a.productionStatus === "حلاب").length;

    res.json({
      ok: true,
      totals: {
        totalActive,
        pregnant: { count: pregnant, pct: totalActive ? Math.round((pregnant / totalActive) * 100) : 0 },
        inMilk: { count: lactating, pct: totalActive ? Math.round((lactating / totalActive) * 100) : 0 },
      },
    });
  } catch (err) {
    console.error("❌ /api/herd-stats error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// =======================================================
// 🔹 Static files (Dashboard frontend)
// =======================================================
app.use(express.static(path.join(__dirname, "www")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "www", "index.html"));
});

// =======================================================
// 🚀 Start Server
// =======================================================
app.listen(PORT, () => {
  console.log(`✅ Murabbik Alerts service running on port ${PORT}`);
  console.log(`🌍 Visit: https://murabbic-alerts.onrender.com`);
});
