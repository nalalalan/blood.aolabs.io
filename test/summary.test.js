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
  assert.match(summary.message, /Blood estimates HRV from heart-rate samples/);
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
  assert.equal(health.latest.hrv.value, 22);
  assert.equal(health.latest.hrv.estimated, false);
  assert.equal(health.latest.hrv.basis, "health_connect_rmssd");
  assert.equal(health.latest.steps.value, 900);
  assert.equal(health.trends.heartRate.length, 1);
  assert.equal(health.trends.hrv.length, 1);
  assert.equal(health.trends.sleep[0].value, 300);
  assert.equal(health.trends.steps[0].value, 900);
  assert.equal(health.anxiety.scale, "1-5");
  assert.ok(health.anxiety.score >= 3);
  assert.equal(health.anxiety.suggestion.source, "heart_rate");
});

test("calculates estimated HRV from enough heart-rate samples", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate: [
      { measuredAt: "2026-06-27T11:57:00.000Z", valueBpm: 60 },
      { measuredAt: "2026-06-27T11:58:00.000Z", valueBpm: 62 },
      { measuredAt: "2026-06-27T11:59:00.000Z", valueBpm: 60 }
    ]
  });
  const health = summarizeHealthMetrics(metrics, null, { measuredAt: "2026-06-27T11:55:00.000Z", valueMgDl: 111 });

  assert.equal(health.latest.hrv.value, 32);
  assert.equal(health.latest.hrv.unit, "ms_est");
  assert.equal(health.latest.hrv.estimated, true);
  assert.equal(health.latest.hrv.basis, "heart_rate_samples");
  assert.equal(health.latest.hrv.sampleCount, 3);
  assert.equal(health.latest.hrv.pairCount, 2);
  assert.equal(health.latest.hrv.quality, "dense_hr_estimate");
  assert.equal(health.trends.hrv.length, 1);
  assert.match(health.anxiety.factors.find((factor) => factor.key === "hrv")?.label || "", /estimated HRV/);
});

test("does not estimate HRV from too few heart-rate samples", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate: [
      { measuredAt: "2026-06-27T11:58:00.000Z", valueBpm: 70 },
      { measuredAt: "2026-06-27T11:59:00.000Z", valueBpm: 76 }
    ]
  });
  const health = summarizeHealthMetrics(metrics, null, { measuredAt: "2026-06-27T11:55:00.000Z", valueMgDl: 111 });

  assert.equal(health.latest.hrv, null);
  assert.deepEqual(health.trends.hrv, []);
});

test("prefers source HRV over calculated HRV for the same date", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate: [
      { measuredAt: "2026-06-27T11:57:00.000Z", valueBpm: 60 },
      { measuredAt: "2026-06-27T11:58:00.000Z", valueBpm: 63 },
      { measuredAt: "2026-06-27T11:59:00.000Z", valueBpm: 60 }
    ],
    hrv: [{ measuredAt: "2026-06-27T07:30:00.000Z", rmssdMs: 41 }]
  });
  const health = summarizeHealthMetrics(metrics, null, null);

  assert.equal(health.trends.hrv.length, 1);
  assert.equal(health.latest.hrv.value, 41);
  assert.equal(health.latest.hrv.estimated, false);
  assert.equal(health.latest.hrv.basis, "health_connect_rmssd");
});
