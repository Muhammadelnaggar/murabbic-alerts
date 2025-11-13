// ===============================
// server.js — FINAL FIXED VERSION
// Node 20 compatible
// ===============================

const express = require("express");
const path = require("path");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ----- Middleware -----
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----- FIREBASE ADMIN -----
let db = null;

try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const sa = JSON.parse(raw);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
    });
  }

  db = admin.firestore(admin.app(), "murabbikdata");

  console.log("🔥 Firestore connected to:", db._databaseId.database);

} catch (err) {
  console.error("❌ Firebase Admin init error:", err);
}


// ---------------------------
// API ROUTES
// ---------------------------

// Simple test
app.get("/api/ping", (req, res) => {
  res.json({ ok: true });
});

// Animals query
app.get("/api/animals", async (req, res) => {
  try {
    const userId = req.header("X-User-Id");
    if (!userId) return res.status(400).json({ error: "Missing X-User-Id" });

    const snap = await db
      .collection("animals")
      .where("userId", "==", userId)
      .get();

    console.log("animals query size =", snap.size);

    const animals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, animals });

  } catch (err) {
    console.error("❌ animals query error:", err);
    res.status(500).json({ error: "animals query failed" });
  }
});

// Herd stats
app.get("/api/herd-stats", async (req, res) => {
  try {
    const userId = req.header("X-User-Id");
    if (!userId) return res.status(400).json({ error: "Missing X-User-Id" });

    const snap = await db
      .collection("animals")
      .where("userId", "==", userId)
      .get();

    console.log("herd-stats tenant =", userId);

    const animals = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ ok: true, count: animals.length, animals });

  } catch (err) {
    console.error("❌ herd-stats error:", err);
    res.status(500).json({ error: "herd-stats failed" });
  }
});

// ---------------------------
// FRONTEND STATIC FILES
// ---------------------------

app.use(express.static(path.join(__dirname, "www")));

// Catch-all WITHOUT using "*"
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "www", "index.html"));
});

// ---------------------------
// START SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
