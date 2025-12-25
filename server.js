import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ========= Helpers =========
function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env: ${name}`);
  return String(v);
}

function getApiKey(req) {
  const h = req.headers["x-api-key"] || req.headers["key"] || req.query.key || "";
  return String(h).trim();
}

let firebaseReady = false;
function initFirebaseOnce() {
  if (firebaseReady) return;

  const raw = mustEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
  });

  firebaseReady = true;
}

function toStringMap(data) {
  const out = {};
  if (!data || typeof data !== "object") return out;
  for (const [k, v] of Object.entries(data)) out[String(k)] = String(v);
  return out;
}

async function sendMulticast(tokens, title, body, data) {
  initFirebaseOnce();

  const uniq = [...new Set(tokens.filter(Boolean).map(String))];
  if (uniq.length === 0) return { ok: false, error: "No tokens" };

  const chunks = [];
  for (let i = 0; i < uniq.length; i += 500) chunks.push(uniq.slice(i, i + 500));

  let success = 0;
  let failure = 0;

  for (const ch of chunks) {
    const r = await admin.messaging().sendEachForMulticast({
      tokens: ch,
      notification: { title: String(title || "Notification"), body: String(body || "") },
      data: toStringMap(data),
      android: { priority: "high" },
    });
    success += r.successCount || 0;
    failure += r.failureCount || 0;
  }

  return { ok: true, total: uniq.length, success, failure };
}

// ========= Routes =========
app.get("/", (req, res) => {
  res.json({ ok: true, service: "issam-law-tasks-push-server", now: new Date().toISOString() });
});

// 1) إرسال لتوكن واحد (للاختبار)
app.post("/send", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    const expected = mustEnv("API_KEY");
    if (!apiKey || apiKey !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

    initFirebaseOnce();

    const { to, title, body, data } = req.body || {};
    if (!to || typeof to !== "string") return res.status(400).json({ ok: false, error: "Missing 'to' token" });

    const id = await admin.messaging().send({
      token: to,
      notification: { title: String(title || "Notification"), body: String(body || "") },
      data: toStringMap(data),
      android: { priority: "high" },
    });

    return res.json({ ok: true, messageId: id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 2) إرسال لكل الأدمنية (يعتمد على fcm_tokens.role == "admin")
app.post("/send_admins", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    const expected = mustEnv("API_KEY");
    if (!apiKey || apiKey !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

    initFirebaseOnce();

    const { title, body, data, excludeEmail, excludeUid } = req.body || {};

    const snap = await admin.firestore().collection("fcm_tokens").where("role", "==", "admin").get();

    const tokens = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (excludeEmail && String(d.email || "").toLowerCase() === String(excludeEmail).toLowerCase()) return;
      if (excludeUid && String(d.uid || "") === String(excludeUid)) return;
      if (d.token) tokens.push(String(d.token));
    });

    const r = await sendMulticast(tokens, title || "Admin", body || "", data || {});
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 3) ✅ الجديد: إرسال حسب usernames (للمهام الفردية/الكروب)
// Body مثال:
// { "usernames":["ali","ahmed"], "title":"...", "body":"...", "data":{...} }
app.post("/send_usernames", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    const expected = mustEnv("API_KEY");
    if (!apiKey || apiKey !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

    initFirebaseOnce();

    const { usernames, title, body, data } = req.body || {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ ok: false, error: "Missing usernames[]" });
    }

    // normalize usernames to lowercase
    const list = [...new Set(usernames.map(u => String(u || "").trim().toLowerCase()).filter(Boolean))];
    if (list.length === 0) return res.status(400).json({ ok: false, error: "Empty usernames[]" });

    const db = admin.firestore();
    const col = db.collection("fcm_tokens");

    const tokens = [];
    // Firestore IN limit = 10
    for (let i = 0; i < list.length; i += 10) {
      const chunk = list.slice(i, i + 10);
      const snap = await col.where("username", "in", chunk).get();
      snap.forEach(doc => {
        const d = doc.data() || {};
        if (d.token) tokens.push(String(d.token));
      });
    }

    const r = await sendMulticast(tokens, title || "Task", body || "", data || {});
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server listening on", port));
