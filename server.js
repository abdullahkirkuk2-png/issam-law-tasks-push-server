import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

// Render يحدد المنفذ في PORT
const PORT = process.env.PORT || 3000;

// ---------- Firebase Admin init ----------
/**
 * راح نخزن مفتاح الـ Service Account داخل Render كـ ENV variable اسمها:
 * FIREBASE_SERVICE_ACCOUNT_JSON
 * (محتواها JSON كامل)
 */
function initFirebase() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT_JSON env var. Add it in Render Environment Variables."
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function db() {
  initFirebase();
  return admin.firestore();
}

// ---------- Helpers ----------
function uniqStrings(arr) {
  return Array.from(
    new Set((arr || []).map((x) => String(x || "").trim()).filter((x) => x.length > 0))
  );
}

function isCompletionStatus(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return s === "completed" || s === "done" || s === "finished";
}

function normalizeValue(v) {
  if (v && typeof v === "object" && typeof v.toMillis === "function") {
    return { __ts: v.toMillis() };
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalizeValue(v[k]);
    return out;
  }
  return v;
}

function shallowChangedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const k of keys) {
    const a = normalizeValue(before?.[k]);
    const b = normalizeValue(after?.[k]);
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
  }
  return changed;
}

async function getAdminTokens() {
  const snap = await db().collection("fcm_tokens").where("role", "==", "admin").get();
  const tokens = [];
  snap.forEach((d) => {
    const t = String(d.data()?.token || "").trim();
    if (t) tokens.push(t);
  });
  return Array.from(new Set(tokens));
}

async function getLawyerUidsByUsernames(usernames) {
  // lawyer_uids: docId = uid, field: username
  const map = new Map(); // username -> uid
  const names = uniqStrings(usernames);
  if (!names.length) return map;

  // Firestore "in" limit: 30 in newer SDKs; نخليها chunks 30
  for (let i = 0; i < names.length; i += 30) {
    const chunk = names.slice(i, i + 30);
    const snap = await db().collection("lawyer_uids").where("username", "in", chunk).get();
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const u = String(data.username || "").trim();
      if (u) map.set(u, doc.id);
    });
  }
  return map;
}

async function getTokensByUids(uids) {
  const uniqUids = Array.from(new Set((uids || []).filter(Boolean)));
  if (!uniqUids.length) return [];

  const refs = uniqUids.map((uid) => db().collection("fcm_tokens").doc(uid));
  const snaps = await db().getAll(...refs);

  const tokens = [];
  for (const s of snaps) {
    if (!s.exists) continue;
    const t = String(s.data()?.token || "").trim();
    if (t) tokens.push(t);
  }
  return Array.from(new Set(tokens));
}

async function createInAppNotification({ toRole, toUsername, title, body, meta }) {
  await db().collection("notifications").add({
    toRole: toRole || null,
    toUsername: toUsername || null,
    title: title || "",
    body: body || "",
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    meta: meta || {},
  });
}

function stringifyData(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = v == null ? "" : String(v);
  return out;
}

async function sendPush(tokens, { title, body }, dataObj) {
  if (!tokens || tokens.length === 0) return;

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: title || "", body: body || "" },
    data: stringifyData(dataObj),
    android: {
      priority: "high",
      notification: { channelId: "default_channel" },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default" } },
    },
  });
}

// ---------- Core processor ----------
/**
 * payload:
 * { type: "created"|"updated", taskId: "...", before?: {...}, after: {...} }
 */
async function processTaskEvent(payload) {
  const type = payload?.type;
  const taskId = String(payload?.taskId || "").trim();
  const after = payload?.after || {};
  const before = payload?.before || {};

  if (!type || !taskId) throw new Error("Missing type or taskId.");

  const visibleTo = uniqStrings(after.visibleTo);
  const assigneeUsername = String(after.assigneeUsername || "").trim();
  const recipients = visibleTo.length ? visibleTo : (assigneeUsername ? [assigneeUsername] : []);

  const groupName = String(after.groupName || "").trim();
  const titleText = String(after.title || "").trim();

  if (type === "created") {
    if (!recipients.length) return { ok: true, sent: 0 };

    const notifTitle = groupName ? "مهمة كروب جديدة" : "مهمة جديدة";
    const notifBody = titleText ? `تم إرسال مهمة: ${titleText}` : "تم إرسال مهمة جديدة";

    const uidMap = await getLawyerUidsByUsernames(recipients);
    let sent = 0;

    for (const username of recipients) {
      await createInAppNotification({
        toRole: "lawyer",
        toUsername: username,
        title: notifTitle,
        body: notifBody,
        meta: { kind: "task_created", taskId, groupName, assigneeUsername, status: after.status || null },
      });

      const uid = uidMap.get(username);
      if (!uid) continue;

      const tokens = await getTokensByUids([uid]);
      if (tokens.length) {
        await sendPush(tokens, { title: notifTitle, body: notifBody }, { kind: "task_created", taskId, toUsername: username });
        sent += tokens.length;
      }
    }
    return { ok: true, sent };
  }

  if (type === "updated") {
    // 1) completion -> admin
    const statusCompletedNow = !isCompletionStatus(before.status) && isCompletionStatus(after.status);
    const completionNow = (before.completion == null) && (after.completion != null);

    if (statusCompletedNow || completionNow) {
      const notifTitle = "تم إكمال مهمة";
      const notifBody = titleText
        ? `تم إكمال المهمة: ${titleText}${assigneeUsername ? " (" + assigneeUsername + ")" : ""}`
        : "تم إكمال مهمة";

      await createInAppNotification({
        toRole: "admin",
        toUsername: null,
        title: notifTitle,
        body: notifBody,
        meta: { kind: "task_completed", taskId, groupName, assigneeUsername, status: after.status || null },
      });

      const adminTokens = await getAdminTokens();
      await sendPush(adminTokens, { title: notifTitle, body: notifBody }, { kind: "task_completed", taskId, assigneeUsername });
      return { ok: true, sent: adminTokens.length };
    }

    // 2) admin update -> lawyers
    const changed = shallowChangedKeys(before, after);
    const lawyerOnlyKeys = new Set(["status", "completion", "updatedAt"]);
    const adminChangedKeys = changed.filter((k) => !lawyerOnlyKeys.has(k));

    if (!adminChangedKeys.length) return { ok: true, sent: 0 };
    if (!recipients.length) return { ok: true, sent: 0 };

    const notifTitle = "تم تعديل مهمة";
    const notifBody = titleText ? `تم تعديل المهمة: ${titleText}` : "تم تعديل مهمة";

    const uidMap = await getLawyerUidsByUsernames(recipients);
    let sent = 0;

    for (const username of recipients) {
      await createInAppNotification({
        toRole: "lawyer",
        toUsername: username,
        title: notifTitle,
        body: notifBody,
        meta: { kind: "task_updated", taskId, groupName, assigneeUsername, changedKeys: adminChangedKeys, status: after.status || null },
      });

      const uid = uidMap.get(username);
      if (!uid) continue;

      const tokens = await getTokensByUids([uid]);
      if (tokens.length) {
        await sendPush(tokens, { title: notifTitle, body: notifBody }, { kind: "task_updated", taskId, toUsername: username });
        sent += tokens.length;
      }
    }

    return { ok: true, sent };
  }

  throw new Error("Unknown type.");
}

// ---------- Routes ----------
app.get("/", (req, res) => res.status(200).send("OK"));

/**
 * Endpoint نناديه من داخل تطبيق Flutter (مؤقتاً) أو من لوحة أدمن لاحقاً
 * Body: { type, taskId, before?, after }
 * Header: x-api-key: <API_KEY>
 */
app.post("/task-event", async (req, res) => {
  try {
    const apiKey = process.env.API_KEY || "";
    const got = String(req.headers["x-api-key"] || "");
    if (!apiKey || got !== apiKey) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const result = await processTaskEvent(req.body);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
