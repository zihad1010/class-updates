// BUP ICE Class Update Portal - Cloudflare Worker backend
// Bindings needed: DB (D1), ASSETS (static files), secret ADMIN_PASSWORD
// Optional secret: SESSION_SECRET (if not set, ADMIN_PASSWORD is used to sign sessions)
// Push notifications: secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com)

import { buildPushPayload } from "@block65/webcrypto-web-push";

const CATEGORIES = ["Class", "Assignment", "Quiz / CT", "Exam", "Other"];
const SESSION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const enc = new TextEncoder();
const REACTION_KINDS = ["love", "smile", "upside"]; // love, upright smile, upside-down smile

// Tables are created automatically on first request, so no manual SQL step is needed.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Other', body TEXT NOT NULL, relevant_date TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_notices_pinned_created ON notices (pinned DESC, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), ct_datetime TEXT NOT NULL DEFAULT '', syllabus_title TEXT NOT NULL DEFAULT '', syllabus_text TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `INSERT OR IGNORE INTO settings (id, ct_datetime, syllabus_title, syllabus_text) VALUES (1, '', '', '')`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS countdowns (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, options TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS poll_votes (poll_id INTEGER NOT NULL, voter_id TEXT NOT NULL, option_idx INTEGER NOT NULL, voter_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (poll_id, voter_id))`,
  `CREATE TABLE IF NOT EXISTS reactions (notice_id INTEGER NOT NULL, voter_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (notice_id, voter_id))`,
  `CREATE TABLE IF NOT EXISTS devices (voter_id TEXT PRIMARY KEY, first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS class_routine (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, course TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '', faculty TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)`,
  `UPDATE reactions SET kind = 'smile' WHERE kind = 'halo'`, // old halo smile becomes the plain smile
];
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
// Every change bumps this number; phones check it every few seconds and refresh by themselves when it moves.
async function bumpRev(env) {
  await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('rev', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1`).run();
}
async function getRev(env) {
  return (await env.DB.prepare(`SELECT v FROM meta WHERE k = 'rev'`).first())?.v ?? 0;
}
function voterOf(request) {
  const v = request.headers.get("X-Voter") || "";
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : "";
}

// Works with both a plain Worker secret (string) and a Secrets Store binding (object with .get()).
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

async function makeSessionToken(env) {
  const exp = Date.now() + SESSION_SECONDS * 1000;
  const sig = await hmacHex(await sessionSecret(env), "session:" + exp);
  return `${exp}.${sig}`;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

async function isAdmin(request, env) {
  const token = getCookie(request, "session");
  if (!token) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  const expected = await hmacHex(await sessionSecret(env), "session:" + exp);
  return safeEqual(sig, expected);
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

// The admin form sends a datetime-local value in Bangladesh time (UTC+6).
// We store it as a full UTC ISO string so the countdown is correct everywhere.
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


// ---------- Web Push ----------
async function sendPushToAll(env, message) {
  const publicKey = await getSecret(env, "VAPID_PUBLIC_KEY");
  const privateKey = await getSecret(env, "VAPID_PRIVATE_KEY");
  const subject = (await getSecret(env, "VAPID_SUBJECT")) || "mailto:admin@example.com";
  if (!publicKey || !privateKey) { console.error("push skipped: VAPID keys missing", { hasPublic: !!publicKey, hasPrivate: !!privateKey }); return; }
  const vapid = { subject, publicKey, privateKey };

  const { results } = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`).all();
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
          await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(row.endpoint).run();
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

  if (path === "/api/test" && method === "GET") {
    return json({ success: true, message: "BUP ICE API is working!" });
  }

  if (!env.DB) return json({ error: "Database is not connected." }, 500);
  const adminPassword = await getSecret(env, "ADMIN_PASSWORD");
  if (!adminPassword) return json({ error: "Admin password is not configured." }, 500);
  await ensureSchema(env);

  // Basic CSRF protection for state-changing requests
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Forbidden." }, 403);
  }

  const voter = voterOf(request);

  // ---------- Public ----------
  if (path === "/api/rev" && method === "GET") {
    return json({ rev: await getRev(env) });
  }

  if (path === "/api/bootstrap" && method === "GET") {
    if (voter) {
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO devices (voter_id) VALUES (?)
           ON CONFLICT(voter_id) DO UPDATE SET last_seen = datetime('now') WHERE last_seen < datetime('now', '-10 minutes')`
        ).bind(voter).run()
      );
    }
    const [notices, settings, countdowns, polls, pollCounts, myVotes, reactCounts, myReacts, rev, routine] = await Promise.all([
      env.DB.prepare(
        `SELECT id, title, category, body, relevant_date, pinned, created_at
         FROM notices ORDER BY pinned DESC, created_at DESC, id DESC`
      ).all(),
      env.DB.prepare(`SELECT ct_datetime, syllabus_title, syllabus_text FROM settings WHERE id = 1`).first(),
      env.DB.prepare(`SELECT id, title, target, note FROM countdowns ORDER BY target ASC, id ASC`).all(),
      env.DB.prepare(`SELECT id, question, options, created_at FROM polls ORDER BY id DESC LIMIT 20`).all(),
      env.DB.prepare(`SELECT poll_id, option_idx, COUNT(*) AS n FROM poll_votes GROUP BY poll_id, option_idx`).all(),
      voter ? env.DB.prepare(`SELECT poll_id, option_idx FROM poll_votes WHERE voter_id = ?`).bind(voter).all() : Promise.resolve({ results: [] }),
      env.DB.prepare(`SELECT notice_id, kind, COUNT(*) AS n FROM reactions GROUP BY notice_id, kind`).all(),
      voter ? env.DB.prepare(`SELECT notice_id, kind FROM reactions WHERE voter_id = ?`).bind(voter).all() : Promise.resolve({ results: [] }),
      getRev(env),
      env.DB.prepare(`SELECT id, day, course, start_time, end_time, room, faculty FROM class_routine ORDER BY day ASC, start_time ASC, id ASC`).all(),
    ]);

    const rc = {};
    (reactCounts.results || []).forEach((r) => { (rc[r.notice_id] = rc[r.notice_id] || {})[r.kind] = r.n; });
    const myR = {};
    (myReacts.results || []).forEach((r) => { myR[r.notice_id] = r.kind; });
    const pc = {};
    (pollCounts.results || []).forEach((r) => { pc[r.poll_id + ":" + r.option_idx] = r.n; });
    const myV = {};
    (myVotes.results || []).forEach((r) => { myV[r.poll_id] = r.option_idx; });

    return json({
      notices: (notices.results || []).map((n) => ({ ...n, reactions: rc[n.id] || {}, mine: myR[n.id] || null })),
      settings: settings || {},
      countdowns: countdowns.results || [],
      polls: (polls.results || []).map((p) => {
        let options = [];
        try { options = JSON.parse(p.options); } catch {}
        const counts = options.map((_, i) => pc[p.id + ":" + i] || 0);
        return { id: p.id, question: p.question, options, counts, total: counts.reduce((a, b) => a + b, 0), mine: myV[p.id] ?? null, created_at: p.created_at };
      }),
      isAdmin: await isAdmin(request, env),
      routine: routine.results || [],
      rev,
    });
  }

  if (path === "/api/push/key" && method === "GET") {
    return json({ key: await getSecret(env, "VAPID_PUBLIC_KEY") });
  }

  if (path === "/api/push/subscribe" && method === "POST") {
    const sub = await readBody(request);
    const endpoint = String(sub?.endpoint ?? "");
    const p256dh = String(sub?.keys?.p256dh ?? "");
    const auth = String(sub?.keys?.auth ?? "");
    if (!endpoint.startsWith("https://") || endpoint.length > 1000 || !p256dh || !auth) {
      return json({ error: "Invalid subscription." }, 400);
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)`
    ).bind(endpoint, p256dh, auth).run();
    return json({ ok: true });
  }

  if (path === "/api/push/unsubscribe" && method === "POST") {
    const { endpoint } = await readBody(request);
    if (typeof endpoint === "string" && endpoint) {
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
    }
    return json({ ok: true });
  }

  // Reactions (love / saint smile / upside-down saint smile): one per device per notice
  const reactMatch = path.match(/^\/api\/notices\/(\d+)\/react$/);
  if (reactMatch && method === "POST") {
    if (!voter) return json({ error: "Device id missing. Please reload the app." }, 400);
    const id = Number(reactMatch[1]);
    const { kind } = await readBody(request);
    if (kind !== null && !REACTION_KINDS.includes(kind)) return json({ error: "Invalid reaction." }, 400);
    if (!(await env.DB.prepare(`SELECT id FROM notices WHERE id = ?`).bind(id).first())) return json({ error: "Notice not found." }, 404);
    if (kind === null) await env.DB.prepare(`DELETE FROM reactions WHERE notice_id = ? AND voter_id = ?`).bind(id, voter).run();
    else await env.DB.prepare(`INSERT OR REPLACE INTO reactions (notice_id, voter_id, kind) VALUES (?, ?, ?)`).bind(id, voter, kind).run();
    await bumpRev(env);
    return json({ ok: true });
  }

  // Poll voting: one choice per device, tap the same option again to take the vote back
  const voteMatch = path.match(/^\/api\/polls\/(\d+)\/vote$/);
  if (voteMatch && method === "POST") {
    if (!voter) return json({ error: "Device id missing. Please reload the app." }, 400);
    const id = Number(voteMatch[1]);
    const body = await readBody(request);
    const poll = await env.DB.prepare(`SELECT options FROM polls WHERE id = ?`).bind(id).first();
    if (!poll) return json({ error: "Poll not found." }, 404);
    if (body.option === null) {
      await env.DB.prepare(`DELETE FROM poll_votes WHERE poll_id = ? AND voter_id = ?`).bind(id, voter).run();
    } else {
      const idx = Number(body.option);
      let options = [];
      try { options = JSON.parse(poll.options); } catch {}
      if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return json({ error: "Invalid option." }, 400);
      const name = String(body.name ?? "").trim().slice(0, 40);
      await env.DB.prepare(`INSERT OR REPLACE INTO poll_votes (poll_id, voter_id, option_idx, voter_name) VALUES (?, ?, ?, ?)`).bind(id, voter, idx, name).run();
    }
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path === "/api/login" && method === "POST") {
    const { password } = await readBody(request);
    const a = await hmacHex("password-check", String(password ?? ""));
    const b = await hmacHex("password-check", adminPassword);
    if (!safeEqual(a, b)) {
      await new Promise((r) => setTimeout(r, 500)); // slow down guessing
      return json({ error: "Incorrect password." }, 401);
    }
    const token = await makeSessionToken(env);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, SESSION_SECONDS) });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  // ---------- Admin only ----------
  const noticeMatch = path.match(/^\/api\/notices\/(\d+)$/);
  const cdMatch = path.match(/^\/api\/countdowns\/(\d+)$/);
  const pollMatch = path.match(/^\/api\/polls\/(\d+)$/);
  const routineMatch = path.match(/^\/api\/routine\/([0-6])$/);
  const isAdminRoute =
    (path === "/api/notices" && method === "POST") ||
    (noticeMatch && (method === "PUT" || method === "DELETE")) ||
    (path === "/api/countdowns" && method === "POST") ||
    (cdMatch && (method === "PUT" || method === "DELETE")) ||
    (path === "/api/polls" && method === "POST") ||
    (pollMatch && method === "DELETE") ||
    (routineMatch && method === "PUT") ||
    (path === "/api/stats" && method === "GET") ||
    (path === "/api/settings" && method === "PUT");

  if (!isAdminRoute) return json({ error: "Not found." }, 404);
  if (!(await isAdmin(request, env))) return json({ error: "Please log in as CR first." }, 401);

  // How many devices have used the app (replaces the old test-notification button)
  if (path === "/api/stats" && method === "GET") {
    const one = async (sql) => (await env.DB.prepare(sql).first())?.n ?? 0;
    return json({
      devices: await one(`SELECT COUNT(*) AS n FROM devices`),
      active24h: await one(`SELECT COUNT(*) AS n FROM devices WHERE last_seen >= datetime('now', '-1 day')`),
      active7d: await one(`SELECT COUNT(*) AS n FROM devices WHERE last_seen >= datetime('now', '-7 days')`),
      alertsOn: await one(`SELECT COUNT(*) AS n FROM push_subscriptions`),
    });
  }

  if (path === "/api/notices" && method === "POST") {
    const { error, value } = validateNotice(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(
      `INSERT INTO notices (title, category, body, relevant_date, pinned) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(value.title, value.category, value.body, value.relevant_date, value.pinned)
      .run();
    await bumpRev(env);
    ctx.waitUntil(
      sendPushToAll(env, { title: "My CR · " + value.category, body: value.title, url: "/#notice-" + result.meta?.last_row_id })
    );
    return json({ ok: true, id: result.meta?.last_row_id }, 201);
  }

  if (noticeMatch && method === "PUT") {
    const id = Number(noticeMatch[1]);
    const { error, value } = validateNotice(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(
      `UPDATE notices
       SET title = ?, category = ?, body = ?, relevant_date = ?, pinned = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(value.title, value.category, value.body, value.relevant_date, value.pinned, id)
      .run();
    if (!result.meta?.changes) return json({ error: "Notice not found." }, 404);
    await bumpRev(env);
    return json({ ok: true });
  }

  if (noticeMatch && method === "DELETE") {
    const id = Number(noticeMatch[1]);
    const result = await env.DB.prepare(`DELETE FROM notices WHERE id = ?`).bind(id).run();
    if (!result.meta?.changes) return json({ error: "Notice not found." }, 404);
    await env.DB.prepare(`DELETE FROM reactions WHERE notice_id = ?`).bind(id).run();
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path === "/api/countdowns" && method === "POST") {
    const { error, value } = validateCountdown(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`INSERT INTO countdowns (title, target, note) VALUES (?, ?, ?)`).bind(value.title, value.target, value.note).run();
    await bumpRev(env);
    return json({ ok: true, id: result.meta?.last_row_id }, 201);
  }

  if (cdMatch && method === "PUT") {
    const { error, value } = validateCountdown(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`UPDATE countdowns SET title = ?, target = ?, note = ? WHERE id = ?`).bind(value.title, value.target, value.note, Number(cdMatch[1])).run();
    if (!result.meta?.changes) return json({ error: "Countdown not found." }, 404);
    await bumpRev(env);
    return json({ ok: true });
  }

  if (cdMatch && method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM countdowns WHERE id = ?`).bind(Number(cdMatch[1])).run();
    if (!result.meta?.changes) return json({ error: "Countdown not found." }, 404);
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path === "/api/polls" && method === "POST") {
    const { error, value } = validatePoll(await readBody(request));
    if (error) return json({ error }, 400);
    const result = await env.DB.prepare(`INSERT INTO polls (question, options) VALUES (?, ?)`).bind(value.question, JSON.stringify(value.options)).run();
    await bumpRev(env);
    ctx.waitUntil(sendPushToAll(env, { title: "My CR · Poll", body: value.question, url: "/#home" }));
    return json({ ok: true, id: result.meta?.last_row_id }, 201);
  }

  if (pollMatch && method === "DELETE") {
    const id = Number(pollMatch[1]);
    const result = await env.DB.prepare(`DELETE FROM polls WHERE id = ?`).bind(id).run();
    if (!result.meta?.changes) return json({ error: "Poll not found." }, 404);
    await env.DB.prepare(`DELETE FROM poll_votes WHERE poll_id = ?`).bind(id).run();
    await bumpRev(env);
    return json({ ok: true });
  }

  // Class routine: the CR saves one whole day at a time (course, time, room, faculty)
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
      env.DB.prepare(`DELETE FROM class_routine WHERE day = ?`).bind(day),
      ...rows.map((r) => env.DB.prepare(`INSERT INTO class_routine (day, course, start_time, end_time, room, faculty) VALUES (?, ?, ?, ?, ?, ?)`).bind(day, r.course, r.start, r.end, r.room, r.faculty)),
    ]);
    await bumpRev(env);
    return json({ ok: true });
  }

  if (path === "/api/settings" && method === "PUT") {
    const body = await readBody(request);
    const ct = parseCtDatetime(body.ct_datetime);
    if (ct.error) return json({ error: ct.error }, 400);
    const title = String(body.syllabus_title ?? "").trim();
    const text = String(body.syllabus_text ?? "").trim();
    if (title.length > 140) return json({ error: "Syllabus heading is too long (max 140)." }, 400);
    if (text.length > 8000) return json({ error: "Syllabus details are too long (max 8000)." }, 400);
    await env.DB.prepare(
      `INSERT INTO settings (id, ct_datetime, syllabus_title, syllabus_text, updated_at)
       VALUES (1, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         ct_datetime = excluded.ct_datetime,
         syllabus_title = excluded.syllabus_title,
         syllabus_text = excluded.syllabus_text,
         updated_at = datetime('now')`
    )
      .bind(ct.value, title, text)
      .run();
    await bumpRev(env);
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
