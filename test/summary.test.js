const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeGlucoseMgDl,
  parseContourCsv,
  sanitizePayload,
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
