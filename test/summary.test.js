const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeGlucoseMgDl,
  parseContourCsv,
  sanitizeHealthPayload,
  sanitizePayload,
  summarizeHealthMetrics,
  summarizeReadings
} = require("../server");

test("normalizes mmol/L readings to mg/dL", () => {
  assert.equal(normalizeGlucoseMgDl({ value: "5.5", unit: "mmol/L" }), 99);
});

test("parses a Contour-like CSV export", () => {
  const csv = [
    "Date,Time,Reading (mg/dL),Meal Marker,Notes",
    "6/26/2026,8:15 AM,104,Before Meal,first",
    "6/26/2026,10:25 AM,142,After Meal,"
  ].join("\n");
  const readings = parseContourCsv(csv, "2026-06-26T15:00:00.000Z");
  assert.equal(readings.length, 2);
  assert.equal(readings[0].valueMgDl, 104);
  assert.equal(readings[1].relationToMeal, "After Meal");
});

test("summary keeps latest reading and ascending trend", () => {
  const readings = sanitizePayload({
    source: "test",
    capturedAt: "2026-06-26T15:00:00.000Z",
    readings: [
      { measuredAt: "2026-06-26T12:00:00.000Z", valueMgDl: 110 },
      { measuredAt: "2026-06-26T14:00:00.000Z", valueMgDl: 130 }
    ]
  });
  const summary = summarizeReadings(readings);
  assert.equal(summary.status, "connected");
  assert.equal(summary.latest.valueMgDl, 130);
  assert.deepEqual(summary.trend.map((reading) => reading.valueMgDl), [110, 130]);
});

test("empty summary names the automatic meter bridge boundary", () => {
  const summary = summarizeReadings([]);
  assert.equal(summary.status, "waiting_for_contour_sync");
  assert.match(summary.message, /automatic CONTOUR NEXT ONE Bluetooth glucose upload/);
  assert.match(summary.message, /Health Connect supplies HR, HRV, sleep, and steps/);
  assert.equal(summary.health.status, "waiting_for_health_metrics");
  assert.equal(summary.health.latest.steps.value, null);
  assert.equal(summary.health.anxiety.score, 2);
});

test("sanitizes Health Connect metrics and summarizes anxiety factors", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate: [{ measuredAt: "2026-06-27T11:58:00.000Z", valueBpm: 102 }],
    hrv: [{ measuredAt: "2026-06-27T07:30:00.000Z", rmssdMs: 22 }],
    steps: [{ startTime: "2026-06-27T08:00:00.000Z", endTime: "2026-06-27T12:00:00.000Z", count: 900 }],
    sleepSessions: [{
      startTime: "2026-06-27T03:00:00.000Z",
      endTime: "2026-06-27T08:00:00.000Z",
      stages: [{ stage: "sleeping", startTime: "2026-06-27T03:15:00.000Z", endTime: "2026-06-27T07:45:00.000Z" }]
    }]
  });
  const health = summarizeHealthMetrics(metrics, null, { measuredAt: "2026-06-27T11:55:00.000Z", valueMgDl: 111 });

  assert.equal(metrics.length, 4);
  assert.equal(health.status, "connected");
  assert.equal(health.latest.heartRate.value, 102);
  assert.equal(health.latest.steps.value, 900);
  assert.equal(health.anxiety.scale, "1-5");
  assert.ok(health.anxiety.score >= 3);
  assert.equal(health.anxiety.suggestion.source, "heart_rate");
});
