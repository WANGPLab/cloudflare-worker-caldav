-- CalDAV D1 Schema
-- Run: npx wrangler d1 execute caldav-db --file=migrations/001_schema.sql

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,          -- PBKDF2 hashed password
  created        TEXT NOT NULL DEFAULT (datetime('now')),
  updated        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS calendars (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,        -- e.g. "/user/calendar-name/"
  name        TEXT NOT NULL,               -- display name
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#3366CC',
  created     TEXT NOT NULL DEFAULT (datetime('now')),
  updated     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, path)
);

CREATE INDEX IF NOT EXISTS idx_calendars_owner ON calendars(owner);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid         TEXT NOT NULL,
  ics_data    TEXT NOT NULL,               -- full .ics VEVENT content
  dtstart     TEXT NOT NULL,               -- ISO 8601 UTC for time-range queries
  dtend       TEXT NOT NULL,               -- ISO 8601 UTC
  created     TEXT NOT NULL DEFAULT (datetime('now')),
  updated     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(calendar_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_events_calendar ON events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_events_timerange ON events(calendar_id, dtstart, dtend);
