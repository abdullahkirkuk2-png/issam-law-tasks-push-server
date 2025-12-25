import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing env var: ${name}`);
  return v.trim();
}

function getApiKey(req) {
  return (
    req.get("x-api-key") ||
    req.get("X-API-KEY") ||
    req.get("x-api_key") ||
    req.get("api-key") ||
    ""
  ).trim();
}

let firebaseInited = false;

function initFirebaseOnce() {
  if (firebaseInited) return;

  const raw = mustEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  admin.initializeApp({
    credential: admin.credential.cert(creds),
  });

  firebaseInited = true;
}

function normalizeData(data) {
  const out = {};
  if (!data || typeof data !== "object") return out;
  for (const [k, v] of Object.entries(data)) out[k] = String(v);
  return out;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "issam-law-tasks-push-server", now: new Date().toISOString() });
});

// ✅ إرسال لتوكن واحد (مثل اللي مجربه)
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
        title: (title ?? "تنبيه").toString(),
        body: (body ?? "").toString(),
      },
      data: normalizeData(data),
    };

    const id = await admin.messaging().send(message);
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ إرسال لكل الأدمنات (role == 'admin') من fcm_tokens
app.post("/send_admins", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    const expected = mustEnv("API_KEY");
    if (!apiKey || apiKey !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    initFirebaseOnce();

    const { title, body, data } = req.body || {};

    const snap = await admin
      .firestore()
      .collection("fcm_tokens")
      .where("role", "==", "admin")
      .get();

    const tokens = Array.from(
      new Set(
        snap.docs
          .map((d) => (d.data()?.token ?? "").toString().trim())
          .filter((t) => t.length > 0)
      )
    );

    if (tokens.length === 0) {
      return res.status(404).json({ ok: false, error: "No admin tokens found" });
    }

    const message = {
      tokens,
      notification: {
        title: (title ?? "رسالة للأدمن").toString(),
        body: (body ?? "").toString(),
      },
      data: normalizeData(data),
    };

    // firebase-admin v13 يدعم sendEachForMulticast
    const resp = await admin.messaging().sendEachForMulticast(message);

    return res.json({
      ok: true,
      total: tokens.length,
      success: resp.successCount,
      failure: resp.failureCount,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("Server listening on:", port);
});
