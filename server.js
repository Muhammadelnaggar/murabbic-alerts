// server.js — النسخة النهائية المستقرة (Murabbik Render Ready)
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

  // ✅ القاعدة الافتراضية (بدون اسم فرعي)
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

    // 🟢 جلب الحيوانات من أي مستوى باستخدام ownerUid أو userId
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
        animalsDocs = snap2.docs.map((d) => ({ id: d.id, ...d.data() }));
      }
    } catch (e) {
      console.error("❌ herd-stats Firestore read failed:", e.message);
    }

    if (!animalsDocs.length) {
      console.log("⚠️ No animals found for user:", tenant);
      return res.json({
        ok: true,
        totals: {
          totalActive: 0,
          pregnant: { count: 0, pct: 0 },
          inseminated: { count: 0, pct: 0 },
          open: { count: 0, pct: 0 },
        },
        fertility: { conceptionRatePct: 0 },
      });
    }

    const active = animalsDocs.filter((a) => {
      const st = String(a.status || a.lifeStatus || "").toLowerCase();
      if (
        ["sold", "dead", "died", "archived", "inactive", "مباع", "مباعة", "نافق", "ميت"].includes(
          st
        )
      )
        return false;
      if (a.active === false) return false;
      return true;
    });

    const totalActive = active.length;
    const analysisDays = 90;
    const since = new Date(Date.now() - (analysisDays + 340) * dayMs);
    const sinceStr = toYYYYMMDD(since);
    const winStart = new Date(Date.now() - analysisDays * dayMs);

    const activeIds = new Set(
      active.map((a) => String(a.id || a.number || "").trim()).filter(Boolean)
    );

    async function fetchType(type) {
      const out = [];
      try {
        const s = await adb
          .collection("events")
          .where("userId", "==", tenant)
          .where("type", "==", type)
          .where("date", ">=", sinceStr)
          .get();
        out.push(...s.docs);
      } catch (e) {
        console.log("⚠️ fetchType error", type, e.message);
      }
      return out.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    }

    const [ins, preg] = await Promise.all([
      fetchType("insemination"),
      fetchType("pregnancy"),
    ]);

    const insWin = ins.filter(
      (e) =>
        activeIds.has(String(e.animalId || "").trim()) &&
        toDate(e.date || e.createdAt) >= winStart
    );
    const pregPos = preg.filter(
      (e) =>
        activeIds.has(String(e.animalId || "").trim()) &&
        /preg|positive|حمل|ايجاب/i.test(
          String(e.result || e.status || e.outcome || "")
        )
    );

    const pregSet = new Set(
      pregPos.map((e) => String(e.animalId || "").trim()).filter(Boolean)
    );
    const openCount = Math.max(0, totalActive - pregSet.size);
    const insAnimals = new Set(
      insWin.map((e) => String(e.animalId || "").trim()).filter(Boolean)
    );
    const conceptionRate = insWin.length
      ? +(
          (pregPos.filter(
            (e) => toDate(e.date || e.createdAt) >= winStart
          ).length /
            insWin.length) *
          100
        ).toFixed(1)
      : 0;

    res.json({
      ok: true,
      totals: {
        totalActive,
        pregnant: {
          count: pregSet.size,
          pct: +((pregSet.size / totalActive) * 100).toFixed(1),
        },
        inseminated: {
          count: insAnimals.size,
          pct: +((insAnimals.size / totalActive) * 100).toFixed(1),
        },
        open: {
          count: openCount,
          pct: +((openCount / totalActive) * 100).toFixed(1),
        },
      },
      fertility: { conceptionRatePct: conceptionRate },
    });
  } catch (e) {
    console.error("❌ herd-stats error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// ============================================================
//                 API: ANIMALS (for dashboard summary)
// ============================================================
app.get("/api/animals", async (req, res) => {
  try {
    const tenant = req.headers["x-user-id"] || req.query.userId;
    if (!tenant) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!db) return res.status(500).json({ ok: false, error: "firestore_not_ready" });

    let animalsDocs = [];
    const snap1 = await db
      .collectionGroup("animals")
      .where("ownerUid", "==", tenant)
      .get();
    animalsDocs = snap1.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (animalsDocs.length === 0) {
      const snap2 = await db
        .collectionGroup("animals")
        .where("userId", "==", tenant)
        .get();
      animalsDocs = snap2.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    res.json({ ok: true, animals: animalsDocs });
  } catch (e) {
    console.error("❌ /api/animals error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
//                       STATIC FRONTEND
// ============================================================
app.use(express.static(path.join(__dirname, "www")));
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
