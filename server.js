const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const cors = require("cors");
const express = require("express");

const app = express();
const PORT = Number.parseInt(process.env.PORT || "3057", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = process.env.BLOOD_DATA_FILE || path.join(DATA_DIR, "glucose-readings.json");
const HEALTH_FILE = process.env.BLOOD_HEALTH_DATA_FILE || path.join(DATA_DIR, "health-metrics.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const MAX_STORED_READINGS = Number.parseInt(process.env.BLOOD_MAX_READINGS || "5000", 10);
const MAX_STORED_HEALTH_METRICS = Number.parseInt(process.env.BLOOD_MAX_HEALTH_METRICS || "12000", 10);
const MAX_HEALTH_METRICS_PER_TYPE = Number.parseInt(process.env.BLOOD_MAX_HEALTH_METRICS_PER_TYPE || "30000", 10);
const JSON_BODY_LIMIT = process.env.BLOOD_JSON_LIMIT || "8mb";
const PUBLIC_MIN_READING_DATE = process.env.BLOOD_PUBLIC_MIN_DATE || "2026-01-01";
const SLEEP_SUMMARY_URL = process.env.BLOOD_SLEEP_SUMMARY_URL || "https://sleep.aolabs.io/api/sleep/summary";
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
app.use(express.json({ limit: JSON_BODY_LIMIT }));

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

function clampText(value, max = 180) {
  return String(value || "").slice(0, max);
}

function metricDateFromTime(value, zoneOffset) {
  return readingDateFromTime(value, zoneOffset);
}

function stableMetricId(metric) {
  const basis = [
    metric.metricId,
    metric.clientRecordId,
    metric.type,
    metric.sourcePackage,
    metric.measuredAt,
    metric.startTime,
    metric.endTime,
    metric.value
  ].filter(Boolean).join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function numberInRange(value, min, max, field) {
  const number = normalizeNumber(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`invalid_${field}`);
    error.status = 400;
    throw error;
  }
  return number;
}

function sleepStageTotals(stages = []) {
  const totals = {
    awake: 0,
    light: 0,
    deep: 0,
    rem: 0,
    sleeping: 0,
    unknown: 0,
    outOfBed: 0
  };
  for (const stage of Array.isArray(stages) ? stages : []) {
    const start = new Date(stage.startTime).getTime();
    const end = new Date(stage.endTime).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const minutes = Math.round((end - start) / 60_000);
    const key = String(stage.stage || "").toLowerCase().replace(/[^a-z]/g, "");
    if (key.includes("awake")) totals.awake += minutes;
    else if (key.includes("light")) totals.light += minutes;
    else if (key.includes("deep")) totals.deep += minutes;
    else if (key.includes("rem")) totals.rem += minutes;
    else if (key.includes("outofbed")) totals.outOfBed += minutes;
    else if (key.includes("sleeping")) totals.sleeping += minutes;
    else totals.unknown += minutes;
  }
  return totals;
}

function sanitizeHealthMetric(metric, type, capturedAt, source) {
  if (!metric || typeof metric !== "object") {
    const error = new Error("invalid_health_metric");
    error.status = 400;
    throw error;
  }

  if (type === "heart_rate") {
    const measuredAt = parseTime(metric.measuredAt || metric.time || metric.timestamp, "heart_rate_time");
    const value = Math.round(numberInRange(metric.valueBpm ?? metric.bpm ?? metric.value, 25, 240, "heart_rate"));
    const sanitized = {
      metricId: "",
      clientRecordId: clampText(metric.clientRecordId || metric.metricId),
      type,
      source: clampText(source || metric.source || "health-connect", 80),
      sourcePackage: clampText(metric.sourcePackage),
      measuredAt,
      date: metricDateFromTime(measuredAt, metric.zoneOffset),
      value,
      unit: "bpm",
      capturedAt
    };
    sanitized.metricId = stableMetricId(sanitized);
    return sanitized;
  }

  if (type === "hrv") {
    const measuredAt = parseTime(metric.measuredAt || metric.time || metric.timestamp, "hrv_time");
    const value = Math.round(numberInRange(metric.rmssdMs ?? metric.valueMs ?? metric.value, 1, 300, "hrv"));
    const sanitized = {
      metricId: "",
      clientRecordId: clampText(metric.clientRecordId || metric.metricId),
      type,
      source: clampText(source || metric.source || "health-connect", 80),
      sourcePackage: clampText(metric.sourcePackage),
      measuredAt,
      date: metricDateFromTime(measuredAt, metric.zoneOffset),
      value,
      unit: "ms",
      capturedAt
    };
    sanitized.metricId = stableMetricId(sanitized);
    return sanitized;
  }

  if (type === "steps") {
    const startTime = parseTime(metric.startTime || metric.start || metric.measuredAt, "steps_start");
    const endTime = parseTime(metric.endTime || metric.end || metric.measuredAt, "steps_end");
    const value = Math.round(numberInRange(metric.count ?? metric.steps ?? metric.value, 0, 200000, "steps"));
    const sanitized = {
      metricId: "",
      clientRecordId: clampText(metric.clientRecordId || metric.metricId),
      type,
      source: clampText(source || metric.source || "health-connect", 80),
      sourcePackage: clampText(metric.sourcePackage),
      startTime,
      endTime,
      measuredAt: endTime,
      date: metricDateFromTime(endTime, metric.zoneOffset),
      value,
      unit: "steps",
      capturedAt
    };
    sanitized.metricId = stableMetricId(sanitized);
    return sanitized;
  }

  if (type === "sleep") {
    const startTime = parseTime(metric.startTime || metric.start, "sleep_start");
    const endTime = parseTime(metric.endTime || metric.end, "sleep_end");
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    if (end <= start) {
      const error = new Error("invalid_sleep_duration");
      error.status = 400;
      throw error;
    }
    const durationMinutes = Math.round((end - start) / 60_000);
    const stageMinutes = sleepStageTotals(metric.stages);
    const awakeMinutes = stageMinutes.awake + stageMinutes.outOfBed;
    const asleepMinutes = Math.max(0, durationMinutes - awakeMinutes);
    const sanitized = {
      metricId: "",
      clientRecordId: clampText(metric.clientRecordId || metric.sessionId || metric.metricId),
      type,
      source: clampText(source || metric.source || "health-connect", 80),
      sourcePackage: clampText(metric.sourcePackage),
      startTime,
      endTime,
      measuredAt: endTime,
      date: metric.sleepDate || metricDateFromTime(endTime, metric.endZoneOffset || metric.zoneOffset),
      value: asleepMinutes,
      unit: "minutes_asleep",
      durationMinutes,
      asleepMinutes,
      awakeMinutes,
      stageMinutes,
      capturedAt
    };
    sanitized.metricId = stableMetricId(sanitized);
    return sanitized;
  }

  const error = new Error("unsupported_health_metric");
  error.status = 400;
  throw error;
}

function sanitizeHealthPayload(payload) {
  const capturedAt = parseTime(payload?.capturedAt || new Date().toISOString(), "captured_at");
  const source = payload?.source || "health-connect";
  const specs = [
    ["heart_rate", payload?.heartRate || payload?.heartRates || []],
    ["hrv", payload?.hrv || payload?.heartRateVariability || []],
    ["steps", payload?.steps || []],
    ["sleep", payload?.sleepSessions || payload?.sleep || []]
  ];
  const metrics = [];
  for (const [type, records] of specs) {
    if (!Array.isArray(records)) continue;
    if (records.length > MAX_HEALTH_METRICS_PER_TYPE) {
      const error = new Error("too_many_health_metrics");
      error.status = 400;
      throw error;
    }
    for (const record of records) {
      metrics.push(sanitizeHealthMetric(record, type, capturedAt, source));
    }
  }
  if (!metrics.length) {
    const error = new Error("no_health_metrics");
    error.status = 400;
    throw error;
  }
  return metrics;
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
      CREATE TABLE IF NOT EXISTS health_metrics (
        metric_id TEXT PRIMARY KEY,
        metric_type TEXT NOT NULL,
        measured_at TIMESTAMPTZ NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS health_metrics_type_time_idx ON health_metrics (metric_type, measured_at DESC);
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

async function readJsonHealthMetrics() {
  try {
    const raw = await fs.readFile(HEALTH_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.metrics) ? parsed.metrics : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonHealthMetrics(metrics) {
  await fs.mkdir(path.dirname(HEALTH_FILE), { recursive: true });
  const tmp = `${HEALTH_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({
    updatedAt: new Date().toISOString(),
    metrics
  }, null, 2));
  await fs.rename(tmp, HEALTH_FILE);
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

async function readHealthMetrics() {
  const pool = await getPgPool();
  if (pool) {
    await ensureDb();
    const result = await pool.query(
      "SELECT payload FROM health_metrics ORDER BY measured_at DESC LIMIT $1",
      [MAX_STORED_HEALTH_METRICS]
    );
    return result.rows.map((row) => row.payload);
  }
  return readJsonHealthMetrics();
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

async function storeHealthMetrics(metrics) {
  const pool = await getPgPool();
  if (pool) {
    await ensureDb();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const metric of metrics) {
        await client.query(`
          INSERT INTO health_metrics (metric_id, metric_type, measured_at, captured_at, payload, updated_at)
          VALUES ($1, $2, $3, $4, $5, now())
          ON CONFLICT (metric_id)
          DO UPDATE SET
            metric_type = EXCLUDED.metric_type,
            measured_at = EXCLUDED.measured_at,
            captured_at = EXCLUDED.captured_at,
            payload = EXCLUDED.payload,
            updated_at = now()
        `, [metric.metricId, metric.type, metric.measuredAt, metric.capturedAt, metric]);
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

  const existing = await readJsonHealthMetrics();
  const byId = new Map(existing.map((metric) => [metric.metricId, metric]));
  for (const metric of metrics) byId.set(metric.metricId, metric);
  const next = Array.from(byId.values())
    .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
    .slice(0, MAX_STORED_HEALTH_METRICS);
  await writeJsonHealthMetrics(next);
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

function latestMetric(metrics, type) {
  return metrics
    .filter((metric) => metric.type === type)
    .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())[0] || null;
}

function latestSleepFromFallback(sleepSummary) {
  const latest = sleepSummary?.latest;
  if (!latest?.endTime) return null;
  return {
    metricId: `sleep-api-${latest.sleepDate || latest.endTime}`,
    type: "sleep",
    source: "sleep-api",
    sourcePackage: latest.sourcePackage || "",
    startTime: latest.startTime,
    endTime: latest.endTime,
    measuredAt: latest.endTime,
    date: latest.sleepDate || latest.endTime.slice(0, 10),
    value: latest.asleepMinutes ?? Math.max(0, (latest.durationMinutes || 0) - (latest.awakeMinutes || 0)),
    unit: "minutes_asleep",
    durationMinutes: latest.durationMinutes || null,
    asleepMinutes: latest.asleepMinutes ?? null,
    awakeMinutes: latest.awakeMinutes ?? null,
    stageMinutes: latest.stageMinutes || {},
    capturedAt: latest.capturedAt || sleepSummary.lastCapturedAt || null
  };
}

function sumRecentSteps(metrics, hours = 24) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const values = metrics
    .filter((metric) => metric.type === "steps")
    .filter((metric) => new Date(metric.measuredAt).getTime() >= cutoff)
    .map((metric) => Number(metric.value || 0))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function metricAverage(metrics, type, days = 14) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const values = metrics
    .filter((metric) => metric.type === type)
    .filter((metric) => new Date(metric.measuredAt).getTime() >= cutoff)
    .map((metric) => Number(metric.value))
    .filter(Number.isFinite);
  return values.length ? average(values) : null;
}

function median(values) {
  const sorted = values
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  const normalized = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (!normalized.length) return 0;
  const mean = average(normalized);
  const variance = normalized.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / normalized.length;
  return Math.sqrt(variance);
}

function percentile(values, ratio) {
  const sorted = values
    .filter((value) => Number.isFinite(Number(value)))
    .map(Number)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function medianAbsoluteDeviation(values, center = median(values)) {
  if (!Number.isFinite(Number(center))) return 0;
  return median(values.map((value) => Math.abs(Number(value) - Number(center)))) || 0;
}

function hrvSleepWindows(metrics, date) {
  return metrics
    .filter((metric) => metric.type === "sleep" && metric.startTime && metric.endTime)
    .filter((metric) => metric.date === date || metric.endTime.slice(0, 10) === date || metric.startTime.slice(0, 10) === date)
    .map((metric) => ({
      start: new Date(metric.startTime).getTime(),
      end: new Date(metric.endTime).getTime()
    }))
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start);
}

function pointInWindows(point, windows) {
  return windows.some((window) => point.time >= window.start && point.time <= window.end);
}

function hrvCandidateWindow(points, maxPairGapMs = 2.5 * 60 * 1000) {
  if (points.length < 18) return null;

  const pairDetails = [];
  for (let index = 1; index < points.length; index += 1) {
    const gapMs = points[index].time - points[index - 1].time;
    if (gapMs <= 0 || gapMs > maxPairGapMs) continue;
    const rrDiff = points[index].rrMs - points[index - 1].rrMs;
    pairDetails.push({
      squared: rrDiff * rrDiff,
      rrDiffAbs: Math.abs(rrDiff),
      gapMinutes: gapMs / 60_000,
      bpmStep: Math.abs(points[index].value - points[index - 1].value)
    });
  }
  if (pairDetails.length < 14) return null;

  const bpmValues = points.map((point) => point.value);
  const bpmMedian = median(bpmValues);
  const bpmStdDev = standardDeviation(bpmValues);
  const bpmSteps = pairDetails.map((pair) => pair.bpmStep);
  const rrDiffs = pairDetails.map((pair) => pair.rrDiffAbs);
  const bpmStepMedian = median(bpmSteps) || 0;
  const bpmStepP90 = percentile(bpmSteps, 0.9) || 0;
  const rrDiffMedian = median(rrDiffs) || 0;
  const rrDiffP90 = percentile(rrDiffs, 0.9) || 0;
  const durationMinutes = (points[points.length - 1].time - points[0].time) / 60_000;
  const medianGap = median(pairDetails.map((pair) => pair.gapMinutes)) || 0;
  const coverageRatio = pairDetails.length / Math.max(1, points.length - 1);
  if (durationMinutes < 18 || medianGap <= 0 || medianGap > 2.25 || coverageRatio < 0.8) return null;
  if (bpmMedian > 92 || bpmStdDev > 7 || bpmStepMedian > 3.5 || bpmStepP90 > 8 || rrDiffP90 > 160) return null;

  const maxBpmStep = Math.max(6, bpmStepMedian + (medianAbsoluteDeviation(bpmSteps, bpmStepMedian) * 4));
  const maxRrDiff = Math.max(80, rrDiffMedian + (medianAbsoluteDeviation(rrDiffs, rrDiffMedian) * 4));
  const acceptedPairs = pairDetails.filter((pair) => pair.bpmStep <= maxBpmStep && pair.rrDiffAbs <= maxRrDiff);
  if (acceptedPairs.length < 14 || acceptedPairs.length / pairDetails.length < 0.82) return null;

  const rmssd = Math.sqrt(acceptedPairs.reduce((sum, pair) => sum + pair.squared, 0) / acceptedPairs.length);
  if (!Number.isFinite(rmssd) || rmssd < 1 || rmssd > 300) return null;

  return {
    value: rmssd,
    pairCount: acceptedPairs.length,
    rejectedPairCount: pairDetails.length - acceptedPairs.length,
    medianGap,
    bpmMedian,
    bpmStdDev,
    bpmStepMedian,
    bpmStepP90,
    rrDiffP90,
    coverageRatio,
    durationMinutes,
    startTime: points[0].measuredAt,
    endTime: points[points.length - 1].measuredAt,
    startMs: points[0].time,
    endMs: points[points.length - 1].time,
    score: bpmMedian + (bpmStdDev * 7) + (bpmStepMedian * 5) + (medianGap * 3) + ((1 - coverageRatio) * 25) + ((pairDetails.length - acceptedPairs.length) * 2)
  };
}

function hrvWindowCandidates(points) {
  const candidates = [];
  const windowMinutes = 30;
  for (let start = 0; start < points.length; start += 1) {
    const startTime = points[start].time;
    const windowPoints = [];
    for (let index = start; index < points.length; index += 1) {
      const point = points[index];
      if (point.time - startTime > windowMinutes * 60_000) break;
      if (windowPoints.length) {
        const gapMs = point.time - windowPoints[windowPoints.length - 1].time;
        if (gapMs > 3 * 60 * 1000) break;
      }
      windowPoints.push(point);
    }
    const candidate = hrvCandidateWindow(windowPoints);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function hrvOverlapRatio(candidate, selected) {
  const overlap = Math.max(0, Math.min(candidate.endMs, selected.endMs) - Math.max(candidate.startMs, selected.startMs));
  if (!overlap) return 0;
  const candidateDuration = Math.max(1, candidate.endMs - candidate.startMs);
  return overlap / candidateDuration;
}

function selectHrvCandidates(candidates, limit = 8) {
  const selected = [];
  for (const candidate of [...candidates].sort((a, b) => a.score - b.score)) {
    if (selected.every((existing) => hrvOverlapRatio(candidate, existing) <= 0.2 && hrvOverlapRatio(existing, candidate) <= 0.2)) {
      selected.push(candidate);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function metricTrend(metrics, type, limit = 900) {
  return metrics
    .filter((metric) => metric.type === type)
    .filter((metric) => metric.measuredAt && Number.isFinite(Number(metric.value)))
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime())
    .slice(-limit)
    .map((metric) => ({
      metricId: metric.metricId,
      type: metric.type,
      source: metric.source,
      sourcePackage: metric.sourcePackage,
      measuredAt: metric.measuredAt,
      date: metric.date,
      value: Number(metric.value),
      unit: metric.unit,
      capturedAt: metric.capturedAt,
      derived: metric.derived,
      estimated: metric.estimated,
      basis: metric.basis,
      quality: metric.quality,
      sampleCount: metric.sampleCount,
      pairCount: metric.pairCount,
      rejectedPairCount: metric.rejectedPairCount,
      medianGapMinutes: metric.medianGapMinutes,
      coverageRatio: metric.coverageRatio,
      confidence: metric.confidence,
      restWindowCount: metric.restWindowCount,
      windowMinutes: metric.windowMinutes
    }));
}

function calculatedHrvTrend(metrics, limit = 90) {
  const byDate = new Map();
  for (const metric of metrics.filter((item) => item.type === "heart_rate")) {
    const value = Number(metric.value);
    if (!metric?.date || !metric?.measuredAt || !Number.isFinite(value) || value <= 0) continue;
    const time = new Date(metric.measuredAt).getTime();
    if (!Number.isFinite(time)) continue;
    const records = byDate.get(metric.date) || [];
    records.push({ ...metric, value, time, rrMs: 60000 / value });
    byDate.set(metric.date, records);
  }

  const estimates = [];
  for (const [date, records] of byDate.entries()) {
    const byTime = new Map();
    for (const record of records) {
      const existing = byTime.get(record.measuredAt);
      if (!existing || new Date(record.capturedAt || 0).getTime() > new Date(existing.capturedAt || 0).getTime()) {
        byTime.set(record.measuredAt, record);
      }
    }
    const points = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    if (points.length < 10) continue;

    const sleepWindows = hrvSleepWindows(metrics, date);
    const sleepPoints = sleepWindows.length ? points.filter((point) => pointInWindows(point, sleepWindows)) : [];
    let basis = sleepPoints.length >= 10 ? "sleep_heart_rate_samples" : "resting_heart_rate_samples";
    let candidates = hrvWindowCandidates(sleepPoints.length >= 10 ? sleepPoints : points);
    if (basis === "sleep_heart_rate_samples" && !candidates.length) {
      basis = "resting_heart_rate_samples";
      candidates = hrvWindowCandidates(points);
    }
    if (!candidates.length) continue;

    const selected = selectHrvCandidates(candidates, 8);
    if (selected.length < 2) continue;
    const rawValue = median(selected.map((candidate) => candidate.value));
    const value = Math.max(1, Math.min(300, Math.round(rawValue)));
    const pairCount = selected.reduce((sum, candidate) => sum + candidate.pairCount, 0);
    if (pairCount < 40) continue;

    const medianGap = median(selected.map((candidate) => candidate.medianGap)) || 0;
    const rejectedPairCount = selected.reduce((sum, candidate) => sum + candidate.rejectedPairCount, 0);
    const coverageRatio = median(selected.map((candidate) => candidate.coverageRatio)) || 0;
    const latestWindowEnd = selected
      .map((candidate) => candidate.endTime)
      .filter(Boolean)
      .sort()
      .at(-1);
    const last = points.find((point) => point.measuredAt === latestWindowEnd) || points[points.length - 1];
    const confidence = basis === "sleep_heart_rate_samples" && medianGap <= 1.25 && pairCount >= 120 && selected.length >= 4 && coverageRatio >= 0.9
      ? "highest_available_without_beat_intervals"
      : medianGap <= 2 && pairCount >= 60 && coverageRatio >= 0.85
        ? "strong_proxy"
        : "limited_proxy";
    const qualityPrefix = basis === "sleep_heart_rate_samples" ? "sleep" : "resting";
    const quality = medianGap <= 1.25 && selected.length >= 3 && coverageRatio >= 0.9
      ? `${qualityPrefix}_dense_hr_estimate`
      : `${qualityPrefix}_sampled_hr_estimate`;
    const metric = {
      metricId: "",
      clientRecordId: `calculated-hrv-${date}`,
      type: "hrv",
      source: "blood-calculated",
      sourcePackage: last.sourcePackage || "",
      measuredAt: last.measuredAt,
      date,
      value,
      unit: "ms_est",
      capturedAt: points
        .map((point) => point.capturedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || last.capturedAt || null,
      derived: true,
      estimated: true,
      basis,
      quality,
      confidence,
      sampleCount: points.length,
      pairCount,
      rejectedPairCount,
      medianGapMinutes: Number(medianGap.toFixed(1)),
      coverageRatio: Number(coverageRatio.toFixed(2)),
      restWindowCount: selected.length,
      windowMinutes: Math.round(median(selected.map((candidate) => candidate.durationMinutes)) || 0)
    };
    metric.metricId = stableMetricId(metric);
    estimates.push(metric);
  }

  return estimates
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime())
    .slice(-limit);
}

function hrvTrend(metrics, limit = 900) {
  const trueHrv = metricTrend(metrics, "hrv", limit)
    .map((metric) => ({
      ...metric,
      derived: Boolean(metric.derived),
      estimated: Boolean(metric.estimated),
      basis: metric.basis || "health_connect_rmssd"
    }));
  const trueDates = new Set(trueHrv.map((metric) => metric.date).filter(Boolean));
  const calculated = calculatedHrvTrend(metrics, limit)
    .filter((metric) => !trueDates.has(metric.date));
  return [...trueHrv, ...calculated]
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime())
    .slice(-limit);
}

function sleepTrend(metrics, fallback = null, limit = 90) {
  const byDate = new Map();
  for (const metric of metrics.filter((item) => item.type === "sleep")) {
    if (!metric?.date || !metric?.measuredAt) continue;
    const existing = byDate.get(metric.date);
    if (existing && new Date(existing.measuredAt).getTime() >= new Date(metric.measuredAt).getTime()) continue;
    byDate.set(metric.date, metric);
  }
  if (fallback?.date && fallback?.measuredAt && !byDate.has(fallback.date)) {
    byDate.set(fallback.date, fallback);
  }
  return Array.from(byDate.values())
    .filter((metric) => Number.isFinite(Number(metric.value ?? metric.asleepMinutes)))
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime())
    .slice(-limit)
    .map((metric) => ({
      metricId: metric.metricId,
      type: "sleep",
      source: metric.source,
      sourcePackage: metric.sourcePackage,
      measuredAt: metric.measuredAt,
      date: metric.date,
      value: Number(metric.value ?? metric.asleepMinutes),
      unit: "minutes_asleep",
      capturedAt: metric.capturedAt
    }));
}

function stepsTrend(metrics, limit = 90) {
  const byDate = new Map();
  for (const metric of metrics.filter((item) => item.type === "steps")) {
    if (!metric?.date || !metric?.measuredAt) continue;
    const value = Number(metric.value);
    if (!Number.isFinite(value)) continue;
    const existing = byDate.get(metric.date) || {
      type: "steps",
      source: metric.source,
      sourcePackage: metric.sourcePackage,
      date: metric.date,
      measuredAt: metric.measuredAt,
      capturedAt: metric.capturedAt,
      value: 0
    };
    existing.value += value;
    if (new Date(metric.measuredAt).getTime() > new Date(existing.measuredAt).getTime()) {
      existing.measuredAt = metric.measuredAt;
      existing.capturedAt = metric.capturedAt;
      existing.sourcePackage = metric.sourcePackage;
    }
    byDate.set(metric.date, existing);
  }
  return Array.from(byDate.values())
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime())
    .slice(-limit)
    .map((metric) => ({
      ...metric,
      value: Math.round(metric.value),
      unit: "steps"
    }));
}

function easternHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false
  }).formatToParts(date);
  return Number.parseInt(parts.find((part) => part.type === "hour")?.value || "0", 10);
}

function currentTimeBlock(hour = easternHour()) {
  if (hour < 5) return "night";
  if (hour < 10) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

const TIME_BLOCKS = [
  { key: "night", label: "night", range: "10 PM-5 AM" },
  { key: "morning", label: "morning", range: "5-10 AM" },
  { key: "midday", label: "midday", range: "10 AM-2 PM" },
  { key: "afternoon", label: "afternoon", range: "2-6 PM" },
  { key: "evening", label: "evening", range: "6-10 PM" }
];

const PATTERN_SOURCE_LABELS = {
  glucose: "glucose",
  heart_rate: "HR",
  hrv: "HRV",
  sleep: "sleep",
  steps: "steps"
};

function timeBlockFromTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return currentTimeBlock(easternHour(date));
}

function recencyWeight(measuredAt, now = new Date()) {
  const ageDays = (now.getTime() - new Date(measuredAt).getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.max(0.55, 1 - (Math.min(ageDays, 45) / 45) * 0.45);
}

function patternScore(source, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return { score: 0, reason: "" };

  if (source === "glucose") {
    if (number < 70) return { score: 1.0, reason: "glucose too low" };
    if (number > 180) return { score: 0.9, reason: "glucose too high" };
    if (number < 82) return { score: 0.35, reason: "glucose near low edge" };
    if (number > 140) return { score: 0.35, reason: "glucose near high edge" };
    return { score: 0, reason: "" };
  }

  if (source === "heart_rate") {
    if (number >= 100) return { score: 0.85, reason: "HR too high" };
    if (number >= 85) return { score: 0.4, reason: "HR raised" };
    return { score: 0, reason: "" };
  }

  if (source === "hrv") {
    if (number < 25) return { score: 0.8, reason: "HRV too low" };
    if (number < 40) return { score: 0.45, reason: "HRV low" };
    return { score: 0, reason: "" };
  }

  if (source === "sleep") {
    if (number < 300) return { score: 0.9, reason: "sleep too short" };
    if (number < 360) return { score: 0.45, reason: "sleep light" };
    return { score: 0, reason: "" };
  }

  if (source === "steps") {
    if (number < 1500) return { score: 0.35, reason: "steps too low" };
    if (number < 4000) return { score: 0.15, reason: "steps light" };
    return { score: 0, reason: "" };
  }

  return { score: 0, reason: "" };
}

function hourlyMetricBuckets(metrics = [], type) {
  const buckets = new Map();
  for (const metric of metrics) {
    if (metric?.type !== type || !metric.measuredAt) continue;
    const value = Number(metric.value);
    if (!Number.isFinite(value)) continue;
    const date = new Date(metric.measuredAt);
    if (Number.isNaN(date.getTime())) continue;
    const hourKey = metric.measuredAt.slice(0, 13);
    const bucket = buckets.get(hourKey) || { measuredAt: metric.measuredAt, values: [] };
    bucket.values.push(value);
    if (new Date(metric.measuredAt).getTime() > new Date(bucket.measuredAt).getTime()) {
      bucket.measuredAt = metric.measuredAt;
    }
    buckets.set(hourKey, bucket);
  }
  return Array.from(buckets.values())
    .map((bucket) => ({
      measuredAt: bucket.measuredAt,
      value: median(bucket.values)
    }))
    .filter((bucket) => Number.isFinite(Number(bucket.value)));
}

function buildPatternStats() {
  return new Map(TIME_BLOCKS.map((block) => [block.key, {
    block: block.key,
    label: block.label,
    range: block.range,
    observations: 0,
    weightTotal: 0,
    weightedScore: 0,
    unstableWeight: 0,
    unstableCount: 0,
    sourceCounts: {},
    reasons: []
  }]));
}

function addPatternObservation(stats, measuredAt, source, value, now) {
  const block = timeBlockFromTimestamp(measuredAt);
  if (!block || !stats.has(block)) return;
  const result = patternScore(source, value);
  const weight = recencyWeight(measuredAt, now);
  const item = stats.get(block);
  item.observations += 1;
  item.weightTotal += weight;
  item.weightedScore += result.score * weight;
  if (result.score > 0) {
    item.unstableWeight += weight;
    item.unstableCount += 1;
    item.sourceCounts[source] = (item.sourceCounts[source] || 0) + 1;
    item.reasons.push({
      source,
      reason: result.reason,
      measuredAt,
      value: Number(value),
      score: Number(result.score.toFixed(2))
    });
  }
}

function compactJoin(items = []) {
  return items.filter(Boolean).slice(0, 3).join(" + ");
}

function summarizePatternReasons(reasons = []) {
  const buckets = new Map();
  for (const item of reasons) {
    if (!item?.reason) continue;
    const current = buckets.get(item.reason) || { reason: item.reason, count: 0, scoreTotal: 0, latestTime: 0 };
    current.count += 1;
    current.scoreTotal += Number(item.score) || 0;
    current.latestTime = Math.max(current.latestTime, new Date(item.measuredAt).getTime() || 0);
    buckets.set(item.reason, current);
  }
  const topReasons = Array.from(buckets.values())
    .sort((a, b) => b.count - a.count || b.scoreTotal - a.scoreTotal || b.latestTime - a.latestTime)
    .slice(0, 3)
    .map((item) => item.reason);
  return compactJoin(topReasons);
}

function summarizePatternBlock(block) {
  const averageScore = block.weightTotal ? block.weightedScore / block.weightTotal : 0;
  const unstableShare = block.weightTotal ? block.unstableWeight / block.weightTotal : 0;
  const sourceEntries = Object.entries(block.sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({ source, label: PATTERN_SOURCE_LABELS[source] || source, count }));
  const topSources = sourceEntries.slice(0, 3).map((source) => source.label);
  const level = averageScore >= 0.45 || unstableShare >= 0.42
    ? "high"
    : averageScore >= 0.25 || unstableShare >= 0.25
      ? "watch"
      : averageScore >= 0.12 || unstableShare >= 0.12
        ? "soft"
        : "stable";
  return {
    block: block.block,
    label: block.label,
    range: block.range,
    level,
    observations: block.observations,
    unstableCount: block.unstableCount,
    averageScore: Number(averageScore.toFixed(2)),
    unstableShare: Number(unstableShare.toFixed(2)),
    sources: sourceEntries,
    topSources,
    conditionText: summarizePatternReasons(block.reasons),
    reasons: block.reasons
      .sort((a, b) => b.score - a.score || new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
      .slice(0, 4)
  };
}

function estimateInstabilityPatterns({ readings = [], health = {}, now = new Date() } = {}) {
  const stats = buildPatternStats();
  const cutoff = now.getTime() - 45 * 24 * 60 * 60 * 1000;
  const recentEnough = (value) => {
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time >= cutoff && time <= now.getTime() + 60_000;
  };

  for (const reading of readings) {
    if (!recentEnough(reading.measuredAt)) continue;
    addPatternObservation(stats, reading.measuredAt, "glucose", reading.valueMgDl, now);
  }

  const trends = health?.trends || {};
  for (const metric of hourlyMetricBuckets(trends.heartRate || [], "heart_rate")) {
    if (!recentEnough(metric.measuredAt)) continue;
    addPatternObservation(stats, metric.measuredAt, "heart_rate", metric.value, now);
  }
  for (const metric of trends.hrv || []) {
    if (!recentEnough(metric.measuredAt)) continue;
    addPatternObservation(stats, metric.measuredAt, "hrv", metric.value, now);
  }
  for (const metric of trends.sleep || []) {
    if (!recentEnough(metric.measuredAt)) continue;
    addPatternObservation(stats, metric.measuredAt, "sleep", metric.value, now);
  }
  for (const metric of trends.steps || []) {
    if (!recentEnough(metric.measuredAt)) continue;
    addPatternObservation(stats, metric.measuredAt, "steps", metric.value, now);
  }

  const blocks = Array.from(stats.values()).map(summarizePatternBlock);
  const totalObservations = blocks.reduce((sum, block) => sum + block.observations, 0);
  const ranked = [...blocks]
    .filter((block) => block.observations >= 2)
    .sort((a, b) => b.averageScore - a.averageScore || b.unstableShare - a.unstableShare || b.observations - a.observations);
  const prediction = ranked.find((block) => block.unstableCount > 0) || null;
  const currentBlockKey = currentTimeBlock(easternHour(now));
  const current = blocks.find((block) => block.block === currentBlockKey) || null;
  const active = Boolean(prediction && totalObservations >= 6);
  const conditionText = prediction?.conditionText || compactJoin(prediction?.topSources || []) || "source state moved";
  const observationWord = prediction?.observations === 1 ? "sample" : "samples";
  const predictionDetail = prediction
    ? `${prediction.range}: ${conditionText}. ${prediction.unstableCount} of ${prediction.observations} source ${observationWord} read high, low, short, light, or raised.`
    : null;
  const predictionBasis = prediction
    ? "45-day rolling window; recalculates after each upload."
    : `${totalObservations} source samples so far; recalculates after each upload.`;

  return {
    status: active ? "active" : "learning",
    generatedAt: now.toISOString(),
    windowDays: 45,
    currentBlock: currentBlockKey,
    current,
    prediction: prediction ? {
      ...prediction,
      title: `Unstable window: ${prediction.label}`,
      detail: predictionDetail,
      basis: predictionBasis
    } : null,
    title: active ? `Unstable window: ${prediction.label}` : "Pattern: learning",
    detail: active
      ? predictionDetail
      : "Need more time-stamped glucose and health samples.",
    basis: predictionBasis,
    blocks
  };
}

function pushFactor(factors, key, label, points, reason, action) {
  if (!Number.isFinite(points) || points === 0) return;
  factors.push({ key, label, points: Number(points.toFixed(2)), reason, action });
}

function estimateAnxietyState({ glucose, heartRate, hrv, sleep, recentSteps, hour } = {}) {
  const factors = [];
  let raw = 2.2;

  if (glucose?.valueMgDl) {
    const value = glucose.valueMgDl;
    if (value < 70) {
      raw += 1.0;
      pushFactor(factors, "glucose", "glucose too low", 1.0, `${value} mg/dL glucose is too low.`, "Carb plus protein snack more; water more.");
    } else if (value > 180) {
      raw += 0.9;
      pushFactor(factors, "glucose", "glucose too high", 0.9, `${value} mg/dL glucose is too high.`, "Protein/fiber with carbs more; water more; easy walk more.");
    } else if (value < 82) {
      raw += 0.35;
      pushFactor(factors, "glucose", "glucose near low edge", 0.35, `${value} mg/dL glucose is near the low edge.`, "Carb plus protein snack more; water more.");
    } else if (value > 140) {
      raw += 0.35;
      pushFactor(factors, "glucose", "glucose near high edge", 0.35, `${value} mg/dL glucose is near the high edge.`, "Protein/fiber with carbs more; water more; easy walk more.");
    } else {
      raw -= 0.15;
      pushFactor(factors, "glucose", "glucose steady", -0.15, `${value} mg/dL glucose is inside the target band.`, "Normal meal rhythm more; water more.");
    }
  }

  if (heartRate?.value) {
    const value = heartRate.value;
    if (value >= 100) {
      raw += 0.85;
      pushFactor(factors, "heart_rate", "HR too high", 0.85, `${value} bpm HR is too high.`, "Water more; protein/fiber snack more; easy walk more.");
    } else if (value >= 85) {
      raw += 0.4;
      pushFactor(factors, "heart_rate", "HR raised", 0.4, `${value} bpm HR is raised.`, "Water more; protein/fiber snack more; easy walk more.");
    } else if (value >= 55 && value <= 75) {
      raw -= 0.15;
      pushFactor(factors, "heart_rate", "HR calm", -0.15, `${value} bpm HR is calm.`, "Normal meals more; water more; exercise more.");
    }
  }

  if (hrv?.value) {
    const value = hrv.value;
    const labelPrefix = hrv.estimated || hrv.derived ? "estimated HRV" : "HRV";
    if (value < 25) {
      raw += 0.8;
      pushFactor(factors, "hrv", `${labelPrefix} too low`, 0.8, `${value} ms ${labelPrefix} is too low.`, "Water more; protein/fiber meal rhythm more; gentle walk more.");
    } else if (value < 40) {
      raw += 0.45;
      pushFactor(factors, "hrv", `${labelPrefix} low`, 0.45, `${value} ms ${labelPrefix} is low.`, "Water more; protein/fiber meal rhythm more; gentle walk more.");
    } else if (value >= 65) {
      raw -= 0.25;
      pushFactor(factors, "hrv", `${labelPrefix} strong`, -0.25, `${value} ms ${labelPrefix} is strong.`, "Normal exercise more; water more.");
    }
  }

  if (sleep?.asleepMinutes || sleep?.value) {
    const minutes = Number(sleep.asleepMinutes ?? sleep.value);
    const hours = minutes / 60;
    if (minutes < 300) {
      raw += 0.9;
      pushFactor(factors, "sleep", "sleep too short", 0.9, `${hours.toFixed(1)}h asleep is too short.`, "Protein/fiber with first meal more; water more; easy movement more.");
    } else if (minutes < 360) {
      raw += 0.45;
      pushFactor(factors, "sleep", "sleep light", 0.45, `${hours.toFixed(1)}h asleep is light.`, "Protein/fiber with first meal more; water more; easy movement more.");
    } else if (minutes >= 420) {
      raw -= 0.25;
      pushFactor(factors, "sleep", "sleep solid", -0.25, `${hours.toFixed(1)}h asleep is solid.`, "Normal exercise more; water more.");
    }
  }

  if (Number.isFinite(recentSteps)) {
    if (recentSteps < 1500) {
      raw += 0.35;
      pushFactor(factors, "steps", "steps too low", 0.35, `${recentSteps} steps in the recent window is too low.`, "Water more; normal meals more; short walks more.");
    } else if (recentSteps < 4000) {
      raw += 0.15;
      pushFactor(factors, "steps", "steps light", 0.15, `${recentSteps} recent steps is light.`, "Water more; normal meals more; short walks more.");
    } else if (recentSteps >= 8000) {
      raw -= 0.25;
      pushFactor(factors, "steps", "steps good", -0.25, `${recentSteps} recent steps is solid.`, "Water after movement more; steady movement more.");
    }
  }

  const score = Number(Math.max(1, Math.min(10, raw * 2)).toFixed(1));
  const primary = [...factors].sort((a, b) => b.points - a.points)[0] || null;
  const suggestion = primary
    ? {
      label: "Latest upload",
      action: primary.action,
      reason: primary.reason,
      source: primary.key
    }
    : {
      label: "Latest upload",
      action: "Water plus normal food more; easy walk more.",
      reason: "No high, low, short, light, or raised source is available.",
      source: "none"
    };

  return {
    score,
    scale: "1-10",
    label: score <= 2.5 ? "low" : score <= 4.5 ? "steady" : score <= 6.5 ? "watch" : score <= 8 ? "high" : "very high",
    raw: Number(raw.toFixed(2)),
    factors,
    suggestion,
    note: "Personal stabilization estimate from latest uploaded health signals; not a diagnosis."
  };
}

function latestAtOrBefore(items = [], atTime, maxAgeMs, mapper = (item) => item) {
  let selected = null;
  let selectedTime = -Infinity;
  for (const item of items) {
    const time = new Date(item?.measuredAt).getTime();
    if (!Number.isFinite(time) || time > atTime || atTime - time > maxAgeMs) continue;
    if (time >= selectedTime) {
      selected = mapper(item);
      selectedTime = time;
    }
  }
  return selected;
}

function estimateAnxietyTrend({ readings = [], health = {}, limit = 240 } = {}) {
  const trends = health?.trends || {};
  const glucosePoints = readings
    .filter((reading) => reading?.measuredAt && Number.isFinite(Number(reading.valueMgDl)))
    .map((reading) => ({ ...reading, valueMgDl: Number(reading.valueMgDl) }))
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());
  const heartRatePoints = [...(trends.heartRate || [])]
    .filter((metric) => metric?.measuredAt && Number.isFinite(Number(metric.value)))
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());
  const hrvPoints = [...(trends.hrv || [])]
    .filter((metric) => metric?.measuredAt && Number.isFinite(Number(metric.value)))
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());
  const sleepPoints = [...(trends.sleep || [])]
    .filter((metric) => metric?.measuredAt && Number.isFinite(Number(metric.value ?? metric.asleepMinutes)))
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());
  const stepPoints = [...(trends.steps || [])]
    .filter((metric) => metric?.measuredAt && Number.isFinite(Number(metric.value)))
    .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());

  const candidateTimes = new Set();
  for (const source of [glucosePoints, heartRatePoints, hrvPoints, sleepPoints, stepPoints]) {
    for (const item of source) {
      const time = new Date(item.measuredAt).getTime();
      if (Number.isFinite(time)) candidateTimes.add(time);
    }
  }

  const points = Array.from(candidateTimes)
    .sort((a, b) => a - b)
    .map((time) => {
      const at = new Date(time);
      const glucose = latestAtOrBefore(glucosePoints, time, 36 * 60 * 60 * 1000, (reading) => ({
        measuredAt: reading.measuredAt,
        valueMgDl: reading.valueMgDl
      }));
      const heartRate = latestAtOrBefore(heartRatePoints, time, 4 * 60 * 60 * 1000, (metric) => ({
        measuredAt: metric.measuredAt,
        value: metric.value
      }));
      const hrv = latestAtOrBefore(hrvPoints, time, 36 * 60 * 60 * 1000, (metric) => ({
        measuredAt: metric.measuredAt,
        value: metric.value,
        estimated: metric.estimated,
        derived: metric.derived,
        basis: metric.basis
      }));
      const sleep = latestAtOrBefore(sleepPoints, time, 36 * 60 * 60 * 1000, (metric) => ({
        measuredAt: metric.measuredAt,
        asleepMinutes: Number(metric.asleepMinutes ?? metric.value),
        value: Number(metric.asleepMinutes ?? metric.value)
      }));
      const steps = latestAtOrBefore(stepPoints, time, 36 * 60 * 60 * 1000, (metric) => Number(metric.value));
      const sourceCount = [glucose, heartRate, hrv, sleep, Number.isFinite(steps) ? steps : null].filter((item) => item != null).length;
      if (sourceCount < 2) return null;
      const anxiety = estimateAnxietyState({
        glucose,
        heartRate,
        hrv,
        sleep,
        recentSteps: steps,
        hour: easternHour(at)
      });
      return {
        measuredAt: at.toISOString(),
        value: anxiety.score,
        unit: "score_1_10",
        label: anxiety.label,
        sourceCount,
        source: anxiety.suggestion?.source || "none",
        reason: anxiety.suggestion?.reason || "",
        action: anxiety.suggestion?.action || ""
      };
    })
    .filter(Boolean);

  const latestScore = Number(health?.anxiety?.score);
  if (Number.isFinite(latestScore)) {
    const latest = health?.latest || {};
    const latestTimes = [
      latest.glucose?.measuredAt,
      latest.heartRate?.measuredAt,
      latest.hrv?.measuredAt,
      latest.sleep?.measuredAt,
      latest.steps?.measuredAt,
      glucosePoints.at(-1)?.measuredAt
    ]
      .map((value) => new Date(value).getTime())
      .filter((time) => Number.isFinite(time));
    const measuredAt = new Date(latestTimes.length ? Math.max(...latestTimes) : Date.now()).toISOString();
    const existingTime = new Date(points.at(-1)?.measuredAt).getTime();
    const latestTime = new Date(measuredAt).getTime();
    if (!Number.isFinite(existingTime) || Math.abs(latestTime - existingTime) > 60_000) {
      const sourceCount = [
        latest.glucose,
        latest.heartRate,
        latest.hrv,
        latest.sleep,
        Number.isFinite(Number(latest.steps?.value)) ? latest.steps : null
      ].filter(Boolean).length;
      points.push({
        measuredAt,
        value: latestScore,
        unit: "score_1_10",
        label: health.anxiety.label || "",
        sourceCount,
        source: health.anxiety.suggestion?.source || "none",
        reason: health.anxiety.suggestion?.reason || "",
        action: health.anxiety.suggestion?.action || ""
      });
    }
  }

  return points.slice(-limit);
}

function summarizeHealthMetrics(metrics = [], sleepFallback = null, latestGlucose = null) {
  const normalized = metrics
    .filter((metric) => metric?.type && metric?.measuredAt)
    .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime());
  const sleep = latestMetric(normalized, "sleep") || latestSleepFromFallback(sleepFallback);
  const heartRate = latestMetric(normalized, "heart_rate");
  const hrvSeries = hrvTrend(normalized);
  const hrv = hrvSeries.at(-1) || null;
  const recentSteps = sumRecentSteps(normalized, 24);
  const latestStepsMetric = latestMetric(normalized, "steps");
  const lastCapturedAt = normalized
    .map((metric) => metric.capturedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || sleep?.capturedAt || null;

  const latest = {
    glucose: latestGlucose,
    heartRate,
    hrv,
    sleep,
    steps: {
      type: "steps",
      value: recentSteps,
      unit: "steps_24h",
      measuredAt: latestStepsMetric?.measuredAt || null,
      capturedAt: latestStepsMetric?.capturedAt || null
    }
  };

  return {
    status: normalized.length || sleep ? "connected" : "waiting_for_health_metrics",
    metricCount: normalized.length,
    lastCapturedAt,
    latest,
    trends: {
      heartRate: metricTrend(normalized, "heart_rate"),
      hrv: hrvSeries,
      sleep: sleepTrend(normalized, sleep),
      steps: stepsTrend(normalized)
    },
    baselines: {
      heartRateAvg14d: metricAverage(normalized, "heart_rate", 14),
      hrvAvg14d: metricAverage(hrvSeries, "hrv", 14),
      sleepAvg14dMinutes: metricAverage(normalized, "sleep", 14),
      stepsAvg14d: metricAverage(normalized, "steps", 14)
    },
    anxiety: estimateAnxietyState({
      glucose: latestGlucose,
      heartRate,
      hrv,
      sleep,
      recentSteps
    })
  };
}

async function fetchSleepSummaryFallback() {
  if (!SLEEP_SUMMARY_URL) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(SLEEP_SUMMARY_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function summarizeReadings(readings, health = summarizeHealthMetrics()) {
  const normalized = readings
    .filter((reading) => reading?.measuredAt && Number.isFinite(Number(reading.valueMgDl)))
    .map((reading) => ({
      ...reading,
      readingDate: reading.readingDate || readingDateFromTime(reading.measuredAt, reading.zoneOffset)
    }))
    .filter((reading) => reading.readingDate >= PUBLIC_MIN_READING_DATE)
    .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime());
  const anxietyTrend = estimateAnxietyTrend({ readings: normalized, health });
  const healthWithAnxietyTrend = {
    ...health,
    trends: {
      ...(health?.trends || {}),
      anxiety: anxietyTrend
    }
  };
  const patterns = estimateInstabilityPatterns({ readings: normalized, health: healthWithAnxietyTrend });

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
      health: healthWithAnxietyTrend,
      patterns,
      publicMinReadingDate: PUBLIC_MIN_READING_DATE,
      message: "No readings have reached Blood. Waiting for automatic CONTOUR NEXT ONE Bluetooth glucose upload; Health Connect supplies HR, sleep, and steps, and Blood estimates HRV from sleep/rest heart-rate samples."
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
    health: healthWithAnxietyTrend,
    patterns,
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
    const readings = await readReadings();
    const glucoseOnly = summarizeReadings(readings);
    const health = summarizeHealthMetrics(await readHealthMetrics(), await fetchSleepSummaryFallback(), glucoseOnly.latest);
    res.json(summarizeReadings(readings, health));
  } catch (error) {
    next(error);
  }
});

app.get("/api/blood/export", requireConfiguredToken("BLOOD_READ_TOKEN", "export"), async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      readings: await readReadings(),
      healthMetrics: await readHealthMetrics()
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

app.post("/api/ingest/health-metrics", requireConfiguredToken("BLOOD_INGEST_TOKEN", "ingest"), async (req, res, next) => {
  try {
    const metrics = sanitizeHealthPayload(req.body);
    await storeHealthMetrics(metrics);
    const byType = metrics.reduce((counts, metric) => {
      counts[metric.type] = (counts[metric.type] || 0) + 1;
      return counts;
    }, {});
    const latest = [...metrics].sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())[0];
    console.info(JSON.stringify({
      event: "blood_health_metrics_accepted",
      accepted: metrics.length,
      byType,
      latestMeasuredAt: latest?.measuredAt || null,
      capturedAt: latest?.capturedAt || null,
      source: latest?.source || null
    }));
    res.json({
      ok: true,
      accepted: metrics.length,
      byType,
      metricIds: metrics.map((metric) => metric.metricId)
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

app.get("/paper", (_req, res) => {
  res.sendFile(path.join(__dirname, "paper.html"));
});

app.get("/paper.pdf", (_req, res) => {
  res.sendFile(path.join(__dirname, "paper.pdf"));
});

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
  sanitizeHealthPayload,
  summarizeHealthMetrics,
  estimateAnxietyState,
  estimateAnxietyTrend,
  estimateInstabilityPatterns,
  currentTimeBlock,
  summarizeReadings
};
