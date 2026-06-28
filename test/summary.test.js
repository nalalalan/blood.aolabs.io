const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeGlucoseMgDl,
  parseContourCsv,
  sanitizeHealthPayload,
  sanitizePayload,
  currentTimeBlock,
  estimateAnxietyState,
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
  assert.match(summary.message, /Blood estimates HRV from sleep\/rest heart-rate samples/);
  assert.equal(summary.health.status, "waiting_for_health_metrics");
  assert.equal(summary.health.latest.steps.value, null);
  assert.equal(summary.health.anxiety.score, 4.4);
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
  assert.equal(health.anxiety.scale, "1-10");
  assert.ok(health.anxiety.score >= 6);
  assert.equal(health.anxiety.suggestion.source, "heart_rate");
});

test("calculates estimated HRV from enough heart-rate samples", () => {
  const heartRate = Array.from({ length: 80 }, (_, index) => ({
    measuredAt: new Date(Date.UTC(2026, 5, 27, 2, index, 0)).toISOString(),
    valueBpm: index % 2 === 0 ? 60 : 62
  }));
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate,
    sleepSessions: [{
      startTime: "2026-06-27T02:00:00.000Z",
      endTime: "2026-06-27T03:30:00.000Z"
    }]
  });
  const health = summarizeHealthMetrics(metrics, null, { measuredAt: "2026-06-27T11:55:00.000Z", valueMgDl: 111 });

  assert.equal(health.latest.hrv.value, 32);
  assert.equal(health.latest.hrv.unit, "ms_est");
  assert.equal(health.latest.hrv.estimated, true);
  assert.equal(health.latest.hrv.basis, "sleep_heart_rate_samples");
  assert.equal(health.latest.hrv.sampleCount, 80);
  assert.ok(health.latest.hrv.pairCount >= 120);
  assert.equal(health.latest.hrv.quality, "sleep_dense_hr_estimate");
  assert.equal(health.latest.hrv.confidence, "highest_available_without_beat_intervals");
  assert.ok(health.latest.hrv.restWindowCount > 1);
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
  const heartRate = Array.from({ length: 80 }, (_, index) => ({
    measuredAt: new Date(Date.UTC(2026, 5, 27, 2, index, 0)).toISOString(),
    valueBpm: index % 2 === 0 ? 60 : 63
  }));
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate,
    sleepSessions: [{
      startTime: "2026-06-27T02:00:00.000Z",
      endTime: "2026-06-27T03:30:00.000Z"
    }],
    hrv: [{ measuredAt: "2026-06-27T07:30:00.000Z", rmssdMs: 41 }]
  });
  const health = summarizeHealthMetrics(metrics, null, null);

  assert.equal(health.trends.hrv.length, 1);
  assert.equal(health.latest.hrv.value, 41);
  assert.equal(health.latest.hrv.estimated, false);
  assert.equal(health.latest.hrv.basis, "health_connect_rmssd");
});

test("anxiety suggestion uses current block and one more-less action", () => {
  assert.equal(currentTimeBlock(17), "afternoon");
  const anxiety = estimateAnxietyState({
    glucose: { valueMgDl: 112 },
    heartRate: { value: 104 },
    hrv: { value: 45 },
    sleep: { asleepMinutes: 430 },
    recentSteps: 8300,
    hour: 17
  });

  assert.equal(anxiety.suggestion.time, "afternoon");
  assert.equal(anxiety.suggestion.source, "heart_rate");
  assert.equal(anxiety.suggestion.action, "Water plus light movement more; hard exercise less.");
  assert.doesNotMatch(anxiety.suggestion.action, /until|before|after|next stable time|checkpoint/i);
});

test("anxiety suggestion keeps low HRV concrete and source-backed", () => {
  const anxiety = estimateAnxietyState({
    glucose: { valueMgDl: 104 },
    heartRate: { value: 68 },
    hrv: { value: 12, estimated: true, derived: true },
    sleep: { asleepMinutes: 430 },
    recentSteps: 5300,
    hour: 23
  });

  assert.equal(anxiety.suggestion.time, "night");
  assert.equal(anxiety.suggestion.source, "hrv");
  assert.equal(anxiety.suggestion.reason, "12 ms estimated HRV is low.");
  assert.equal(anxiety.suggestion.action, "Water plus small food more; sitting still less.");
  assert.doesNotMatch(anxiety.suggestion.action, /food and water first|task switching|quiet reset|phone|screen|breath|exhale|focus|work|commitment|open task/i);
});

test("blood recommendation actions stay inside food water or movement", () => {
  const banned = /phone|screen|breath|exhale|task|focus|work|commitment|switch|reset|drift|open/i;
  const allowed = /carb|protein|fiber|food|meal|snack|sugar|drink|water|walk|movement|exercise|sitting|intensity/i;
  const scenarios = [
    {
      glucose: { valueMgDl: 62 },
      heartRate: { value: 104 },
      hrv: { value: 12, estimated: true },
      sleep: { asleepMinutes: 240 },
      recentSteps: 900,
      hour: 10
    },
    {
      glucose: { valueMgDl: 145 },
      heartRate: { value: 88 },
      hrv: { value: 32, estimated: true },
      sleep: { asleepMinutes: 340 },
      recentSteps: 2500,
      hour: 14
    },
    {
      glucose: { valueMgDl: 104 },
      heartRate: { value: 68 },
      hrv: { value: 70 },
      sleep: { asleepMinutes: 430 },
      recentSteps: 9000,
      hour: 23
    },
    { hour: 23 }
  ];
  const actions = scenarios.flatMap((scenario) => {
    const anxiety = estimateAnxietyState(scenario);
    return [...anxiety.factors.map((factor) => factor.action), anxiety.suggestion.action];
  });

  for (const action of actions) {
    assert.match(action, allowed);
    assert.doesNotMatch(action, banned);
  }
});
