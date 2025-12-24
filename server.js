import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CORS for Flutter Web / browsers =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ===== Helpers =====
function getApiKey(req) {
  return req.headers["x-api-key"] || req.headers["key"] || "";
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ===== Firebase Admin init =====
let firebaseInited = false;

function initFirebaseOnce() {
  if (firebaseInited) return;

  const raw = mustEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  const serviceAccount = typeof raw === "string" ? JSON.parse(raw) : raw;

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  firebaseInited = true;
}

// ===== Routes =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "issam-law-tasks-push-server",
    now: new Date().toISOString(),
  });
});

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
      data: data
        ? Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          )
        : undefined,
    };

    const id = await admin.messaging().send(message);
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
