// clawme-gmail transform
//
// Loaded by the OpenClaw hook system when the platform POSTs to /hooks/clawme-gmail.
// Context shape: { payload: { history_id, email_address }, headers, url, path }
//
// Flow (cursor pattern per Gmail Pub/Sub docs):
//   1. Validate auth token (OPENCLAW_HOOKS_TOKEN)
//   2. Load state: { cursor, message_ids } from disk
//   3. Use stored cursor as startHistoryId; notification historyId becomes new cursor
//   4. Fetch OAuth token from platform API, call Gmail history.list
//   5. Dedup by message ID, return { message } for new messages

import fs from "fs";
import http from "http";
import https from "https";
import path from "path";

const HOME = process.env.HOME || "/home/openclaw";
const OPENCLAW_DIR = path.join(HOME, ".openclaw");
const STATE_FILE = path.join(OPENCLAW_DIR, "gmail-processed.json");

const EXPECTED_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || "";
const PLATFORM_URL = (process.env.OPENCLAW_PLATFORM_URL || "").replace(/\/$/, "");
const API_KEY = process.env.OPENCLAW_PLATFORM_API_KEY || "";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function get(url, headers = {}) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod
      .get(url, { headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      })
      .on("error", reject);
  });
}

function platformGet(apiPath) {
  return get(`${PLATFORM_URL}${apiPath}`, { "X-Instance-API-Key": API_KEY });
}

function gmailGet(apiPath, accessToken) {
  return get(`https://gmail.googleapis.com${apiPath}`, {
    Authorization: `Bearer ${accessToken}`,
  });
}

// ---------------------------------------------------------------------------
// State: { cursor, message_ids }
// cursor    — last notification historyId, used as startHistoryId next run
// message_ids — processed message IDs for dedup (capped at 500)
// ---------------------------------------------------------------------------
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // Migrate from old format (plain array of historyIds)
    if (Array.isArray(s)) return { cursor: null, message_ids: [] };
    return { cursor: s.cursor ?? null, message_ids: s.message_ids ?? [] };
  } catch {
    return { cursor: null, message_ids: [] };
  }
}

function saveState(state) {
  state.message_ids = state.message_ids.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
}

// ---------------------------------------------------------------------------
// Gmail API calls
// ---------------------------------------------------------------------------
async function fetchNewMessages(startHistoryId, accessToken) {
  const qs = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "10",
  });
  const history = await gmailGet(`/gmail/v1/users/me/history?${qs}`, accessToken);

  const messages = [];
  for (const record of history.history ?? []) {
    for (const { message } of record.messagesAdded ?? []) {
      try {
        const msg = await gmailGet(
          `/gmail/v1/users/me/messages/${message.id}?format=full`,
          accessToken
        );

        const hdrs = Object.fromEntries(
          (msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
        );

        const findText = (part) => {
          if (part?.mimeType === "text/plain" && part?.body?.data) {
            return Buffer.from(part.body.data, "base64url").toString("utf8");
          }
          for (const p of part?.parts ?? []) {
            const t = findText(p);
            if (t) return t;
          }
          return "";
        };

        messages.push({
          id: message.id,
          from: hdrs.from ?? "",
          to: hdrs.to ?? "",
          subject: hdrs.subject ?? "(no subject)",
          date: hdrs.date ?? "",
          body: (findText(msg.payload) || msg.snippet || "").trim().slice(0, 4000),
        });
      } catch (err) {
        console.error(`[clawme-gmail] message fetch failed (${message.id}):`, err.message);
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Format prompt for the agent
// ---------------------------------------------------------------------------
function formatPrompt(emailAddress, messages) {
  if (messages.length === 0) return null;

  const parts = messages.map((m) =>
    [
      `--- Email ID: ${m.id} ---`,
      `From: ${m.from}`,
      `To: ${m.to}`,
      `Date: ${m.date}`,
      `Subject: ${m.subject}`,
      "",
      m.body || "(no body)",
    ].join("\n")
  );

  return (
    `New email(s) arrived for ${emailAddress}. Please review and handle them appropriately.\n\n` +
    parts.join("\n\n")
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default async function (ctx) {
  // 1. Auth
  const authHeader = ctx.headers?.authorization ?? ctx.headers?.Authorization ?? "";
  if (EXPECTED_TOKEN && authHeader !== `Bearer ${EXPECTED_TOKEN}`) {
    console.warn("[clawme-gmail] rejected: invalid auth token");
    return null;
  }

  const { history_id, email_address } = ctx.payload ?? {};
  if (!history_id) {
    console.warn("[clawme-gmail] missing history_id in payload");
    return null;
  }

  // 2. Load state and determine startHistoryId (cursor pattern)
  const state = loadState();

  // Use stored cursor as startHistoryId (correct Gmail Pub/Sub cursor pattern).
  // If no cursor yet (first notification ever), fall back to historyId-1 so the
  // triggering change is included (history.list is exclusive of startHistoryId).
  const startHistoryId = state.cursor ?? String(Number(history_id) - 1);

  // 3. Fetch access token from platform
  let accessToken;
  try {
    accessToken = (await platformGet("/api/instance/integrations/google/token")).access_token;
  } catch (err) {
    console.error("[clawme-gmail] failed to fetch access token:", err.message);
    return null;
  }

  // 4. Fetch new messages from Gmail
  let messages;
  try {
    messages = await fetchNewMessages(startHistoryId, accessToken);
  } catch (err) {
    console.error("[clawme-gmail] Gmail API error:", err.message);
    return null;
  }

  // 5. Advance cursor; dedup by message ID
  state.cursor = String(history_id);
  const newMessages = messages.filter((m) => !state.message_ids.includes(m.id));
  newMessages.forEach((m) => state.message_ids.push(m.id));
  saveState(state);

  if (newMessages.length === 0) {
    console.log(`[clawme-gmail] no new messages (startHistoryId=${startHistoryId}, cursor now=${history_id})`);
    return null;
  }

  const message = formatPrompt(email_address, newMessages);
  return message ? { message } : null;
}
