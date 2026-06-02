# CalDAV Worker

A personal calendar server built on [Cloudflare Workers](https://workers.cloudflare.com) + [D1](https://developers.cloudflare.com/d1/). Multi-user, CalDAV-compatible, syncs with Thunderbird, OneCalendar, DAVx5, and other CalDAV clients.

## Features

- **CalDAV Protocol** — PROPFIND / REPORT / GET / PUT / DELETE / MKCALENDAR / OPTIONS
- **Multi-User** — Isolated calendars, PBKDF2 password hashing, URL path ownership validation
- **iCalendar Import** — Bulk import .ics files with timezone conversion
- **Client Compatible** — Principal discovery, supported-report-set, sync-token, calendar-multiget

## Architecture

```
Browser / CalDAV Client
        │
        ▼
┌──────────────────┐
│  Cloudflare Worker │  src/index.js   Routing + API
│                    │  src/auth.js    Basic Auth (D1 first, env fallback)
│                    │  src/users.js   PBKDF2 passwords + user CRUD
│                    │  src/db.js      D1 data layer
│                    │  src/xml.js     CalDAV XML builder
│                    │  src/ical.js    iCalendar parser/generator
└──────┬───────────┘
       │
       ▼
┌──────────────┐
│  D1 Database  │  users / calendars / events
└──────────────┘
```

### Tables

| Table | Description |
|------|------|
| `users` | Username + PBKDF2 password hash |
| `calendars` | Calendar collections, isolated by `owner` |
| `events` | Calendar events, DTSTART/DTEND stored in UTC |

### API Endpoints

| Method | Path | Auth | Description |
|------|------|------|------|
| `POST` | `/api/register` | admin password | Register new user (auto-creates default calendar) |
| `POST` | `/api/change-password` | Basic Auth | Change own password |
| `POST` | `/api/change-username` | Basic Auth | Change own username |
| `POST` | `/api/delete-user` | admin password | Delete user and all data |
| All | `/:username/...` | Basic Auth | CalDAV protocol (ownership enforced) |

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Deploy

```bash
npm install

# Create D1 database
npx wrangler d1 create caldav-db

# Update database_id in wrangler.jsonc

# Run migration
npx wrangler d1 execute caldav-db --remote --file=migrations/001_schema.sql

# Deploy
npx wrangler deploy
```

### Register Admin

On first deploy with an empty database, the **first registration needs no admin password** (bootstrap mode). After the first user is created, all subsequent registrations require the admin password.

```bash
# First user (bootstrap — no adminPassword needed)
curl -X POST https://your-worker.workers.dev/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"yourpassword"}'

# Subsequent users (admin password required)
curl -X POST https://your-worker.workers.dev/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"mypass","adminPassword":"yourpassword"}'
```

### Import Existing Calendar Data

```bash
node import-events.js
npx wrangler d1 execute caldav-db --remote --file=migrations/002_import_events.sql
```

## Account Management

```bash
# Register a new user (requires admin password)
python3 manage-users.py register alice -p mypass -a adminpass

# Change password
python3 manage-users.py change-password alice -o old -n new

# Change username
python3 manage-users.py change-username alice bob -p mypass

# Delete a user
python3 manage-users.py delete-user bob -a adminpass
```

Password flags (`-p` / `-a` / `-o` / `-n`) can be omitted — when omitted, input is prompted interactively and hidden, avoiding shell history and special character issues.

## Client Setup

### Thunderbird

1. New Calendar → On the Network → CalDAV
2. Fill in:
   - **Username**: your username
   - **Password**: your password
   - **Location**: `https://your-worker.workers.dev/username/default/`

### OneCalendar / DAVx5

- **URL**: `https://your-worker.workers.dev/username/default/`
- **Username**: your username
- **Password**: your password

> If using a custom domain, configure a Worker route in the Cloudflare Dashboard.

## Development

```bash
npm run dev      # Local dev server (http://0.0.0.0:8787)
npm test         # Run tests
npm run deploy   # Deploy to Cloudflare
```

For local D1, add `--local`:

```bash
npx wrangler d1 execute caldav-db --local --command="SELECT * FROM users;"
```

## Security

- Passwords hashed with **PBKDF2** (SHA-256, 100,000 iterations)
- URL path ownership: `/alice/` only accessible by user `alice`
- Admin account cannot be deleted
- `.dev.vars` / `.ics` / `002_import_events.sql` excluded via `.gitignore`

## Directory Structure

```
src/
├── index.js       # Worker entry + CalDAV routes + API routes
├── auth.js        # Basic Auth (D1 first, env secrets fallback)
├── users.js       # Registration, auth, password/username change, user deletion
├── db.js          # Calendar and event D1 CRUD
├── xml.js         # CalDAV XML builder (multistatus/propfind/report)
└── ical.js        # iCalendar parser/generator (with TZID→UTC conversion)
migrations/
└── 001_schema.sql # users + calendars + events tables
test/
└── index.spec.js  # Vitest tests
manage-users.py    # Account management CLI
import-events.js   # .ics bulk import
```
