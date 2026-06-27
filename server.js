const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const cors = require("cors");
const express = require("express");

const app = express();
const PORT = Number.parseInt(process.env.PORT || "3057", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = process.env.BLOOD_DATA_FILE || path.join(DATA_DIR, "glucose-readings.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const MAX_STORED_READINGS = Number.parseInt(process.env.BLOOD_MAX_READINGS || "5000", 10);
const PUBLIC_MIN_READING_DATE = process.env.BLOOD_PUBLIC_MIN_DATE || "2026-01-01";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://blood.aolabs.io",
  "https://aolabs.io",
  "http://127.0.0.1:3057",
  "http://localhost:3057"
];

let pgPoolPromise = null;
let dbReadyPromise = null;

function allowedOrigins() {
  const configured = (process.env.BLOOD_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (process.env.BLOOD_ALLOW_ALL_ORIGINS === "1") return true;
  return allowedOrigins().has(origin);
}

app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
  credentials: false
}));
app.use(express.json({ limit: "1mb" }));

function extractToken(req) {
  const authorization = req.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return (
    bearer?.[1] ||
    req.get("x-blood-token") ||
    req.get("x-blood-ingest-token") ||
    req.query.token ||
    ""
  ).trim();
}

function requireConfiguredToken(envName, purpose) {
  return (req, res, next) => {
    const expected = process.env[envName];
    if (!expected) {
      res.status(503).json({ ok: false, error: "token_not_configured", purpose });
      return;
    }

    const actual = extractToken(req);
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    const matches = expectedBuffer.length === actualBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, actualBuffer);

    if (!matches) {
      res.status(401).json({ ok: false, error: "unauthorized", purpose });
      return;
    }

    next();
  };
}

function parseTime(value, field) {
  const time = new Date(value);
  if (!value || Number.isNaN(time.getTime())) {
    const error = new Error(`invalid_${field}`);
    error.status = 400;
    throw error;
  }
  return time.toISOString();
}

function offsetMinutes(offset) {
  const match = String(offset || "").match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number.parseInt(match[2], 10) * 60 + Number.parseInt(match[3], 10));
}

function readingDateFromTime(measuredAt, zoneOffset) {
  const time = new Date(measuredAt).getTime();
  const shifted = new Date(time + offsetMinutes(zoneOffset) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function normalizeNumber(value) {
  if (value === null || value === undefined) return NaN;
  const cleaned = String(value)
    .trim()
    .replace(/,/g, "")
    .replace(/[^\d.+-]/g, "");
  return Number.parseFloat(cleaned);
}

function normalizeGlucoseMgDl(reading) {
  const explicitMgDl = normalizeNumber(
    reading.valueMgDl ?? reading.mgDl ?? reading.mgdl ?? reading.glucoseMgDl
  );
  if (Number.isFinite(explicitMgDl)) return Math.round(explicitMgDl);

  const unit = String(reading.unit || "").toLowerCase();
  const value = normalizeNumber(reading.value ?? reading.glucose ?? reading.bloodGlucose);
  if (Number.isFinite(value)) {
    if (/mmol/.test(unit)) return Math.round(value * 18.0182);
    return Math.round(value);
  }

  const mmol = normalizeNumber(reading.valueMmolL ?? reading.mmolL ?? reading.mmol);
  if (Number.isFinite(mmol)) return Math.round(mmol * 18.0182);

  const error = new Error("invalid_glucose_value");
  error.status = 400;
  throw error;
}

function stableReadingId(reading) {
  const basis = [
    reading.readingId,
    reading.clientRecordId,
    reading.sourcePackage,
    reading.source,
    reading.measuredAt,
    reading.valueMgDl
  ].filter(Boolean).join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function sanitizeReading(reading, capturedAt, source) {
  if (!reading || typeof reading !== "object") {
    const error = new Error("invalid_reading");
    error.status = 400;
    throw error;
  }

  const measuredAt = parseTime(
    reading.measuredAt || reading.time || reading.timestamp || reading.dateTime,
    "measured_at"
  );
  const valueMgDl = normalizeGlucoseMgDl(reading);
  if (valueMgDl < 10 || valueMgDl > 1000) {
    const error = new Error("glucose_value_out_of_range");
    error.status = 400;
    throw error;
  }

  const sanitized = {
    readingId: "",
    clientRecordId: String(reading.clientRecordId || reading.readingId || "").slice(0, 180),
    source: String(source || reading.source || "manual").slice(0, 80),
    sourcePackage: String(reading.sourcePackage || "").slice(0, 180),
    measuredAt,
    zoneOffset: String(reading.zoneOffset || "").slice(0, 12),
    valueMgDl,
    unit: "mg/dL",
    mealType: String(reading.mealType || reading.meal || "").slice(0, 80),
    relationToMeal: String(reading.relationToMeal || reading.mealRelation || reading.marker || "").slice(0, 80),
    specimenSource: String(reading.specimenSource || "").slice(0, 80),
    notes: reading.notes ? String(reading.notes).slice(0, 320) : "",
    capturedAt
  };
  sanitized.readingDate = readingDateFromTime(sanitized.measuredAt, sanitized.zoneOffset);
  sanitized.readingId = stableReadingId(sanitized);
  return sanitized;
}

function sanitizePayload(payload) {
  const capturedAt = parseTime(payload?.capturedAt || new Date().toISOString(), "captured_at");
  const source = payload?.source || "manual";
  const readings = Array.isArray(payload?.readings) ? payload.readings : [];
  if (!readings.length) {
    const error = new Error("no_readings");
    error.status = 400;
    throw error;
  }
  if (readings.length > 500) {
    const error = new Error("too_many_readings");
    error.status = 400;
    throw error;
  }
  return readings.map((reading) => sanitizeReading(reading, capturedAt, source));
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((csvRow) => csvRow.some((value) => value !== ""));
}

function headerKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findHeader(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(headerKey(header))));
}

function parseContourDateTime(dateValue, timeValue) {
  const raw = [dateValue, timeValue].filter(Boolean).join(" ").trim();
  let parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();

  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (!match) {
    const error = new Error("invalid_csv_datetime");
    error.status = 400;
    throw error;
  }

  let month = Number.parseInt(match[1], 10);
  let day = Number.parseInt(match[2], 10);
  let year = Number.parseInt(match[3], 10);
  if (year < 100) year += 2000;
  let hour = Number.parseInt(match[4] || "0", 10);
  const minute = Number.parseInt(match[5] || "0", 10);
  const second = Number.parseInt(match[6] || "0", 10);
  const meridiem = (match[7] || "").toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  parsed = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error("invalid_csv_datetime");
    error.status = 400;
    throw error;
  }
  return parsed.toISOString();
}

function parseContourCsv(text, capturedAt = new Date().toISOString()) {
  const rows = parseCsvRows(String(text || ""));
  if (rows.length < 2) {
    const error = new Error("csv_missing_rows");
    error.status = 400;
    throw error;
  }

  const headers = rows[0];
  const timestampIndex = findHeader(headers, [/^(date time|datetime|timestamp|reading date time|test date time)$/]);
  const dateIndex = findHeader(headers, [/^(date|reading date|test date)$/]);
  const timeIndex = findHeader(headers, [/^(time|reading time|test time)$/]);
  const valueIndex = findHeader(headers, [
    /glucose/,
    /^bg$/,
    /^blood sugar$/,
    /^reading$/,
    /^result$/,
    /^value$/
  ]);
  const unitIndex = findHeader(headers, [/^unit$/, /units/]);
  const relationIndex = findHeader(headers, [/meal/, /marker/, /tag/]);
  const notesIndex = findHeader(headers, [/note/, /comment/]);

  if (timestampIndex < 0 && dateIndex < 0) {
    const error = new Error("csv_missing_date_column");
    error.status = 400;
    throw error;
  }
  if (valueIndex < 0) {
    const error = new Error("csv_missing_glucose_column");
    error.status = 400;
    throw error;
  }

  const readings = [];
  for (const row of rows.slice(1)) {
    const measuredAt = timestampIndex >= 0
      ? parseContourDateTime(row[timestampIndex], "")
      : parseContourDateTime(row[dateIndex], timeIndex >= 0 ? row[timeIndex] : "");
    const unit = unitIndex >= 0 ? row[unitIndex] : "mg/dL";
    readings.push({
      clientRecordId: crypto.createHash("sha1").update(row.join("|")).digest("hex"),
      measuredAt,
      value: row[valueIndex],
      unit,
      relationToMeal: relationIndex >= 0 ? row[relationIndex] : "",
      notes: notesIndex >= 0 ? row[notesIndex] : ""
    });
  }

  return sanitizePayload({
    source: "contour-csv",
    capturedAt,
    readings
  });
}

async function getPgPool() {
  if (!DATABASE_URL) return null;
  if (!pgPoolPromise) {
    pgPoolPromise = import("pg").then(({ Pool }) => new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) || process.env.PGSSLMODE === "disable"
        ? false
        : { rejectUnauthorized: false }
    }));
  }
  return pgPoolPromise;
}

async function ensureDb() {
  const pool = await getPgPool();
  if (!pool) return;
  if (!dbReadyPromise) {
    dbReadyPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS blood_readings (
        reading_id TEXT PRIMARY KEY,
        measured_at TIMESTAMPTZ NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS blood_readings_measured_at_idx ON blood_readings (measured_at DESC);
    `);
  }
  await dbReadyPromise;
}

async function readJsonReadings() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.readings) ? parsed.readings : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonReadings(readings) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({
    updatedAt: new Date().toISOString(),
    readings
  }, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

async function readReadings() {
  const pool = await getPgPool();
  if (pool) {
    await ensureDb();
    const result = await pool.query(
      "SELECT payload FROM blood_readings ORDER BY measured_at DESC LIMIT $1",
      [MAX_STORED_READINGS]
    );
    return result.rows.map((row) => row.payload);
  }
  return readJsonReadings();
}

async function storeReadings(readings) {
  const pool = await getPgPool();
  if (pool) {
    await ensureDb();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const reading of readings) {
        await client.query(`
          INSERT INTO blood_readings (reading_id, measured_at, captured_at, payload, updated_at)
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (reading_id)
          DO UPDATE SET
            measured_at = EXCLUDED.measured_at,
            captured_at = EXCLUDED.captured_at,
            payload = EXCLUDED.payload,
            updated_at = now()
        `, [reading.readingId, reading.measuredAt, reading.capturedAt, reading]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const existing = await readJsonReadings();
  const byId = new Map(existing.map((reading) => [reading.readingId, reading]));
  for (const reading of readings) byId.set(reading.readingId, reading);
  const next = Array.from(byId.values())
    .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
    .slice(0, MAX_STORED_READINGS);
  await writeJsonReadings(next);
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function dayStats(readings) {
  const byDate = new Map();
  for (const reading of readings) {
    const date = reading.readingDate || readingDateFromTime(reading.measuredAt, reading.zoneOffset);
    const group = byDate.get(date) || [];
    group.push(reading.valueMgDl);
    byDate.set(date, group);
  }
  return Array.from(byDate.entries())
    .map(([date, values]) => ({
      date,
      count: values.length,
      minMgDl: Math.min(...values),
      maxMgDl: Math.max(...values),
      avgMgDl: average(values)
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function summarizeReadings(readings) {
  const normalized = readings
    .filter((reading) => reading?.measuredAt && Number.isFinite(Number(reading.valueMgDl)))
    .map((reading) => ({
      ...reading,
      readingDate: reading.readingDate || readingDateFromTime(reading.measuredAt, reading.zoneOffset)
    }))
    .filter((reading) => reading.readingDate >= PUBLIC_MIN_READING_DATE)
    .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime());

  if (!normalized.length) {
    return {
      ok: true,
      status: "waiting_for_contour_sync",
      generatedAt: new Date().toISOString(),
      recordCount: 0,
      latest: null,
      readings: [],
      trend: [],
      days: [],
      publicMinReadingDate: PUBLIC_MIN_READING_DATE,
      message: "No readings have reached Blood. Health Connect has not uploaded Contour glucose records; if Contour is not listed in Health Connect, use a Contour CSV export/import path."
    };
  }

  const trendDesc = normalized.slice(0, 180);
  const values = trendDesc.map((reading) => reading.valueMgDl);
  return {
    ok: true,
    status: "connected",
    generatedAt: new Date().toISOString(),
    recordCount: normalized.length,
    latest: normalized[0],
    lastCapturedAt: normalized
      .map((reading) => reading.capturedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    publicMinReadingDate: PUBLIC_MIN_READING_DATE,
    summary: {
      minMgDl: Math.min(...values),
      maxMgDl: Math.max(...values),
      avgMgDl: average(values)
    },
    readings: normalized.slice(0, 30),
    trend: trendDesc.reverse(),
    days: dayStats(normalized).slice(0, 45)
  };
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "blood-aolabs",
    generatedAt: new Date().toISOString(),
    storage: DATABASE_URL ? "postgres" : "json-file",
    ingestionTokenConfigured: Boolean(process.env.BLOOD_INGEST_TOKEN),
    summaryReadAccess: "public",
    publicMinReadingDate: PUBLIC_MIN_READING_DATE,
    exportReadTokenConfigured: Boolean(process.env.BLOOD_READ_TOKEN)
  });
});

app.get("/api/blood/summary", async (_req, res, next) => {
  try {
    res.json(summarizeReadings(await readReadings()));
  } catch (error) {
    next(error);
  }
});

app.get("/api/blood/export", requireConfiguredToken("BLOOD_READ_TOKEN", "export"), async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      readings: await readReadings()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ingest/glucose-readings", requireConfiguredToken("BLOOD_INGEST_TOKEN", "ingest"), async (req, res, next) => {
  try {
    const readings = sanitizePayload(req.body);
    await storeReadings(readings);
    const latest = [...readings].sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())[0];
    console.info(JSON.stringify({
      event: "blood_ingest_accepted",
      accepted: readings.length,
      latestReadingDate: latest?.readingDate || null,
      latestMeasuredAt: latest?.measuredAt || null,
      capturedAt: latest?.capturedAt || null,
      source: latest?.source || null
    }));
    res.json({
      ok: true,
      accepted: readings.length,
      readingIds: readings.map((reading) => reading.readingId)
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/ingest/contour-csv",
  requireConfiguredToken("BLOOD_INGEST_TOKEN", "ingest"),
  express.text({ type: ["text/*", "application/csv", "application/vnd.ms-excel", "application/octet-stream"], limit: "4mb" }),
  async (req, res, next) => {
    try {
      const capturedAt = parseTime(req.query.capturedAt || new Date().toISOString(), "captured_at");
      const readings = parseContourCsv(req.body || "", capturedAt);
      await storeReadings(readings);
      const latest = [...readings].sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())[0];
      console.info(JSON.stringify({
        event: "blood_contour_csv_accepted",
        accepted: readings.length,
        latestReadingDate: latest?.readingDate || null,
        latestMeasuredAt: latest?.measuredAt || null,
        capturedAt
      }));
      res.json({
        ok: true,
        accepted: readings.length,
        readingIds: readings.map((reading) => reading.readingId)
      });
    } catch (error) {
      next(error);
    }
  }
);

app.use(express.static(__dirname, {
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "5m" : 0,
  etag: true
}));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  next();
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    error: status >= 500 ? "server_error" : error.message,
    message: status >= 500 ? "Blood API error." : error.message
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`blood.aolabs.io listening on ${PORT}`);
  });
}

module.exports = {
  app,
  normalizeGlucoseMgDl,
  parseContourCsv,
  sanitizePayload,
  summarizeReadings
};
