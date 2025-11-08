// server.js — نسخة مبسطة 100% (تشتغل على Render بدون مشاكل)
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, where, getDocs, addDoc, serverTimestamp } from "firebase/firestore";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== تحديد المسار للملفات الثابتة =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "www")));

// ===== Firebase Client SDK =====
const firebaseConfig = {
  apiKey: process.env.FB_API_KEY,
  authDomain: process.env.FB_AUTH_DOMAIN,
  projectId: process.env.FB_PROJECT_ID,
  appId: process.env.FB_APP_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, "murabbikdata");
console.log("✅ Connected to Firestore (murabbikdata)");

// ===== API Routes =====
app.get("/api/animals", async (req, res) => {
  try {
    const userId = req.header("X-User-Id") || req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const q = query(collection(db, "animals"), where("userId", "==", userId));
    const snapshot = await getDocs(q);
    res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch animals" });
  }
});

app.post("/api/events", async (req, res) => {
  try {
    const data = req.body;
    if (!data.userId) return res.status(400).json({ error: "Missing userId" });
    data.createdAt = serverTimestamp();
    const docRef = await addDoc(collection(db, "events"), data);
    res.json({ success: true, id: docRef.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add event" });
  }
});

app.get("/api/herd-stats", async (req, res) => {
  try {
    const userId = req.header("X-User-Id") || req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const aSnap = await getDocs(query(collection(db, "animals"), where("userId", "==", userId)));
    const eSnap = await getDocs(query(collection(db, "events"), where("userId", "==", userId)));

    res.json({ animalsCount: aSnap.size, eventsCount: eSnap.size });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "www", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Murabbik server running on port ${PORT}`));
