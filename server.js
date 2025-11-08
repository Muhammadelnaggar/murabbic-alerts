// server.js — النسخة النهائية المستقرة (Render Ready)
// =======================================================
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Firebase Admin (Render-safe) =====
let db = null;
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: sa ? admin.credential.cert(sa) : admin.credential.applicationDefault(),
    });
  }

  // ✅ استخدم القاعدة الافتراضية وليس المسماة لتفادي مشكلة Render
  db = admin.firestore();
  console.log("✅ Firestore connected (default DB)");
} catch (e) {
  console.log("⚠️ Firestore init failed:", e.message);
}

// ===== Helpers =====
const dayMs = 86400000;
function toYYYYMMDD(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function toDate(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000);
  if (typeof v === "number") return new Date(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
  return new Date(s);
}
function resolveTenant(req) {
  return (
    req.headers["x-user-id"] ||
    req.query.userId ||
    process.env.DEFAULT_TENANT_ID ||
    "DEFAULT"
  );
}

// ============================================================
//                       API: HERD STATS
// ============================================================
app.get("/api/herd-stats", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    if (!tenant || tenant === "DEFAULT")
      return res.status(400).json({ ok: false, error: "userId_required" });

    if (!db)
      return res.status(500).json({ ok: false, error: "firestore_not_ready" });

    const adb = db;
    console.log("📡 Fetching herd stats for", tenant);

    // 🟢 جلب الحيوانات من أي مستوى (collectionGroup) باستخدام ownerUid أو userId
    let animalsDocs = [];
    try {
      const snap1 = await adb
        .collectionGroup("animals")
        .where("ownerUid", "==", tenant)
        .get();
      animalsDocs = snap1.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (animalsDocs.length === 0) {
        const snap2 = await adb
          .collectionGroup("animals")
          .where("userId", "==", tenant)
          .get();
        animalsDocs
