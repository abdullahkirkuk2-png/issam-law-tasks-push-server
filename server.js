// server.js
import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ========= Helpers =========
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getApiKey(req) {
  // supports: x-api-key OR api_key OR key
  return (
    req.header("x-api-key") ||
    req.header("api_key") ||
    req.header("key") ||
    req.query.api_key ||
    req.query.key
  );
}

let _firebaseInited = false;
function initFirebaseOnce() {
  if (_firebaseInited) return;
  _firebaseInited = true;

  const projectId = mustEnv("FIREBASE_PROJECT_ID");
  const saJsonStr = mustEnv("FIREBASE_SERVICE_ACCOUNT_JSON");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(saJsonStr);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId,
  });
}

async function sendToMany(tokens, payload) {
  // FCM يسمح حتى 500 توكن بالدفعة الواحدة
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) {
    chunks.push(tokens.slice(i, i + 500));
  }

  let success = 0;
  let failure = 0;

  for (const chunk of chunks) {
    const resp = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      ...payload,
    });

    success += resp.successCount;
    failure += resp.failureCount;
  }

  return { success, failure };
}

// ========= Routes =========
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "issam-law-tasks-push-server",
    now: new Date().toISOString(),
  });
});

// POST /send  (ارسال لتوكن واحد)
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

    const message = {
      token: to,
      notification: {
        title: title || "Notification",
        body: body || "",
      },
      data: data || {},
      android: { priority: "high" },
    };

    const id = await admin.messaging().send(message);
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /send_admins  (ارسال لكل الأدمنية عدا المُرسل)
// Body مثال:
// { "senderEmail":"abdullah.kirkuk2@gmail.com", "text":"hello" }
app.post("/send_admins", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    const expected = mustEnv("API_KEY");
    if (!apiKey || apiKey !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    initFirebaseOnce();

    const { senderEmail, text } = req.body || {};
    if (!senderEmail || !text) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing senderEmail/text" });
    }

    // نجيب توكنات الأدمنية من fcm_tokens
    const db = admin.firestore();
    const snap = await db
      .collection("fcm_tokens")
      .where("role", "==", "admin")
      .get();

    const tokens = [];
    snap.forEach((doc) => {
      const email = doc.get("email");
      const token = doc.get("token");
      if (!token) return;

      // استثناء المُرسل
      if (email && email === senderEmail) return;

      tokens.push(token);
    });

    if (tokens.length === 0) {
      return res.json({ ok: true, sent: 0, note: "No admin tokens" });
    }

    const short = String(text).slice(0, 120);

    const payload = {
      notification: {
        title: "رسالة جديدة في شات الأدمنية",
        body: short,
      },
      data: {
        type: "admin_chat",
        senderEmail: String(senderEmail),
      },
      android: { priority: "high" },
    };

    const result = await sendToMany(tokens, payload);
    return res.json({ ok: true, total: tokens.length, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ========= Start =========
const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server listening on", port));
