# Pulseboard — Intelligent API Monitoring & Alert System

A Node.js / Express service that watches the responses of external healthcare APIs (patient data,
appointments, caregiver schedules, billing, labs…), detects anomalies, and turns them into short,
human-readable alerts written by an LLM (Gemini or OpenAI). Alerts are stored in MongoDB, served
over a REST API, shown in a responsive dashboard, and can be e-mailed.

> Example alert produced by the system
> **AppointmentAPI failed with status 500, took 5500 ms to respond and returned 0 records. Possible outage or data issue.**
> Next step: check provider status and server logs, then retry once the error rate drops.

---

## Features

| Requirement | How it is met |
|---|---|
| Input: static JSON file | `npm run monitor:file -- path/to/file.json`, `POST /monitor/sample`, or drag-and-drop a file in the dashboard |
| Input: `POST /monitor` | Accepts an array, `{ "responses": [...] }` or a single object; up to 1000 items per batch |
| Automatic monitoring | Optional scheduler polls real endpoints from `src/config/targets.json` every N seconds |
| Health checks | Response time, HTTP status code, returned data (missing / negative / non-numeric / zero records) |
| Anomaly detection | 11 anomaly types, global + per-API thresholds, and a statistical baseline (mean + 3σ) per API |
| AI alerts | Gemini or any OpenAI-compatible model; batched, parallel, validated JSON output; rule-based fallback so no alert is ever lost |
| Storage | MongoDB via Mongoose (unique partial index = one open incident per problem). Falls back to in-memory when `MONGODB_URI` is empty |
| `GET /alerts` | Active anomalies by default; filters for status, severity, API, free text; pagination |
| Frontend | Responsive dashboard (phone, tablet, desktop, light/dark) served by the same server |
| Write access | Optional `MONITOR_API_KEY`; Render generates one automatically for deployed writes |
| E-mail (optional) | Automatic mail on new critical alerts + "Email report" button (`POST /alerts/report/email`) |
| Batch processing | Batches are grouped and de-duplicated, LLM calls are chunked (8 per call) and run 3 in parallel |
| Error handling | Central error handler, consistent JSON errors with request id, malformed items never crash a batch |
| Logging | Winston: coloured console in dev, JSON in production, optional rotating files; every request logged with id and duration |

---

## Quick start (local)

Requirements: **Node.js 22+**.

```bash
npm install
cp .env.example .env        # optional – works with no changes
npm start                   # http://localhost:4000
```

Open http://localhost:4000 and click **Run sample file**.

With no `.env` values the app uses in-memory storage and the built-in rule-based writer. Add
`GEMINI_API_KEY` (free at https://aistudio.google.com/apikey) for AI-written alerts and
`MONGODB_URI` for persistent storage.

```bash
npm test                    # unit + integration tests
npm run dev                 # auto-restart on file changes
npm run monitor:file        # run data/sample-responses.json from the command line
```

---

## Deploy (Render + MongoDB Atlas + Gemini) – about 10 minutes

1. **MongoDB Atlas** – create a free M0 cluster → Database Access: add a user → Network Access:
   allow only the deployment provider's outbound IPs where available → Connect → Drivers → copy the `mongodb+srv://…` string and add a database
   name, e.g. `…mongodb.net/api_monitor?retryWrites=true&w=majority`.
2. **Gemini key** – https://aistudio.google.com/apikey → Create API key.
3. **GitHub** – push this folder to a new repository.
4. **Render** – New + → **Blueprint** → choose the repo (it reads `render.yaml`).
   Fill in `MONGODB_URI` and `GEMINI_API_KEY` when asked; Render generates a `MONITOR_API_KEY` → Apply.
5. Open the `https://<name>.onrender.com` URL. The header should show *AI: gemini-2.5-flash* and
   *MongoDB*. Click **Run sample file**.

The included `src/config/targets.json` contains public demo endpoints, not company or patient APIs.
The Render scheduler is off by default so deployment will not poll those demo targets indefinitely.
Replace them with approved endpoints and configure any required headers using deployment secrets
before setting `ENABLE_SCHEDULER=true`. Never commit `.env`, API keys, credentials, or patient data.
Render generates the write API key; the dashboard asks for it the first time a write action is used.

Other hosts: any Node host works (`npm ci && npm start`), and a `Dockerfile` is included
(`docker build -t api-monitor . && docker run -p 4000:4000 --env-file .env api-monitor`).
Railway / Koyeb / a VPS work the same way; just set the environment variables.

---

## API reference

All endpoints are also available under `/api` (e.g. `/api/alerts`).

| Method | Path | Description |
|---|---|---|
| `POST` | `/monitor` | Analyse one response or a batch. Returns a summary, a per-item result and the created / updated alerts. `201` when new alerts were created |
| `POST` | `/monitor/sample` | Run the bundled `data/sample-responses.json` |
| `POST` | `/monitor/simulate?count=24` | Generate and analyse realistic random traffic (1–200) |
| `POST` | `/monitor/poll` | Probe the live endpoints in `targets.json` now |
| `GET` | `/monitor/apis` | Per-API health: checks, uptime %, average latency, last 30 checks |
| `GET` | `/monitor/status` | AI provider, storage, e-mail, scheduler and thresholds in use |
| `GET` | `/alerts` | **Active anomalies**. Query: `status=active\|resolved\|all`, `severity=critical\|warning`, `api=`, `q=`, `limit=`, `page=` |
| `GET` | `/alerts/stats` | Counts by severity / status and open incidents per API |
| `GET` | `/alerts/:id` | One alert |
| `PATCH` | `/alerts/:id/resolve` | Resolve an alert |
| `PATCH` | `/alerts/:id/reopen` | Reopen a resolved alert |
| `POST` | `/alerts/resolve-all` | Resolve all open alerts (optional body `{ "severity", "api" }`) |
| `POST` | `/alerts/report/email` | E-mail a report of all open alerts |
| `GET` | `/health` | Liveness probe |

Example:

```bash
curl -X POST http://localhost:4000/monitor -H "Content-Type: application/json" -d '[
  {"api_name":"PatientDataAPI","response_time_ms":1200,"status_code":200,"records_returned":50},
  {"api_name":"AppointmentAPI","response_time_ms":5500,"status_code":500,"records_returned":0}
]'

curl http://localhost:4000/alerts
```

Response of `POST /monitor` (shortened):

```json
{
  "summary": { "received": 2, "healthy": 1, "anomalous": 1, "invalid": 0,
               "alertsCreated": 1, "alertsUpdated": 0,
               "ai": { "provider": "gemini", "model": "gemini-2.5-flash" }, "durationMs": 912 },
  "results": [
    { "index": 0, "api_name": "PatientDataAPI", "status": "healthy", "anomalies": [] },
    { "index": 1, "api_name": "AppointmentAPI", "status": "anomaly", "severity": "critical",
      "anomalies": [ { "type": "SERVER_ERROR", "detail": "Server error (HTTP 500)" }, "…" ],
      "alertId": "6717a…" }
  ],
  "alerts": { "created": [ { "message": "AppointmentAPI failed with status 500 …", "…": "…" } ], "updated": [] }
}
```

Errors always look like
`{ "error": { "code": "BAD_REQUEST", "message": "…", "requestId": "…" } }`.

---

## Detection rules

| Type | Condition | Severity |
|---|---|---|
| `SERVER_ERROR` | status 5xx | critical |
| `TIMEOUT` | status 408 / 504, or 0 (no response) | critical |
| `HIGH_RESPONSE_TIME` | ≥ 2000 ms warning, ≥ 5000 ms critical (per-API overrides in `src/config/apiRules.json`) | warning / critical |
| `LATENCY_SPIKE` | below the static limit but > mean + 3σ of this API's last 50 successful checks | warning |
| `CLIENT_ERROR` | status 4xx | warning |
| `RATE_LIMITED` | status 429 | warning |
| `ZERO_RECORDS` | `records_returned` below the API's minimum (default 1) | warning |
| `INCONSISTENT_PAYLOAD` | request failed but still reports records | warning |
| `MISSING_FIELD` | `status_code`, `response_time_ms` or `records_returned` missing | warning |
| `INVALID_FIELD` | negative / non-numeric / non-integer values (numeric strings are noted as info) | warning |
| `MALFORMED_RESPONSE` | item is not an object or has no `api_name` | warning |

All anomalies found in one response become **one alert** (as in the assignment example).
The alert's *fingerprint* is `api_name + set of anomaly types`. While an alert with the same
fingerprint is open, new occurrences only increase its counter and update the latest sample, so an
outage that repeats 500 times is one alert "seen 500 times", not 500 alerts — and no extra LLM calls.
If an open warning escalates to critical, its text is rewritten.

---

## AI alert generation

* Providers: **Gemini** (`GEMINI_API_KEY`) or **OpenAI / any OpenAI-compatible API**
  (`OPENAI_API_KEY`, `OPENAI_BASE_URL`). Called over plain REST, no SDK lock-in.
* Prompts live in `src/services/llm/prompts.js` (versioned) and are documented in
  `docs/AI_Prompts.docx`. The model gets only the facts (API name, metrics, findings) and must
  answer in JSON: `title`, `message`, `likely_cause`, `impact`, `recommended_action`.
* Output is validated with Zod; an answer that doesn't name the right API is rejected (guards
  against hallucinated attribution).
* Anomalies are sent 8 per call, with up to 3 calls in parallel, a 15 s timeout and retry with
  backoff on 429/5xx.
* If there is no key, the call fails, or an item is invalid, the deterministic rule-based writer
  produces the alert instead. Each alert records which writer produced it (`aiSource`).

For a production integration, configure real approved API targets and their authentication outside
source control. The demo configuration is intended for the interview walkthrough only.

---

## Architecture

```
            Static JSON file ─┐        ┌─ Scheduler (polls targets.json)
 POST /monitor ── validate ───┼────────┤
                              ▼
                  monitorService.processBatch
          ┌──────────────┬────────────┴───────────┬──────────────┐
          ▼              ▼                        ▼              ▼
   anomalyDetector  apiHealthRegistry      aiAlertService   emailService
   (pure rules +    (rolling baseline,     (Gemini/OpenAI,  (nodemailer,
    thresholds)      dashboard history)     fallback)        critical alerts)
                              │
                              ▼
                   Alert repository  ──  MongoDB (Mongoose) | in-memory
                              │
         GET /alerts, /alerts/stats, PATCH resolve  ──►  Dashboard (public/)
```

```
src/
  app.js                  Express app (security headers, CORS, compression, routes, errors)
  server.js               Startup, DB connection, graceful shutdown
  config/                 env config, per-API rules, polling targets
  routes/                 route table
  controllers/            thin HTTP layer
  services/
    anomalyDetector.js    detection rules (pure, unit-tested)
    monitorService.js     batch pipeline: detect → group → de-duplicate → AI → store → notify
    aiAlertService.js     provider selection, chunking, validation, fallback
    llm/                  prompts, Gemini + OpenAI providers, rule-based writer
    apiHealthRegistry.js  per-API rolling stats
    emailService.js       HTML/text reports
    simulator.js          demo traffic
  repositories/           Mongo + memory implementations of one interface
  models/Alert.js         Mongoose schema and indexes
  jobs/scheduler.js       automatic polling of live endpoints
  middleware/             request id + logging, API key, error handler
  validators/             Zod schemas
  scripts/monitorFile.js  CLI for static JSON files
public/                   dashboard (HTML/CSS/JS, no build step)
tests/                    node:test + supertest
data/sample-responses.json
docs/                     AI_Prompts.docx, requests.http
```

### Scalability notes

* Stateless HTTP layer; storage is behind a repository interface, so MongoDB can be scaled or
  replaced without touching business logic.
* Indexed queries (`status, severity, lastSeenAt`) and a unique partial index on `fingerprint`
  keep de-duplication correct even when several instances process batches at the same time.
* LLM cost grows with *new incidents*, not with traffic volume.
* For many instances, `apiHealthRegistry` (in-process rolling stats) would move to Redis and the
  scheduler would run as a single worker or queue consumer; the interfaces are already separated.

---

## Configuration

See `.env.example` — every setting is documented there. The most important ones:

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | *(empty)* | MongoDB connection; empty = in-memory |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | *(empty)* | Enables AI alert text |
| `RESPONSE_TIME_WARN_MS` / `_CRITICAL_MS` | 2000 / 5000 | Latency limits |
| `ENABLE_SCHEDULER`, `POLL_INTERVAL_MS` | false, 60000 | Automatic polling |
| `EMAIL_ENABLED`, `SMTP_*`, `EMAIL_TO` | off | E-mail reports |
| `MONITOR_API_KEY` | *(empty)* | Require `x-api-key` on write endpoints |

---

## AI usage disclosure

AI tools were used while building this project. All prompts are documented in
`docs/AI_Prompts.docx`, as the assignment requires.
