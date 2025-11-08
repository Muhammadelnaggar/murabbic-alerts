// server.js — النسخة النهائية المستقرة (Murabbik Render Ready)
// =======================================================
import express from "express";
import path from "path";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Firebase Admin (Render-safe, murabbikdata enforced) =====
let db;
try {
  const saJSON = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJSON) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(saJSON);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id, // تأكيد التطابق
    });
  }

  // 🔹 الاتصال الإجباري بقاعدة murabbikdata وليس الافتراضية
  db = admin.firestore(admin.app(), "murabbikdata");

  console.log("✅ Firestore connected to project:", sa.project_id);
  console.log("✅ Database ID:", db._databaseId.database);
} catch (err) {
  console.error("❌ Firestore init failed:", err);
}

// ===== Static Files =====
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "www")));

// ===== API Routes =====

// 🔸 /api/animals — جلب كل الحيوانات للمستخدم الحالي
app.get("/api/animals", async (req, res) => {
  try {
    const userId = req.header("X-User-Id") || req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const snapshot = await db.collection("animals")
      .where("userId", "==", userId)
      .get();

    const animals = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(animals);
  } catch (err) {
    console.error("Error fetching animals:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 🔸 /api/events — إضافة حدث جديد
app.post("/api/events", async (req, res) => {
  try {
    const data = req.body;
    if (!data.userId) return res.status(400).json({ error: "Missing userId" });

    data.createdAt = admin.firestore.FieldValue.serverTimestamp();
    const docRef = await db.collection("events").add(data);

    res.json({ success: true, id: docRef.id });
  } catch (err) {
    console.error("Error adding event:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 🔸 /api/herd-stats — مؤشرات القطيع
app.get("/api/herd-stats", async (req, res) => {
  try {
    const userId = req.header("X-User-Id") || req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const animalsSnap = await db.collection("animals")
      .where("userId", "==", userId)
      .get();

    const eventsSnap = await db.collection("events")
      .where("userId", "==", userId)
      .get();

    const animals = animalsSnap.docs.map(d => d.data());
    const events = eventsSnap.docs.map(d => d.data());

    res.json({
      animalsCount: animals.length,
      eventsCount: events.length,
    });
  } catch (err) {
    console.error("Error fetching herd stats:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ===== Fallback: Serve index.html =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "www", "index.html"));
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`🚀 Murabbik server running on port ${PORT}`);
});
