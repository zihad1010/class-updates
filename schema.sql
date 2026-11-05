CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  body TEXT NOT NULL,
  relevant_date TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notices_pinned_created ON notices (pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ct_datetime TEXT NOT NULL DEFAULT '',
  syllabus_title TEXT NOT NULL DEFAULT '',
  syllabus_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (id, ct_datetime, syllabus_title, syllabus_text) VALUES (1, '', '', '');

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Added for countdowns, polls, reactions and usage stats (the Worker also creates these automatically on first request)
CREATE TABLE IF NOT EXISTS countdowns (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, options TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS poll_votes (poll_id INTEGER NOT NULL, voter_id TEXT NOT NULL, option_idx INTEGER NOT NULL, voter_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (poll_id, voter_id));
CREATE TABLE IF NOT EXISTS reactions (notice_id INTEGER NOT NULL, voter_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (notice_id, voter_id));
CREATE TABLE IF NOT EXISTS devices (voter_id TEXT PRIMARY KEY, first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS class_routine (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, course TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '', faculty TEXT NOT NULL DEFAULT '');
