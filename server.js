import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Small CORS (بدون مكتبة cors) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// --- Helpers ---
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getApiKey(req) {
  // نقبل أكثر من شكل حتى ما تلخبط:
  // Header: x-api-key أو key
  // Query: ?key=
  return (
    req.headers["x-api-key"] ||
    req.headers["key"] ||
    req.query.key ||
    ""
  );
}

let firebaseReady = false;
function initFirebaseOnce() {
  if (firebaseReady) return;

  const saRaw = mustEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  const serviceAccount = JSON.parse(saRaw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
  });

  firebaseReady = true;
}

function toStringMap(obj) {
  // FCM data لازم تكون Strings
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    out[String(k)] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

// --- Routes ---
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "issam-law-tasks-push-server",
    now: new Date().toISOString(),
  });
});

// إرسال لتوكن واحد
app.post("/send", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    const expected = mustEnv("API_KEY");
    if (!apiKey || apiKey !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    initFirebaseOnce();

    const { to, title, body, data } = req.body || {};
    if (!to || typeof to !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'to' token" });
    }

    const msg = {
      token: to,
      notification: {
        title: title || "Notification",
        body: body || "",
      },
      data: toStringMap(data),
    };

    const id = await admin.messaging().send(msg);
    return res.json({ ok: true, messageId: id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// إرسال لكل الأدمن (حسب fcm_tokens.role == "admin")
app.post("/send_admins", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    const expected = mustEnv("API_KEY");
    if (!apiKey || apiKey !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    initFirebaseOnce();

    const { title, body, data, excludeUid, excludeEmail } = req.body || {};

    const snap = await admin
      .firestore()
      .collection("fcm_tokens")
      .where("role", "==", "admin")
      .get();

    let tokens = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const t = d.token;
      const uid = d.uid;
      const email = d.email;

      if (excludeUid && uid === excludeUid) return;
      if (excludeEmail && email === excludeEmail) return;

      if (t && typeof t === "string") tokens.push(t);
    });

    // إزالة التكرار
    tokens = [...new Set(tokens)];

    if (tokens.length === 0) {
      return res.json({ ok: true, total: 0, success: 0, failure: 0 });
    }

    const multicast = {
      tokens,
      notification: {
        title: title || "Admin Chat",
        body: body || "New message",
      },
      data: toStringMap(data),
    };

    const r = await admin.messaging().sendEachForMulticast(multicast);
    return res.json({
      ok: true,
      total: tokens.length,
      success: r.successCount,
      failure: r.failureCount,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server listening on", port));
