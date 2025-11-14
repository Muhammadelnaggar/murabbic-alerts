// ================================================
//           Murabbik — server.js (FINAL)
// ================================================
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- Local fallback ----------------
const dataDir     = path.join(__dirname, "data");
const animalsPath = path.join(dataDir, "animals.json");
const eventsPath  = path.join(dataDir, "events.json");
const alertsPath  = path.join(dataDir, "alerts.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
function readJson(p, fallback = []) {
  try {
    return fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, "utf8") || "[]")
      : fallback;
  } catch {
    return fallback;
  }
}

// ---------------- Middleware ----------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ================================================
//        Firebase Admin (Render Secret File)
// ================================================
let db = null;
try {
  const sa = require("/etc/secrets/murabbik-470511-firebase-adminsdk-fbsvc-650a6ab6ef.json");

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        privateKey: sa.private_key
      }),
      projectId: sa.project_id,
      
    });
  }

  db = admin.firestore(admin.app(), "murabbikdata");
  console.log("🔥 Admin SDK connected to murabbikdata");

} catch (e) {
  console.log("⚠️ Firestore Admin disabled:", e.message);
}


// ================================================
//                  Helpers
// ================================================
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

function tenantKey(v) {
  return !v ? "DEFAULT" : String(v);
}

function resolveTenant(req) {
  const uid =
    req.get("X-User-Id") ||
    req.headers["x-user-id"] ||
    req.query.userId ||
    process.env.DEFAULT_TENANT_ID ||
    "DEFAULT";
  return tenantKey(uid);
}

function belongs(rec, tenant) {
  const t = rec && (rec.userId || rec.farmId) || "DEFAULT";
  return tenantKey(t) === tenantKey(tenant);
}

function requireUserId(req, res, next) {
  const t = resolveTenant(req);
  if (!t || t === "DEFAULT") {
    return res.status(400).json({ ok: false, error: "userId_required" });
  }
  req.userId = t;
  next();
}


// ================================================
//                API: EVENTS (OK)
// ================================================
app.post("/api/events", requireUserId, async (req, res) => {
  try {
    const event = req.body || {};
    const tenant = req.userId;

    if (!event.type || !event.animalId) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // local fallback save
    const events = readJson(eventsPath, []);
    event.id = events.length + 1;
    event.userId = tenant;
    event.farmId = tenant;
    if (!event.ts) event.ts = Date.now();
    events.push(event);
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

    // Firestore write
    if (db) {
      const when = Number(event.ts || Date.now());
      const doc = {
        userId: tenant,
        farmId: tenant,
        animalId: String(event.animalId),
        eventType: String(event.type).toLowerCase(),
        eventDate: toYYYYMMDD(when),
        createdAt: admin.firestore.Timestamp.fromMillis(when),
        species: (event.species || "buffalo").toLowerCase(),
        result: event.result || event.status || "",
        note: event.note || ""
      };
      await db.collection("events").add(doc);
    }

    res.json({ ok: true, event });

  } catch (e) {
    console.error("events", e);
    res.status(500).json({ ok: false, error: "failed_to_save_event" });
  }
});


// ================================================
//               API: ANIMALS (CLEAN)
// ================================================
app.get("/api/animals", async (req, res) => {
  try {
    const tenant = resolveTenant(req);

    // local fallback
    if (!db) {
      const animals = readJson(animalsPath, []).filter(a => belongs(a, tenant));
      return res.json({ ok: true, animals });
    }

    // Firestore
    const snap = await db.collection("animals")
      .where("userId", "==", tenant)
      .limit(2000)
      .get();

    const animals = snap.docs.map(d => ({
      id: d.id,
      ...(d.data() || {})
    }));

    return res.json({ ok: true, animals });

  } catch (e) {
    console.error("animals", e);
    res.status(500).json({ ok: false, error: "animals_failed" });
  }
});


// ================================================
//              API: HERD STATS (OK)
// ================================================
app.get("/api/herd-stats", async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const analysisDays = parseInt(req.query.analysisDays || "90", 10);

    if (!db) {
      return res.json({ ok: false, error: "firestore_disabled" });
    }

    const adb = db;

    // animals
    const snap = await adb.collection("animals")
      .where("userId", "==", tenant)
      .limit(2000)
      .get();

    const animals = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    const totalActive = animals.length;

    // window
    const winStart = new Date(Date.now() - analysisDays * dayMs);
    const winStr = toYYYYMMDD(winStart);

    // events
    const evSnap = await adb.collection("events")
      .where("userId", "==", tenant)
      .where("eventDate", ">=", winStr)
      .limit(5000)
      .get();

    const events = evSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

    const ins = events.filter(e => e.eventType === "insemination");
    const preg = events.filter(e => e.eventType === "pregnancy");

    const activeIds = new Set(animals.map(a => String(a.id)));

    const insWin = ins.filter(e => activeIds.has(String(e.animalId)));
    const pregPos = preg.filter(e =>
      activeIds.has(String(e.animalId)) &&
      /preg|positive|حمل|ايجاب/i.test(String(e.result || ""))
    );

    const pregSet = new Set(pregPos.map(e => String(e.animalId)));
    const openCount = Math.max(0, totalActive - pregSet.size);
    const conceptionRate =
      insWin.length
        ? +((pregPos.length / insWin.length) * 100).toFixed(1)
        : 0;

    return res.json({
      ok: true,
      totals: {
        totalActive,
        pregnant: {
          count: pregSet.size,
          pct: totalActive ? +((pregSet.size / totalActive) * 100).toFixed(1) : 0
        },
        inseminated: {
          count: new Set(insWin.map(e => String(e.animalId))).size,
          pct: totalActive
            ? +(
                (new Set(insWin.map(e => String(e.animalId))).size /
                  totalActive) *
                100
              ).toFixed(1)
            : 0
        },
        open: {
          count: openCount,
          pct: totalActive
            ? +((openCount / totalActive) * 100).toFixed(1)
            : 0
        }
      },
      fertility: {
        conceptionRatePct: conceptionRate
      }
    });

  } catch (e) {
    console.error("herd-stats", e);
    res.status(500).json({ ok: false, error: "herd_stats_failed" });
  }
});


// ================================================
//          API: SENSORS HEALTH (OK)
// ================================================
app.get("/api/sensors/health", async (_req, res) => {
  if (!db) return res.status(503).json({ ok:false, error:"disabled" });

  try {
    const tenMin = Date.now() - 10 * 60 * 1000;

    const snap = await db.collection("devices")
      .where("lastSeen", ">=", tenMin)
      .get();

    const count = snap.docs
      .map(d => (d.data().type || "").toLowerCase())
      .filter(t => t !== "env" && t !== "thi").length;

    return res.json({ ok: true, devices: count });

  } catch (e) {
    return res.status(500).json({ ok:false, error:"health_failed" });
  }
});


// ================================================
//         STATIC + ROOT + START SERVER
// ================================================
app.use(express.static(path.join(__dirname, "www")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "www", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
