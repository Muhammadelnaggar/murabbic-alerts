// server.js — Murabbik stable Render build (Firestore: murabbikdata)

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ================== Middleware ==================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== Firebase Admin ==================
let db = null;

try {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT || null;
  let credential = null;

  if (saJson) {
    try {
      const sa = JSON.parse(saJson);
      credential = admin.credential.cert(sa);
    } catch (e) {
      console.error("⚠️ فشل في قراءة FIREBASE_SERVICE_ACCOUNT، هنستخدم applicationDefault:", e.message);
    }
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: credential || admin.credential.applicationDefault(),
    });
  }

  // ✅ ربط صريح بقاعدة murabbikdata (وليست default)
  db = admin.firestore(admin.app(), "murabbikdata");

  console.log("✅ Firestore متصل بقاعدة:", db._databaseId.database);
} catch (err) {
  console.error("❌ خطأ في تهيئة Firestore:", err);
  db = null;
}

// ================== Local Fallback (اختياري) ==================
const dataDir = path.join(__dirname, "data");
const animalsPath = path.join(dataDir, "animals.json");
const eventsPath = path.join(dataDir, "events.json");

function ensureFile(filePath) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "[]", "utf8");
  } catch (err) {
    console.error("⚠️ تعذر إنشاء ملف fallback:", filePath, err.message);
  }
}

ensureFile(animalsPath);
ensureFile(eventsPath);

async function readFallback(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8") || "[]";
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function getCollectionDocs(colName, where = []) {
  // 🔹 المسار الأساسي: Firestore murabbikdata
  if (db) {
    let ref = db.collection(colName);
    where.forEach(([field, op, value]) => {
      ref = ref.where(field, op, value);
    });
    const snap = await ref.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // 🔹 في حالة غياب db: fallback محلي
  const filePath =
    colName === "animals"
      ? animalsPath
      : colName === "events"
      ? eventsPath
      : null;

  if (!filePath) return [];

  const all = await readFallback(filePath);

  if (!where.length) return all;

  // فلتر بسيط فقط لـ "=="
  return all.filter((row) =>
    where.every(([field, op, value]) => {
      if (op === "==") return row[field] === value;
      return true;
    })
  );
}

// ================== API Routes ==================

// Ping للتأكد من الربط
app.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    db: !!db,
    databaseId: db ? db._databaseId.database : null,
  });
});

// herd-stats — مبني على userId / X-User-Id (بدون لعب بالـ farmId)
app.get("/api/herd-stats", async (req, res) => {
  try {
    const userId =
      (req.header("X-User-Id") || req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_USER_ID",
        message: "يجب إرسال X-User-Id في الهيدر أو userId في الكويري.",
      });
    }

    const animals = await getCollectionDocs("animals", [
      ["userId", "==", userId],
    ]);
    const events = await getCollectionDocs("events", [
      ["userId", "==", userId],
    ]);

    const totalAnimals = animals.length;

    const lactating = animals.filter((a) => {
      return (
        a.isLactating === true ||
        a.reproductiveStatus === "حلاب" ||
        a.reproductiveStatus === "حلابه"
      );
    }).length;

    // هنا ممكن نكمل حساب KPIs لاحقًا بدون ما نكسر الكود الحالي
    res.json({
      ok: true,
      source: db ? "firestore:murabbikdata" : "local-fallback",
      totalAnimals,
      animalsCount: totalAnimals,
      lactating,
      eventsCount: events.length,
    });
  } catch (err) {
    console.error("❌ /api/herd-stats error:", err);
    res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// ================== Static Frontend ==================
app.use(express.static(path.join(__dirname, "www")));

// أي Route تاني يرجع الداشبورد (SPA بسيطة)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "www", "dashboard.html"));
});

// ================== Start Server ==================
app.listen(PORT, () => {
  console.log(`🚀 Murabbik server running on port ${PORT}`);
});
