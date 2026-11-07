// Class Update Portal - Cloudflare Worker backend (multi-room: each CR has a room, students join with approval)
// Bindings needed: DB (D1), ASSETS (static files), and a signing secret: ADMIN_PASSWORD (or SESSION_SECRET).
// Push notifications: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.

import { buildPushPayload } from "@block65/webcrypto-web-push";

const CATEGORIES = ["Class", "Assignment", "Quiz / CT", "Exam", "Other"];
const SESSION_SECONDS = 30 * 24 * 60 * 60; // stay logged in for 30 days
const enc = new TextEncoder();
const REACTION_KINDS = ["love", "smile", "upside"]; // love, upright smile, upside-down smile

// Tables are created automatically on the first request (new m_* tables, so older data is left untouched).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, room_id INTEGER NOT NULL, username TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_room_name ON users (room_id, lower(username))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_cr_name ON users (lower(username)) WHERE role = 'cr'`,
  `CREATE TABLE IF NOT EXISTS m_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Other', body TEXT NOT NULL, relevant_date TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_m_notices_room ON m_notices (room_id, pinned DESC, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS m_settings (room_id INTEGER PRIMARY KEY, ct_datetime TEXT NOT NULL DEFAULT '', syllabus_title TEXT NOT NULL DEFAULT '', syllabus_text TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS m_countdowns (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, title TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS m_polls (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS m_votes (poll_id INTEGER NOT NULL, user_id INTEGER NOT NULL, option_idx INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (poll_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS m_reacts (notice_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (notice_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS m_routine (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, day INTEGER NOT NULL, course TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '', faculty TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS m_push (endpoint TEXT PRIMARY KEY, room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS m_rev (room_id INTEGER PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)`,
];
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
// Every change in a room bumps its number; phones of that room check it every few seconds and refresh by themselves.
async function bumpRev(env, roomId) {
  await env.DB.prepare(`INSERT INTO m_rev (room_id, v) VALUES (?, 1) ON CONFLICT(room_id) DO UPDATE SET v = v + 1`).bind(roomId).run();
}
async function getRev(env, roomId) {
  return (await env.DB.prepare(`SELECT v FROM m_rev WHERE room_id = ?`).bind(roomId).first())?.v ?? 0;
}

const normCode = (v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isUnique = (e) => /UNIQUE|constraint/i.test(String(e?.message || e));
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));
function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return toHex(a); }

// Passwords are never stored: only a salted PBKDF2 hash.
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromHex(saltHex), iterations: 100000, hash: "SHA-256" }, key, 256);
  return toHex(new Uint8Array(bits));
}

async function makeSession(env, user) {
  const base = `${user.id}.${user.room_id}.${Date.now() + SESSION_SECONDS * 1000}`;
  return `${base}.${await hmacHex(await sessionSecret(env), "s:" + base)}`;
}
async function readSession(request, env) {
  const p = getCookie(request, "session").split(".");
  if (p.length !== 4 || Number(p[2]) < Date.now()) return null;
  const ok = safeEqual(p[3], await hmacHex(await sessionSecret(env), `s:${p[0]}.${p[1]}.${p[2]}`));
  return ok ? { uid: Number(p[0]), rid: Number(p[1]) } : null;
}
async function currentUser(request, env) {
  const s = await readSession(request, env);
  if (!s) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.role, u.room_id, u.username, u.name, u.status, r.code AS room_code, r.name AS room_name
     FROM users u JOIN rooms r ON r.id = u.room_id WHERE u.id = ?`
  ).bind(s.uid).first();
  if (!row || row.room_id !== s.rid || row.status !== "approved") return null;
  return row;
}
const meOut = (u) => ({ id: u.id, role: u.role, username: u.username, name: u.name, roomCode: u.room_code, roomName: u.room_name });

async function getSecret(env, name) {
  const v = env[name];
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v.get === "function") return String((await v.get()) ?? "");
  return "";
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sessionSecret(env) {
  return (await getSecret(env, "SESSION_SECRET")) || (await getSecret(env, "ADMIN_PASSWORD"));
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

function sessionCookie(token, maxAge, name = "session") {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function readBody(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function validateNotice(body) {
  const title = String(body.title ?? "").trim();
  const text = String(body.body ?? "").trim();
  const category = String(body.category ?? "");
  const rawDate = String(body.relevant_date ?? "").trim();
  if (!title) return { error: "Please enter a title." };
  if (title.length > 140) return { error: "Title is too long (max 140 characters)." };
  if (!text) return { error: "Please write the notice details." };
  if (text.length > 6000) return { error: "Details are too long (max 6000 characters)." };
  if (!CATEGORIES.includes(category)) return { error: "Invalid category." };
  if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return { error: "Invalid date." };
  return {
    value: {
      title,
      body: text,
      category,
      relevant_date: rawDate || null,
      pinned: body.pinned ? 1 : 0,
    },
  };
}

function validateCountdown(body) {
  const title = String(body.title ?? "").trim();
  const note = String(body.note ?? "").trim();
  if (!title) return { error: "Please enter a countdown title." };
  if (title.length > 80) return { error: "Title is too long (max 80 characters)." };
  if (note.length > 1500) return { error: "Details are too long (max 1500 characters)." };
  const dt = parseCtDatetime(body.datetime);
  if (dt.error) return { error: "Invalid date/time." };
  if (!dt.value) return { error: "Please choose a date and time." };
  return { value: { title, note, target: dt.value } };
}

function validatePoll(body) {
  const question = String(body.question ?? "").trim();
  const options = (Array.isArray(body.options) ? body.options : []).map((o) => String(o ?? "").trim()).filter(Boolean);
  if (!question) return { error: "Please write the poll question." };
  if (question.length > 200) return { error: "Question is too long (max 200 characters)." };
  if (options.length < 2) return { error: "Add at least 2 options." };
  if (options.length > 6) return { error: "Maximum 6 options." };
  if (options.some((o) => o.length > 80)) return { error: "An option is too long (max 80 characters)." };
  return { value: { question, options } };
}

function parseCtDatetime(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { value: "" };
  let iso = value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) iso = value + ":00+06:00";
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) iso = value + "+06:00";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { error: "Invalid class test date/time." };
  return { value: d.toISOString() };
}

async function sendPushToRoom(env, roomId, message) {
  const publicKey = await getSecret(env, "VAPID_PUBLIC_KEY");
  const privateKey = await getSecret(env, "VAPID_PRIVATE_KEY");
  const subject = (await getSecret(env, "VAPID_SUBJECT")) || "mailto:admin@example.com";
  if (!publicKey || !privateKey) { console.error("push skipped: VAPID keys missing", { hasPublic: !!publicKey, hasPrivate: !!privateKey }); return; }
  const vapid = { subject, publicKey, privateKey };

  const { results } = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM m_push WHERE room_id = ?`).bind(roomId).all();
  await Promise.all(
    (results || []).map(async (row) => {
      const subscription = { endpoint: row.endpoint, expirationTime: null, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        const payload = await buildPushPayload(
          { data: JSON.stringify(message), options: { ttl: 86400, urgency: "high" } },
          subscription,
          vapid
        );
        const res = await fetch(subscription.endpoint, payload);
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare(`DELETE FROM m_push WHERE endpoint = ?`).bind(row.endpoint).run();
        } else if (!res.ok) {
          console.error("push rejected", res.status, (await res.text()).slice(0, 200));
        }
      } catch (err) {
        console.error("push failed", err);
      }
    })
  );
}

async function handleApi(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/api/test" && method === "GET") return json({ success: true, message: "API is working!" });
  if (!env.DB) return json({ error: "Database is not connected." }, 500);
  if (!(await sessionSecret(env))) return json({ error: "Server secret is not configured." }, 500);
  await ensureSchema(env);

  // Basic CSRF protection for state-changing requests
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Forbidden." }, 403);
  }

  // ---------- Public: sign up / login ----------
  if (path === "/api/signup/cr" && method === "POST") {
    const b = await readBody(request);
    const username = String(b.username ?? "").trim(), password = String(b.password ?? ""), code = normCode(b.room_code), roomName = String(b.room_name ?? "").trim();
    if (!/^[A-Za-z0-9_.]{3,30}$/.test(username)) return json({ error: "Username: 3-30 letters, numbers, dot or underscore." }, 400);
    if (password.length < 6 || password.length > 100) return json({ error: "Password must be at least 6 characters." }, 400);
    if (!/^[A-Z0-9]{4,20}$/.test(code)) return json({ error: "Room code: 4-20 letters or numbers." }, 400);
    if (roomName.length > 60) return json({ error: "Room name is too long (max 60)." }, 400);
    if (await env.DB.prepare(`SELECT id FROM users WHERE role = 'cr' AND lower(username) = lower(?)`).bind(username).first()) return json({ error: "This username is already taken." }, 409);
    let roomId;
    try { roomId = (await env.DB.prepare(`INSERT INTO rooms (code, name) VALUES (?, ?)`).bind(code, roomName).run()).meta?.last_row_id; }
    catch (e) { if (isUnique(e)) return json({ error: "This room code is already taken. Choose another." }, 409); throw e; }
    const salt = randomHex(16), hash = await hashPassword(password, salt);
    let userId;
    try { userId = (await env.DB.prepare(`INSERT INTO users (role, room_id, username, name, pass_salt, pass_hash, status) VALUES ('cr', ?, ?, ?, ?, ?, 'approved')`).bind(roomId, username, username, salt, hash).run()).meta?.last_row_id; }
    catch (e) { await env.DB.prepare(`DELETE FROM rooms WHERE id = ?`).bind(roomId).run(); if (isUnique(e)) return json({ error: "This username is already taken." }, 409); throw e; }
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO m_settings (room_id) VALUES (?)`).bind(roomId),
      env.DB.prepare(`INSERT OR IGNORE INTO m_rev (room_id, v) VALUES (?, 1)`).bind(roomId),
    ]);
    const token = await makeSession(env, { id: userId, room_id: roomId });
    return json({ ok: true }, 201, { "Set-Cookie": sessionCookie(token, SESSION_SECONDS) });
  }

  if (path === "/api/signup/student" && method === "POST") {
    const b = await readBody(request);
    const name = String(b.name ?? "").trim(), sid = String(b.student_id ?? "").trim(), password = String(b.password ?? ""), code = normCode(b.room_code);
    if (name.length < 2 || name.length > 40) return json({ error: "Please write your name (2-40 characters)." }, 400);
    if (!/^[A-Za-z0-9_.\-]{2,30}$/.test(sid)) return json({ error: "Student ID: 2-30 letters or numbers." }, 400);
    if (password.length < 6 || password.length > 100) return json({ error: "Password must be at least 6 characters." }, 400);
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE code = ?`).bind(code).first();
    if (!room) { await delay(400); return json({ error: "No room found with this code." }, 404); }
    const salt = randomHex(16), hash = await hashPassword(password, salt);
    try { await env.DB.prepare(`INSERT INTO users (role, room_id, username, name, pass_salt, pass_hash, status) VALUES ('student', ?, ?, ?, ?, ?, 'pending')`).bind(room.id, sid, name, salt, hash).run(); }
    catch (e) { if (isUnique(e)) return json({ error: "This ID already has an account or a pending request in this room." }, 409); throw e; }
    await bumpRev(env, room.id);
    return json({ ok: true, pending: true }, 201);
  }

  if (path === "/api/login" && method === "POST") {
    const b = await readBody(request);
    const password = String(b.password ?? "");
    let row = null;
    if (b.role === "cr") {
      row = await env.DB.prepare(`SELECT * FROM users WHERE role = 'cr' AND lower(username) = lower(?)`).bind(String(b.username ?? "").trim()).first();
    } else {
      const room = await env.DB.prepare(`SELECT id FROM rooms WHERE code = ?`).bind(normCode(b.room_code)).first();
      if (room) row = await env.DB.prepare(`SELECT * FROM users WHERE role = 'student' AND room_id = ? AND lower(username) = lower(?)`).bind(room.id, String(b.student_id ?? "").trim()).first();
    }
    const hash = await hashPassword(password, row ? row.pass_salt : "00".repeat(16)); // same work whether or not the account exists
    if (!row || !safeEqual(hash, row.pass_hash)) { await delay(500); return json({ error: "Incorrect ID, room code or password." }, 401); }
    if (row.status !== "approved") return json({ error: "Your request is still waiting for your CR's approval.", pending: true }, 403);
    const token = await makeSession(env, row);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_SECONDS) });
  }

  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  if (path === "/api/push/key" && method === "GET") return json({ key: await getSecret(env, "VAPID_PUBLIC_KEY") });

  if (path === "/api/rev" && method === "GET") {
    const s = await readSession(request, env);
    return json({ rev: s ? await getRev(env, s.rid) : 0 });
  }

  // ---------- Needs a logged-in, approved account ----------
  const me = await currentUser(request, env);

  if (path === "/api/bootstrap" && method === "GET") {
    if (!me) return json({ me: null });
    const rid = me.room_id, uid = me.id, isCr = me.role === "cr";
    ctx.waitUntil(env.DB.prepare(`UPDATE users SET last_seen = datetime('now') WHERE id = ? AND (last_seen IS NULL OR last_seen < datetime('now', '-10 minutes'))`).bind(uid).run());
    const [notices, settings, countdowns, polls, pollCounts, myVotes, reactCounts, myReacts, rev, routine, pending] = await Promise.all([
      env.DB.prepare(`SELECT id, title, category, body, relevant_date, pinned, created_at FROM m_notices WHERE room_id = ? ORDER BY pinned DESC, created_at DESC, id DESC`).bind(rid).all(),
      env.DB.prepare(`SELECT ct_datetime, syllabus_title, syllabus_text FROM m_settings WHERE room_id = ?`).bind(rid).first(),
      env.DB.prepare(`SELECT id, title, target, note FROM m_countdowns WHERE room_id = ? ORDER BY target ASC, id ASC`).bind(rid).all(),
      env.DB.prepare(`SELECT id, question, options, created_at FROM m_polls WHERE room_id = ? ORDER BY id DESC LIMIT 20`).bind(rid).all(),
      env.DB.prepare(`SELECT v.poll_id, v.option_idx, COUNT(*) AS n FROM m_votes v JOIN m_polls p ON p.id = v.poll_id WHERE p.room_id = ? GROUP BY v.poll_id, v.option_idx`).bind(rid).all(),
      env.DB.prepare(`SELECT poll_id, option_idx FROM m_votes WHERE user_id = ?`).bind(uid).all(),
      env.DB.prepare(`SELECT r.notice_id, r.kind, COUNT(*) AS n FROM m_reacts r JOIN m_notices n ON n.id = r.notice_id WHERE n.room_id = ? GROUP BY r.notice_id, r.kind`).bind(rid).all(),
      env.DB.prepare(`SELECT notice_id, kind FROM m_reacts WHERE user_id = ?`).bind(uid).all(),
      getRev(env, rid),
      env.DB.prepare(`SELECT id, day, course, start_time, end_time, room, faculty FROM m_routine WHERE room_id = ? ORDER BY day ASC, start_time ASC, id ASC`).bind(rid).all(),
      isCr ? env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE room_id = ? AND role = 'student' AND status = 'pending'`).bind(rid).first() : Promise.resolve(null),
    ]);
    const rc = {}; (reactCounts.results || []).forEach((r) => { (rc[r.notice_id] = rc[r.notice_id] || {})[r.kind] = r.n; });
    const myR = {}; (myReacts.results || []).forEach((r) => { myR[r.notice_id] = r.kind; });
    const pc = {}; (pollCounts.results || []).forEach((r) => { pc[r.poll_id + ":" + r.option_idx] = r.n; });
    const myV = {}; (myVotes.results || []).forEach((r) => { myV[r.poll_id] = r.option_idx; });
    return json({
      me: meOut(me),
      isAdmin: isCr,
      pending: pending?.n ?? 0,
      notices: (notices.results || []).map((n) => ({ ...n, reactions: rc[n.id] || {}, mine: myR[n.id] || null })),
      settings: settings || {},
      countdowns: countdowns.results || [],
      polls: (polls.results || []).map((p) => {
        let options = []; try { options = JSON.parse(p.options); } catch {}
        const counts = options.map((_, i) => pc[p.id + ":" + i] || 0);
        return { id: p.id, question: p.question, options, counts, total: counts.reduce((a, b) => a + b, 0), mine: myV[p.id] ?? null, created_at: p.created_at };
      }),
      routine: routine.results || [],
      rev,
    });
  }

  if (!me) return json({ error: "Please log in first." }, 401);
  const rid = me.room_id, uid = me.id;

  if (path === "/api/push/subscribe" && method === "POST") {
    const sub = await readBody(request);
    const endpoint = String(sub?.endpoint ?? ""), p256dh = String(sub?.keys?.p256dh ?? ""), auth = String(sub?.keys?.auth ?? "");
    if (!endpoint.startsWith("https://") || endpoint.length > 1000 || !p256dh || !auth) return json({ error: "Invalid subscription." }, 400);
    await env.DB.prepare(`INSERT OR REPLACE INTO m_push (endpoint, room_id, user_id, p256dh, auth) VALUES (?, ?, ?, ?, ?)`).bind(endpoint, rid, uid, p256dh, auth).run();
    return json({ ok: true });
  }
  if (path === "/api/push/unsubscribe" && method === "POST") {
    const { endpoint } = await readBody(request);
    if (typeof endpoint === "string" && endpoint) await env.DB.prepare(`DELETE FROM m_push WHERE endpoint = ? AND user_id = ?`).bind(endpoint, uid).run();
    return json({ ok: true });
  }

  const reactMatch = path.match(/^\/api\/notices\/(\d+)\/react$/);
  if (reactMatch && method === "POST") {
    const id = Number(reactMatch[1]);
    const { kind } = await readBody(request);
    if (kind !== null && !REACTION_KINDS.includes(kind)) return json({ error: "Invalid reaction." }, 400);
    if (!(await env.DB.prepare(`SELECT id FROM m_notices WHERE id = ? AND room_id = ?`).bind(id, rid).first())) return json({ error: "Notice not found." }, 404);
    if (kind === null) await env.DB.prepare(`DELETE FROM m_reacts WHERE notice_id = ? AND user_id = ?`).bind(id, uid).run();
    else await env.DB.prepare(`INSERT OR REPLACE INTO m_reacts (notice_id, user_id, kind) VALUES (?, ?, ?)`).bind(id, uid, kind).run();
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  const voteMatch = path.match(/^\/api\/polls\/(\d+)\/vote$/);
  if (voteMatch && method === "POST") {
    const id = Number(voteMatch[1]), body = await readBody(request);
    const poll = await env.DB.prepare(`SELECT options FROM m_polls WHERE id = ? AND room_id = ?`).bind(id, rid).first();
    if (!poll) return json({ error: "Poll not found." }, 404);
    if (body.option === null) {
      await env.DB.prepare(`DELETE FROM m_votes WHERE poll_id = ? AND user_id = ?`).bind(id, uid).run();
    } else {
      const idx = Number(body.option);
      let options = []; try { options = JSON.parse(poll.options); } catch {}
      if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return json({ error: "Invalid option." }, 400);
      await env.DB.prepare(`INSERT OR REPLACE INTO m_votes (poll_id, user_id, option_idx) VALUES (?, ?, ?)`).bind(id, uid, idx).run();
    }
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  // ---------- CR only ----------
  const noticeMatch = path.match(/^\/api\/notices\/(\d+)$/);
  const cdMatch = path.match(/^\/api\/countdowns\/(\d+)$/);
  const pollMatch = path.match(/^\/api\/polls\/(\d+)$/);
  const routineMatch = path.match(/^\/api\/routine\/([0-6])$/);
  const memberMatch = path.match(/^\/api\/members\/(\d+)\/(approve|reject|remove|password)$/);
  const isCrRoute =
    (path === "/api/notices" && method === "POST") || (noticeMatch && (method === "PUT" || method === "DELETE")) ||
    (path === "/api/countdowns" && method === "POST") || (cdMatch && (method === "PUT" || method === "DELETE")) ||
    (path === "/api/polls" && method === "POST") || (pollMatch && method === "DELETE") ||
    (routineMatch && method === "PUT") || (path === "/api/settings" && method === "PUT") ||
    (path === "/api/stats" && method === "GET") || (path === "/api/members" && method === "GET") || (memberMatch && method === "POST");
  if (!isCrRoute) return json({ error: "Not found." }, 404);
  if (me.role !== "cr") return json({ error: "Only the CR can do this." }, 403);

  if (path === "/api/stats") {
    const one = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first())?.n ?? 0;
    return json({
      devices: await one(`SELECT COUNT(*) AS n FROM users WHERE room_id = ? AND role = 'student' AND status = 'approved'`, rid),
      active24h: await one(`SELECT COUNT(*) AS n FROM users WHERE room_id = ? AND last_seen >= datetime('now', '-1 day')`, rid),
      active7d: await one(`SELECT COUNT(*) AS n FROM users WHERE room_id = ? AND last_seen >= datetime('now', '-7 days')`, rid),
      alertsOn: await one(`SELECT COUNT(*) AS n FROM m_push WHERE room_id = ?`, rid),
    });
  }

  if (path === "/api/members") {
    const { results } = await env.DB.prepare(`SELECT id, username, name, status, created_at, last_seen FROM users WHERE room_id = ? AND role = 'student' ORDER BY status DESC, created_at DESC`).bind(rid).all();
    return json({ roomCode: me.room_code, pending: (results || []).filter((u) => u.status === "pending"), approved: (results || []).filter((u) => u.status === "approved") });
  }

  if (memberMatch) {
    const id = Number(memberMatch[1]), action = memberMatch[2];
    const target = await env.DB.prepare(`SELECT id, status FROM users WHERE id = ? AND room_id = ? AND role = 'student'`).bind(id, rid).first();
    if (!target) return json({ error: "Student not found." }, 404);
    if (action === "approve") {
      await env.DB.prepare(`UPDATE users SET status = 'approved' WHERE id = ?`).bind(id).run();
    } else if (action === "password") {
      const password = String((await readBody(request)).password ?? "");
      if (password.length < 6 || password.length > 100) return json({ error: "Password must be at least 6 characters." }, 400);
      const salt = randomHex(16);
      await env.DB.prepare(`UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?`).bind(salt, await hashPassword(password, salt), id).run();
    } else { // reject / remove
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id),
        env.DB.prepare(`DELETE FROM m_votes WHERE user_id = ?`).bind(id),
        env.DB.prepare(`DELETE FROM m_reacts WHERE user_id = ?`).bind(id),
        env.DB.prepare(`DELETE FROM m_push WHERE user_id = ?`).bind(id),
      ]);
    }
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  if (path === "/api/notices" && method === "POST") {
    const { error, value } = validateNotice(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`INSERT INTO m_notices (room_id, title, category, body, relevant_date, pinned) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(rid, value.title, value.category, value.body, value.relevant_date, value.pinned).run();
    await bumpRev(env, rid);
    ctx.waitUntil(sendPushToRoom(env, rid, { title: (me.room_name || "Class") + " · " + value.category, body: value.title, url: "/#notice-" + result.meta?.last_row_id }));
    return json({ ok: true, id: result.meta?.last_row_id }, 201);
  }
  if (noticeMatch && method === "PUT") {
    const { error, value } = validateNotice(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`UPDATE m_notices SET title = ?, category = ?, body = ?, relevant_date = ?, pinned = ?, updated_at = datetime('now') WHERE id = ? AND room_id = ?`)
      .bind(value.title, value.category, value.body, value.relevant_date, value.pinned, Number(noticeMatch[1]), rid).run();
    if (!result.meta?.changes) return json({ error: "Notice not found." }, 404);
    await bumpRev(env, rid);
    return json({ ok: true });
  }
  if (noticeMatch && method === "DELETE") {
    const id = Number(noticeMatch[1]);
    const result = await env.DB.prepare(`DELETE FROM m_notices WHERE id = ? AND room_id = ?`).bind(id, rid).run();
    if (!result.meta?.changes) return json({ error: "Notice not found." }, 404);
    await env.DB.prepare(`DELETE FROM m_reacts WHERE notice_id = ?`).bind(id).run();
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  if (path === "/api/countdowns" && method === "POST") {
    const { error, value } = validateCountdown(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`INSERT INTO m_countdowns (room_id, title, target, note) VALUES (?, ?, ?, ?)`).bind(rid, value.title, value.target, value.note).run();
    await bumpRev(env, rid);
    return json({ ok: true, id: result.meta?.last_row_id }, 201);
  }
  if (cdMatch && method === "PUT") {
    const { error, value } = validateCountdown(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`UPDATE m_countdowns SET title = ?, target = ?, note = ? WHERE id = ? AND room_id = ?`).bind(value.title, value.target, value.note, Number(cdMatch[1]), rid).run();
    if (!result.meta?.changes) return json({ error: "Countdown not found." }, 404);
    await bumpRev(env, rid);
    return json({ ok: true });
  }
  if (cdMatch && method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM m_countdowns WHERE id = ? AND room_id = ?`).bind(Number(cdMatch[1]), rid).run();
    if (!result.meta?.changes) return json({ error: "Countdown not found." }, 404);
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  if (path === "/api/polls" && method === "POST") {
    const { error, value } = validatePoll(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`INSERT INTO m_polls (room_id, question, options) VALUES (?, ?, ?)`).bind(rid, value.question, JSON.stringify(value.options)).run();
    await bumpRev(env, rid);
    ctx.waitUntil(sendPushToRoom(env, rid, { title: (me.room_name || "Class") + " · Poll", body: value.question, url: "/#home" }));
    return json({ ok: true, id: result.meta?.last_row_id }, 201);
  }
  if (pollMatch && method === "DELETE") {
    const id = Number(pollMatch[1]);
    const result = await env.DB.prepare(`DELETE FROM m_polls WHERE id = ? AND room_id = ?`).bind(id, rid).run();
    if (!result.meta?.changes) return json({ error: "Poll not found." }, 404);
    await env.DB.prepare(`DELETE FROM m_votes WHERE poll_id = ?`).bind(id).run();
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  if (routineMatch && method === "PUT") {
    const day = Number(routineMatch[1]);
    const body = await readBody(request);
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length > 12) return json({ error: "Maximum 12 classes per day." }, 400);
    const rows = [];
    for (const it of items) {
      const course = String(it?.course ?? "").trim(), start = String(it?.start ?? "").trim(), end = String(it?.end ?? "").trim();
      const room = String(it?.room ?? "").trim(), faculty = String(it?.faculty ?? "").trim();
      if (!course && !start && !room && !faculty) continue;
      if (!course || !/^\d{2}:\d{2}$/.test(start)) return json({ error: "Each class needs a course name and a start time." }, 400);
      if (end && !/^\d{2}:\d{2}$/.test(end)) return json({ error: "Invalid end time." }, 400);
      if (course.length > 60 || faculty.length > 60 || room.length > 30) return json({ error: "Course/faculty max 60 characters, room max 30." }, 400);
      rows.push({ course, start, end, room, faculty });
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM m_routine WHERE room_id = ? AND day = ?`).bind(rid, day),
      ...rows.map((r) => env.DB.prepare(`INSERT INTO m_routine (room_id, day, course, start_time, end_time, room, faculty) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(rid, day, r.course, r.start, r.end, r.room, r.faculty)),
    ]);
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  if (path === "/api/settings" && method === "PUT") {
    const body = await readBody(request);
    const ct = parseCtDatetime(body.ct_datetime);
    if (ct.error) return json({ error: ct.error }, 400);
    const title = String(body.syllabus_title ?? "").trim(), text = String(body.syllabus_text ?? "").trim();
    if (title.length > 140) return json({ error: "Syllabus heading is too long (max 140)." }, 400);
    if (text.length > 8000) return json({ error: "Syllabus details are too long (max 8000)." }, 400);
    await env.DB.prepare(
      `INSERT INTO m_settings (room_id, ct_datetime, syllabus_title, syllabus_text, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(room_id) DO UPDATE SET ct_datetime = excluded.ct_datetime, syllabus_title = excluded.syllabus_title, syllabus_text = excluded.syllabus_text, updated_at = datetime('now')`
    ).bind(rid, ct.value, title, text).run();
    await bumpRev(env, rid);
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
      return env.ASSETS.fetch(request);
    }
    try {
      return await handleApi(request, env, url, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error. Please try again." }, 500);
    }
  },
};
