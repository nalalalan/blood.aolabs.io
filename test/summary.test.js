const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeGlucoseMgDl,
  parseContourCsv,
  sanitizeHealthPayload,
  sanitizePayload,
  currentTimeBlock,
  estimateAnxietyState,
  estimateInstabilityPatterns,
  editKeyMatches,
  summarizeHealthMetrics,
  estimateAnxietyTrend,
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

test("default edit key is the fixed Blood disregard key", () => {
  const previous = process.env.BLOOD_EDIT_KEY;
  delete process.env.BLOOD_EDIT_KEY;
  try {
    assert.equal(editKeyMatches("031120"), true);
    assert.equal(editKeyMatches("31120"), false);
    assert.equal(editKeyMatches("wrong"), false);
  } finally {
    if (previous == null) {
      delete process.env.BLOOD_EDIT_KEY;
    } else {
      process.env.BLOOD_EDIT_KEY = previous;
    }
  }
});

test("summary disregards hidden glucose readings from latest and trend", () => {
  const readings = sanitizePayload({
    source: "test",
    capturedAt: "2026-06-26T15:00:00.000Z",
    readings: [
      { measuredAt: "2026-06-26T12:00:00.000Z", valueMgDl: 110 },
      { measuredAt: "2026-06-26T14:00:00.000Z", valueMgDl: 130 },
      { measuredAt: "2026-06-26T16:00:00.000Z", valueMgDl: 210 }
    ]
  });
  const ignoredLatest = readings.map((reading) => (
    reading.valueMgDl === 210
      ? { ...reading, disregardedAt: "2026-06-26T16:05:00.000Z", disregardedReason: "user_disregarded" }
      : reading
  ));
  const summary = summarizeReadings(ignoredLatest);
  assert.equal(summary.recordCount, 2);
  assert.equal(summary.ignoredCount, 1);
  assert.equal(summary.latest.valueMgDl, 130);
  assert.deepEqual(summary.trend.map((reading) => reading.valueMgDl), [110, 130]);
  assert.equal(summary.readings.some((reading) => reading.valueMgDl === 210), false);
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

test("heart-rate trend preserves multiple days of dense watch history", () => {
  const start = Date.UTC(2026, 5, 26, 0, 0, 0);
  const heartRate = Array.from({ length: 3 * 24 * 60 }, (_, index) => ({
    measuredAt: new Date(start + index * 60_000).toISOString(),
    valueBpm: index === (3 * 24 * 60) - 1 ? 88 : 62 + (index % 35)
  }));
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-29T00:00:00.000Z",
    heartRate
  });
  const health = summarizeHealthMetrics(metrics, null, null, new Date("2026-06-29T00:00:00.000Z"));
  const trend = health.trends.heartRate;
  const days = new Set(trend.map((point) => point.measuredAt.slice(0, 10)));

  assert.ok(trend.length < heartRate.length);
  assert.ok(trend.length >= 800);
  assert.ok(days.has("2026-06-26"));
  assert.ok(days.has("2026-06-27"));
  assert.ok(days.has("2026-06-28"));
  assert.equal(trend.at(-1).value, 88);
  assert.equal(health.latest.heartRate.value, 88);
});

test("calculates estimated HRV from enough clean sleep heart-rate samples", () => {
  const heartRate = Array.from({ length: 180 }, (_, index) => ({
    measuredAt: new Date(Date.UTC(2026, 5, 27, 2, index, 0)).toISOString(),
    valueBpm: index % 2 === 0 ? 60 : 62
  }));
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate,
    sleepSessions: [{
      startTime: "2026-06-27T02:00:00.000Z",
      endTime: "2026-06-27T05:15:00.000Z"
    }]
  });
  const health = summarizeHealthMetrics(metrics, null, { measuredAt: "2026-06-27T11:55:00.000Z", valueMgDl: 111 });

  assert.equal(health.latest.hrv.value, 32);
  assert.equal(health.latest.hrv.unit, "ms_est");
  assert.equal(health.latest.hrv.estimated, true);
  assert.equal(health.latest.hrv.basis, "sleep_heart_rate_samples");
  assert.equal(health.latest.hrv.sampleCount, 180);
  assert.ok(health.latest.hrv.pairCount >= 120);
  assert.ok(health.latest.hrv.coverageRatio >= 0.9);
  assert.equal(health.latest.hrv.windowSpreadMs, 0);
  assert.equal(health.latest.hrv.quality, "sleep_dense_hr_estimate");
  assert.equal(health.latest.hrv.confidence, "highest_available_without_beat_intervals");
  assert.ok(health.latest.hrv.restWindowCount >= 4);
  assert.equal(health.trends.hrv.length, 1);
  assert.equal(health.anxiety.factors.some((factor) => factor.key === "hrv"), false);
  assert.match(health.anxiety.condition.summary, /estimated HRV looks normal for this Blood estimate/i);
});

test("estimated HRV ignores sparse sleep boundary samples", () => {
  const start = Date.UTC(2026, 5, 27, 2, 0, 0);
  const heartRate = [
    ...Array.from({ length: 18 }, (_, index) => ({
      measuredAt: new Date(start + index * 60_000).toISOString(),
      valueBpm: index % 2 === 0 ? 60 : 62
    })),
    ...Array.from({ length: 18 }, (_, index) => ({
      measuredAt: new Date(Date.UTC(2026, 5, 27, 5, 0, 0) + index * 60_000).toISOString(),
      valueBpm: index % 2 === 0 ? 60 : 62
    }))
  ];
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate,
    sleepSessions: [{
      startTime: "2026-06-27T02:00:00.000Z",
      endTime: "2026-06-27T05:30:00.000Z"
    }]
  });
  const health = summarizeHealthMetrics(metrics, null, { measuredAt: "2026-06-27T11:55:00.000Z", valueMgDl: 111 });

  assert.equal(health.latest.hrv, null);
  assert.deepEqual(health.trends.hrv, []);
});

test("HRV graph uses adjacent context points in short ranges", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

  assert.match(appSource, /\["hrv",\s*"sleep",\s*"steps"\]\.includes\(key\)/);
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

test("does not estimate HRV from noisy heart-rate samples", () => {
  const heartRate = Array.from({ length: 180 }, (_, index) => ({
    measuredAt: new Date(Date.UTC(2026, 5, 27, 2, index, 0)).toISOString(),
    valueBpm: index % 9 === 0 ? 108 : (index % 2 === 0 ? 60 : 62)
  }));
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-27T12:00:00.000Z",
    heartRate,
    sleepSessions: [{
      startTime: "2026-06-27T02:00:00.000Z",
      endTime: "2026-06-27T05:15:00.000Z"
    }]
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

test("anxiety condition uses overall source state and one positive action", () => {
  assert.equal(currentTimeBlock(17), "afternoon");
  const anxiety = estimateAnxietyState({
    glucose: { valueMgDl: 112 },
    heartRate: { value: 104 },
    hrv: { value: 45 },
    sleep: { asleepMinutes: 430 },
    recentSteps: 8300,
    hour: 17
  });

  assert.equal(anxiety.suggestion.label, "Overall condition");
  assert.equal(anxiety.suggestion.source, "heart_rate");
  assert.equal(anxiety.suggestion.reason, "104 bpm HR is too high.");
  assert.equal(anxiety.suggestion.action, "Water more; protein/fiber snack more; easy walk more.");
  assert.equal(anxiety.condition.label, "Overall condition");
  assert.match(anxiety.condition.summary, /You look|main concern|high HR/i);
  assert.match(anxiety.condition.watch, /watchful read|source pattern/i);
  assert.doesNotMatch(`${anxiety.condition.summary} ${anxiety.condition.watch}`, /Easy moves|Closest lever|Blood will change this/i);
  assert.doesNotMatch(anxiety.suggestion.action, /until|before|after|next stable time|checkpoint/i);
  assert.doesNotMatch(`${anxiety.suggestion.label} ${anxiety.suggestion.reason} ${anxiety.suggestion.action}`, /\bnow\b|outlier|\bless\b|avoid|restrict|reduce|stop/i);
});

test("estimated HRV alone reads normal for the estimate instead of too low", () => {
  const anxiety = estimateAnxietyState({
    glucose: { valueMgDl: 104 },
    heartRate: { value: 68 },
    hrv: { value: 12, estimated: true, derived: true },
    sleep: { asleepMinutes: 430 },
    recentSteps: 5300,
    hour: 23
  });

  assert.equal(anxiety.suggestion.label, "Overall condition");
  assert.notEqual(anxiety.suggestion.source, "hrv");
  assert.match(anxiety.condition.summary, /estimated HRV looks normal for this Blood estimate/i);
  assert.doesNotMatch(`${anxiety.suggestion.reason} ${anxiety.condition.summary} ${anxiety.condition.watch}`, /estimated HRV is too low|estimated HRV too low/i);
  assert.doesNotMatch(anxiety.condition.watch, /food and water first|task switching|quiet reset|phone|screen|breath|exhale|focus|work|commitment|open task|\bless\b|avoid|restrict|reduce|stop/i);
  assert.doesNotMatch(`${anxiety.condition.summary} ${anxiety.condition.watch}`, /Easy moves|Closest lever|Blood will change this/i);
});

test("early-day low steps do not become the main condition watchout", () => {
  const anxiety = estimateAnxietyState({
    glucose: { valueMgDl: 113 },
    heartRate: { value: 84 },
    hrv: { value: 23, estimated: true, derived: true },
    recentSteps: 77,
    referenceAt: "2026-06-29T05:32:00.000Z"
  });
  const text = `${anxiety.suggestion.reason} ${anxiety.condition.summary} ${anxiety.condition.watch}`;

  assert.ok(anxiety.score < 4.4);
  assert.doesNotMatch(text, /movement is light|steps today is too low|steps today is low/i);
  assert.match(anxiety.condition.summary, /77 steps are logged so far today/);
});

test("stale sleep does not drive the current anxiety action", () => {
  const anxiety = estimateAnxietyState({
    glucose: { valueMgDl: 104 },
    heartRate: { value: 68 },
    hrv: { value: 70 },
    sleep: { asleepMinutes: 240, measuredAt: "2026-06-25T08:00:00.000Z" },
    recentSteps: 9000,
    referenceAt: "2026-06-28T12:00:00.000Z"
  });

  assert.equal(anxiety.factors.some((factor) => factor.key === "sleep"), false);
  assert.notEqual(anxiety.suggestion.source, "sleep");
  assert.ok(anxiety.score < 4);
  assert.doesNotMatch(`${anxiety.suggestion.reason} ${anxiety.suggestion.action}`, /sleep|asleep|too short|short/i);
});

test("fresh sleep can affect the score but never becomes the visible recommendation", () => {
  const anxiety = estimateAnxietyState({
    sleep: { asleepMinutes: 240, measuredAt: "2026-06-28T08:00:00.000Z" },
    referenceAt: "2026-06-28T12:00:00.000Z"
  });

  assert.equal(anxiety.factors.some((factor) => factor.key === "sleep"), true);
  assert.equal(anxiety.suggestion.source, "none");
  assert.doesNotMatch(`${anxiety.suggestion.reason} ${anxiety.suggestion.action}`, /sleep|asleep|too short|short/i);
});

test("blood recommendation actions stay positive and inside food water or movement", () => {
  const banned = /phone|screen|breath|exhale|task|focus|work|commitment|switch|reset|drift|open|\bless\b|avoid|restrict|reduce|stop|sitting|intensity|skipped/i;
  const allowed = /carb|protein|fiber|food|meal|snack|drink|water|walk|movement|exercise/i;
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

test("steps use latest daily total instead of summing repeated same-day uploads", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-28T18:00:00.000Z",
    steps: [
      { startTime: "2026-06-28T04:00:00.000Z", endTime: "2026-06-29T03:59:59.999Z", zoneOffset: "-04:00", count: 4200 },
      { startTime: "2026-06-28T04:00:00.000Z", endTime: "2026-06-29T03:59:59.999Z", zoneOffset: "-04:00", count: 6100 },
      { startTime: "2026-06-28T04:00:00.000Z", endTime: "2026-06-29T03:59:59.999Z", zoneOffset: "-04:00", count: 5900 }
    ]
  });
  const health = summarizeHealthMetrics(metrics, null, null, new Date("2026-06-28T18:30:00.000Z"));

  assert.equal(health.latest.steps.value, 6100);
  assert.equal(health.latest.steps.date, "2026-06-28");
  assert.equal(health.latest.steps.aggregation, "daily_latest_total");
  assert.equal(health.trends.steps.length, 1);
  assert.equal(health.trends.steps[0].value, 6100);
});

test("steps still sum separate same-day interval records", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-28T18:00:00.000Z",
    steps: [
      { clientRecordId: "morning", startTime: "2026-06-28T12:00:00.000Z", endTime: "2026-06-28T13:00:00.000Z", zoneOffset: "-04:00", count: 1200 },
      { clientRecordId: "afternoon", startTime: "2026-06-28T17:00:00.000Z", endTime: "2026-06-28T18:00:00.000Z", zoneOffset: "-04:00", count: 900 }
    ]
  });
  const health = summarizeHealthMetrics(metrics, null, null, new Date("2026-06-28T18:30:00.000Z"));

  assert.equal(health.latest.steps.value, 2100);
  assert.equal(health.latest.steps.aggregation, "daily_interval_sum");
  assert.equal(health.trends.steps[0].value, 2100);
});

test("anxiety score uses quick metric changes from time history", () => {
  const readings = sanitizePayload({
    source: "test",
    capturedAt: "2026-06-28T18:00:00.000Z",
    readings: [
      { measuredAt: "2026-06-28T15:00:00.000Z", valueMgDl: 160 },
      { measuredAt: "2026-06-28T17:00:00.000Z", valueMgDl: 95 }
    ]
  });
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-28T18:00:00.000Z",
    heartRate: [{ measuredAt: "2026-06-28T17:05:00.000Z", valueBpm: 68 }],
    steps: [{ startTime: "2026-06-28T04:00:00.000Z", endTime: "2026-06-29T03:59:59.999Z", zoneOffset: "-04:00", count: 8000 }]
  });
  const health = summarizeHealthMetrics(metrics, null, readings.at(-1), new Date("2026-06-28T18:00:00.000Z"));
  const summary = summarizeReadings(readings, health);

  assert.ok(summary.health.anxiety.dynamics.some((factor) => factor.label === "glucose dropped quickly"));
  assert.equal(summary.health.anxiety.suggestion.source, "glucose");
  assert.match(summary.health.anxiety.suggestion.reason, /glucose drop/);
  assert.match(summary.health.anxiety.suggestion.action, /Carb plus protein snack more; water more/);
  assert.ok(summary.health.trends.anxiety.some((point) => /glucose drop/.test(point.reason)));
});

test("instability patterns identify the strongest source-backed time block", () => {
  const readings = sanitizePayload({
    source: "test",
    capturedAt: "2026-06-28T04:00:00.000Z",
    readings: [
      { measuredAt: "2026-06-27T02:05:00.000Z", valueMgDl: 160 },
      { measuredAt: "2026-06-27T02:35:00.000Z", valueMgDl: 145 },
      { measuredAt: "2026-06-27T16:05:00.000Z", valueMgDl: 96 },
      { measuredAt: "2026-06-27T16:35:00.000Z", valueMgDl: 104 }
    ]
  });
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-28T04:00:00.000Z",
    heartRate: [
      { measuredAt: "2026-06-27T02:10:00.000Z", valueBpm: 106 },
      { measuredAt: "2026-06-27T02:20:00.000Z", valueBpm: 104 },
      { measuredAt: "2026-06-27T16:10:00.000Z", valueBpm: 68 }
    ],
    hrv: [{ measuredAt: "2026-06-27T02:30:00.000Z", rmssdMs: 18 }]
  });
  const health = summarizeHealthMetrics(metrics, null, { measuredAt: "2026-06-27T16:35:00.000Z", valueMgDl: 104 });
  const patterns = estimateInstabilityPatterns({
    readings,
    health,
    now: new Date("2026-06-28T04:00:00.000Z")
  });

  assert.equal(patterns.status, "active");
  assert.equal(patterns.currentBlock, "night");
  assert.equal(patterns.prediction.block, "night");
  assert.equal(patterns.prediction.title, "Things to watch");
  assert.match(patterns.prediction.detail, /glucose|HR|HRV/);
  assert.match(patterns.prediction.detail, /too high|HRV low|near high|raised|light|short/);
  assert.match(patterns.prediction.detail, /mg\/dL|bpm|ms|h|steps/);
  assert.doesNotMatch(patterns.prediction.detail, /sleep|asleep/i);
  assert.doesNotMatch(patterns.prediction.detail, /flagged|outlier|source samples|read high, low, short, light, or raised/i);
  assert.match(patterns.prediction.basis, /updates after each upload/);
});

test("sleep-only history stays off the visible pattern recommendation", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-28T12:00:00.000Z",
    sleepSessions: [
      { startTime: "2026-06-25T03:00:00.000Z", endTime: "2026-06-25T07:00:00.000Z", stages: [] },
      { startTime: "2026-06-26T03:00:00.000Z", endTime: "2026-06-26T07:30:00.000Z", stages: [] },
      { startTime: "2026-06-27T03:00:00.000Z", endTime: "2026-06-27T07:20:00.000Z", stages: [] },
      { startTime: "2026-06-28T03:00:00.000Z", endTime: "2026-06-28T07:10:00.000Z", stages: [] },
      { startTime: "2026-06-24T03:00:00.000Z", endTime: "2026-06-24T07:40:00.000Z", stages: [] },
      { startTime: "2026-06-23T03:00:00.000Z", endTime: "2026-06-23T07:50:00.000Z", stages: [] }
    ]
  });
  const health = summarizeHealthMetrics(metrics, null, null, new Date("2026-06-28T12:00:00.000Z"));
  const patterns = estimateInstabilityPatterns({
    readings: [],
    health,
    now: new Date("2026-06-28T12:00:00.000Z")
  });

  assert.equal(patterns.status, "best_effort");
  assert.match(patterns.detail, /No clear repeating spike or dip yet|Watch glucose, HR, HRV trend, and steps/i);
  assert.doesNotMatch(`${patterns.title} ${patterns.detail} ${patterns.prediction?.detail || ""}`, /sleep|asleep|too short|short|Need more|learning/i);
});

test("thin data pattern still gives best-effort abnormal signal and action", () => {
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-28T12:00:00.000Z",
    hrv: [{ measuredAt: "2026-06-28T11:30:00.000Z", rmssdMs: 23 }]
  });
  const health = summarizeHealthMetrics(metrics, null, null, new Date("2026-06-28T12:00:00.000Z"));
  const patterns = estimateInstabilityPatterns({
    readings: [],
    health,
    now: new Date("2026-06-28T12:00:00.000Z")
  });

  assert.equal(patterns.status, "best_effort");
  assert.equal(patterns.title, "Things to watch");
  assert.match(patterns.detail, /possible dip concern|HRV low|23 ms|If this shows up again/);
  assert.match(patterns.simpleDetail, /Watch|HRV dipping|If it shows up again/i);
  assert.match(patterns.detail, /drink water|eat protein\/fiber with carbs|take an easy walk/);
  assert.doesNotMatch(`${patterns.title} ${patterns.detail}`, /Need more|learning|sleep|asleep|too short|short|phone|screen|breath|task|\bless\b|avoid|restrict|reduce|stop/i);
});

test("anxiety trend reconstructs historical score points from glucose and health samples", () => {
  const readings = sanitizePayload({
    source: "test",
    capturedAt: "2026-06-28T04:00:00.000Z",
    readings: [
      { measuredAt: "2026-06-27T12:00:00.000Z", valueMgDl: 104 },
      { measuredAt: "2026-06-27T13:00:00.000Z", valueMgDl: 148 }
    ]
  });
  const metrics = sanitizeHealthPayload({
    source: "health-connect",
    capturedAt: "2026-06-28T04:00:00.000Z",
    heartRate: [{ measuredAt: "2026-06-27T13:05:00.000Z", valueBpm: 106 }],
    hrv: [{ measuredAt: "2026-06-27T12:30:00.000Z", rmssdMs: 22 }]
  });
  const health = summarizeHealthMetrics(metrics, null, readings[1]);
  const trend = estimateAnxietyTrend({ readings, health });

  assert.ok(trend.length >= 1);
  assert.ok(trend.every((point) => point.unit === "score_1_10"));
  assert.ok(trend.every((point) => point.value >= 1 && point.value <= 10));
  assert.ok(trend.some((point) => point.source === "heart_rate" || point.source === "hrv"));
});
