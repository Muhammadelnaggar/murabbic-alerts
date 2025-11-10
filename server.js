// server.js — Murabbik stable tenant build (Firestore murabbikdata)
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Local fallback ----------
const dataDir = path.join(__dirname, "data");
const animalsPath = path.join(dataDir, "animals.json");
const eventsPath = path.join(dataDir, "events.json");
const alertsPath = path.join(dataDir, "alerts.json");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
function readJson(p, f = []) {
  try {
    return fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, "utf8") || "[]")
      : f;
  } catch {
    return f;
  }
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Firebase ----------
let db = null;
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: sa
        ? admin.credential.cert(sa)
        : admin.credential.applicationDefault(),
    });
  }
  db = admin.firestore(admin.app());
  console.log("✅ Firestore connected:", db._databaseId?.database || "(default)");
} catch (e) {
  console.log("⚠️ Firestore disabled:", e.message);
}

// ---------- Helpers ----------
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
const tenantKey = (v) => (!v ? "DEFAULT" : String(v));
function resolveTenant(req) {
  return tenantKey(req.headers["x-user-id"] || req.query.userId || "DEFAULT");
}
function belongs(rec, tenant) {
  const t = rec && rec.userId ? rec.userId : "DEFAULT";
  return tenantKey(t) === tenantKey(tenant);
}
function requireUserId(req, res, next) {
  const t = resolveTenant(req);
  if (!t || t === "DEFAULT")
    return res.status(400).json({ ok: false, error: "userId_required" });
  req.userId = t;
  next();
}

// ============================================================
// EVENTS
// ============================================================
app.post("/api/events", requireUserId, async (req, res) => {
  try {
    const event = req.body || {};
    const tenant = req.userId;
    event.userId = tenant;

    if (!event.type || !event.animalId)
      return res.status(400).json({ ok: false, error: "missing_fields" });

    const events = readJson(eventsPath, []);
    event.id = events.length + 1;
    if (!event.ts) event.ts = Date.now();
    events.push(event);
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

    if (db) {
      const t = String(event.type || "").toLowerCase();
      const typeNorm =
        t.includes("insemin") || t.includes("تلقيح")
          ? "insemination"
          : t.includes("preg") || t.includes("حمل")
          ? "pregnancy"
          : t.includes("calv") || t.includes("ولادة")
          ? "birth"
          : t.includes("heat") || t.includes("شياع")
          ? "heat"
          : "event";
      const whenMs = Number(event.ts || Date.now());
      const doc = {
        userId: tenant,
        animalId: String(event.animalId || ""),
        type: typeNorm,
        date: toYYYYMMDD(whenMs),
        createdAt: admin.firestore.Timestamp.fromMillis(whenMs),
        species: (event.species || "buffalo").toLowerCase(),
        result: event.result || event.status || "",
        note: event.note || "",
      };
      try {
        await db.collection("events").add(doc);
      } catch {}
    }

    res.json({ ok: true, event });
  } catch (e) {
    console.error("events", e);
    res.status(500).json({ ok: false, error: "failed_to_save_event" });
  }
});

// ============================================================
// HERD STATS
// ============================================================
app.get("/api/herd-stats", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    console.log("🔥 Querying animals for tenant:", tenant);

    const analysisDays = parseInt(req.query.analysisDays || "90", 10);

    if (db) {
      const adb = db;
      let animalsDocs = [];
      try {
        animalsDocs = (
          await adb.collection("animals").where("userId", "==", tenant).get()
        ).docs.slice();
      } catch (err) {
        console.error("animals query failed", err);
      }

      const animals = animalsDocs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      const active = animals.filter(
        (a) =>
          a &&
          a.active !== false &&
          !["sold", "dead", "archived", "inactive"].includes(
            String(a.status || "").toLowerCase()
          )
      );
      const totalActive = active.length;

      const since = new Date(Date.now() - (analysisDays + 340) * dayMs);
      const sinceStr = toYYYYMMDD(since);

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
        } catch {}
        return out.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      }

      const [ins, preg] = await Promise.all([
        fetchType("insemination"),
        fetchType("pregnancy"),
      ]);

      const activeIds = new Set(active.map((a) => String(a.id)));
      const winStart = new Date(Date.now() - analysisDays * dayMs);

      const insWin = ins.filter(
        (e) =>
          activeIds.has(String(e.animalId)) &&
          toDate(e.date || e.createdAt) >= winStart
      );
      const pregPos = preg.filter(
        (e) =>
          activeIds.has(String(e.animalId)) &&
          /preg|positive|حمل|ايجاب/i.test(
            String(e.result || e.status || e.outcome || "")
          )
      );

      const pregSet = new Set(pregPos.map((e) => String(e.animalId)));
      const openCount = Math.max(0, totalActive - pregSet.size);
      const conceptionRate = insWin.length
        ? +(
            (pregPos.filter(
              (e) => toDate(e.date || e.createdAt) >= winStart
            ).length /
              insWin.length) *
            100
          ).toFixed(1)
        : 0;

      return res.json({
        ok: true,
        totals: {
          totalActive,
          pregnant: {
            count: pregSet.size,
            pct: totalActive
              ? +((pregSet.size / totalActive) * 100).toFixed(1)
              : 0,
          },
          inseminated: {
            count: new Set(insWin.map((e) => String(e.animalId))).size,
            pct: totalActive
              ? +(
                  (new Set(insWin.map((e) => String(e.animalId))).size /
                    totalActive) *
                  100
                ).toFixed(1)
              : 0,
          },
          open: {
            count: openCount,
            pct: totalActive
              ? +((openCount / totalActive) * 100).toFixed(1)
              : 0,
          },
        },
        fertility: { conceptionRatePct: conceptionRate },
      });
    } else {
      // fallback local
      const animalsAll = readJson(animalsPath, []).filter((a) =>
        belongs(a, tenant)
      );
      const active = animalsAll.filter(
        (a) =>
          a.active !== false &&
          !["sold", "dead", "archived", "inactive"].includes(
            String(a.status || "").toLowerCase()
          )
      );
      const totalActive = active.length;

      const evAll = readJson(eventsPath, []).filter((e) =>
        belongs(e, tenant)
      );
      const winStart = new Date(Date.now() - analysisDays * dayMs);
      const insWin = evAll.filter(
        (e) =>
          /insemination|تلقيح/i.test(e.type || "") &&
          toDate(e.ts || e.date) >= winStart
      );
      const pregPos = evAll.filter(
        (e) =>
          /pregnancy|حمل/i.test(e.type || "") &&
          /positive|ايجاب/i.test(
            String(e.result || e.status || e.outcome || "")
          )
      );

      const pregSet = new Set(pregPos.map((e) => String(e.animalId)));
      const openCount = Math.max(0, totalActive - pregSet.size);
      const conceptionRate = insWin.length
        ? +(
            (pregPos.filter((e) => toDate(e.ts || e.date) >= winStart).length /
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
            pct: totalActive
              ? +((pregSet.size / totalActive) * 100).toFixed(1)
              : 0,
          },
          inseminated: {
            count: new Set(insWin.map((e) => String(e.animalId))).size,
            pct: totalActive
              ? +(
                  (new Set(insWin.map((e) => String(e.animalId))).size /
                    totalActive) *
                  100
                ).toFixed(1)
              : 0,
          },
          open: {
            count: openCount,
            pct: totalActive
              ? +((openCount / totalActive) * 100).toFixed(1)
              : 0,
          },
        },
        fertility: { conceptionRatePct: conceptionRate },
      });
    }
  } catch (e) {
    console.error("herd-stats", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// ANIMALS
// ============================================================
app.get("/api/animals", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    console.log("🐄 Fetching animals for user:", tenant);

    if (db) {
      const adb = db;
      const seen = new Map();
      const push = (d) =>
        d && d.exists && seen.set(d.ref.path, { id: d.id, ...d.data() });

      try {
        const snap = await adb
          .collection("animals")
          .where("userId", "==", tenant)
          .limit(2000)
          .get();
        snap.docs.forEach(push);
      } catch (err) {
        console.error("animals fetch failed", err);
      }

      const arr = [...seen.values()];
      arr.sort((a, b) =>
        String(a.number || "").localeCompare(String(b.number || ""), "en", {
          numeric: true,
        })
      );
      return res.json(arr);
    }

    // fallback
    const animalsAll = readJson(animalsPath, []).filter((a) =>
      belongs(a, tenant)
    );
    return res.json(animalsAll);
  } catch (e) {
    console.error("animals list", e);
    return res.status(500).json({ ok: false, error: "animals_failed" });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/sensors/health", async (_req, res) => {
  if (!db)
    return res
      .status(503)
      .json({ ok: false, error: "sensors_api_disabled" });
  try {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const snap = await db
      .collection("devices")
      .where("lastSeen", ">=", tenMinAgo)
      .get();
    const count = snap.docs
      .map((d) => (d.data().type || "").toLowerCase())
      .filter((t) => t !== "env" && t !== "thi").length;
    return res.json({ ok: true, devices: count });
  } catch {
    return res.status(500).json({ ok: false, error: "health_failed" });
  }
});

// ============================================================
// STATIC + START
// ============================================================
app.use(express.static(path.join(__dirname, "www")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "www", "index.html"))
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
