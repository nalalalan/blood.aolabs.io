const syncLine = document.getElementById("sync-line");
const freshnessLine = document.getElementById("freshness-line");
const refreshButton = document.getElementById("refresh-button");
const latestValue = document.getElementById("latest-value");
const latestUnit = document.getElementById("latest-unit");
const latestTime = document.getElementById("latest-time");
const latestSource = document.getElementById("latest-source");
const rangeSummary = document.getElementById("range-summary");
const rangeDetail = document.getElementById("range-detail");
const charts = document.getElementById("charts");
const currentReadings = document.querySelector(".current-readings");
const readingsBody = document.getElementById("readings-body");
const recordCount = document.getElementById("record-count");
const manageTokenInput = document.getElementById("manage-token");
const manageStatus = document.getElementById("manage-status");
const rangeButtons = Array.from(document.querySelectorAll("[data-range]"));
const csvImportForm = document.getElementById("csv-import-form");
const csvFileInput = document.getElementById("csv-file");
const csvTokenInput = document.getElementById("csv-token");
const csvSubmit = document.getElementById("csv-submit");
const csvStatus = document.getElementById("csv-status");
const manualEntryForm = document.getElementById("manual-entry-form");
const manualValueInput = document.getElementById("manual-value");
const manualTimeInput = document.getElementById("manual-time");
const manualMarkerInput = document.getElementById("manual-marker");
const manualTokenInput = document.getElementById("manual-token");
const manualSubmit = document.getElementById("manual-submit");
const manualStatus = document.getElementById("manual-status");
const anxietyScore = document.getElementById("anxiety-score");
const metricGlucose = document.getElementById("metric-glucose");
const metricHr = document.getElementById("metric-hr");
const metricHrv = document.getElementById("metric-hrv");
const metricSleep = document.getElementById("metric-sleep");
const metricSteps = document.getElementById("metric-steps");
const healthRead = document.getElementById("health-read");

const LIVE_API_BASE = "https://blood.aolabs.io";
const configuredApiBase = document.querySelector("meta[name='blood-api-base']")?.content || "";
const API_BASE = (configuredApiBase || (location.hostname === "aolabs.io" ? LIVE_API_BASE : "")).replace(/\/$/, "");
const POLL_MS = 30 * 1000;
const WRITE_TOKEN_STORAGE_KEY = "bloodWriteToken";
const EDIT_KEY_STORAGE_KEY = "bloodEditKey";
const DEFAULT_EDIT_KEY = "031120";

let latestData = null;
let activeRange = "7";
let pollTimer = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function storedWriteToken() {
  try {
    return window.localStorage.getItem(WRITE_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storedEditKey() {
  try {
    return window.localStorage.getItem(EDIT_KEY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberWriteToken(token) {
  const clean = String(token || "").trim();
  if (!clean) return;
  try {
    window.localStorage.setItem(WRITE_TOKEN_STORAGE_KEY, clean);
  } catch {
    // Private browsing may reject storage; current inputs still work.
  }
}

function rememberEditKey(token) {
  const clean = String(token || "").trim();
  if (!clean) return;
  try {
    window.localStorage.setItem(EDIT_KEY_STORAGE_KEY, clean);
  } catch {
    // Private browsing may reject storage; the default edit key still works.
  }
}

function fillWriteTokenInputs(token) {
  const clean = String(token || "").trim();
  if (!clean) return;
  [manualTokenInput, csvTokenInput].forEach((input) => {
    if (input && !input.value) input.value = clean;
  });
}

function fillEditKeyInput(token) {
  const clean = String(token || "").trim();
  if (manageTokenInput) manageTokenInput.value = clean || DEFAULT_EDIT_KEY;
}

function currentEditKey() {
  return String(manageTokenInput?.value || storedEditKey() || DEFAULT_EDIT_KEY).trim();
}

function setManageState(message, busy = false) {
  if (manageStatus) manageStatus.textContent = message;
  readingsBody?.querySelectorAll("[data-disregard-id]").forEach((button) => {
    button.disabled = busy;
    button.toggleAttribute("aria-busy", busy);
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function timeMs(value) {
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function latestPlotAt(metric) {
  return metric?.capturedAt || metric?.measuredAt || "";
}

function pointPlotTime(point) {
  return timeMs(point?.plotAt) ?? timeMs(point?.measuredAt) ?? 0;
}

function minutesBetween(later, earlier) {
  const laterMs = timeMs(later);
  const earlierMs = timeMs(earlier);
  if (laterMs == null || earlierMs == null) return null;
  return Math.round((laterMs - earlierMs) / 60_000);
}

function sourceFreshnessText(data) {
  const health = data?.health || {};
  const latest = health.latest || {};
  const generatedAt = data?.generatedAt || new Date().toISOString();
  const uploadAt = health.lastCapturedAt || data?.lastCapturedAt || "";
  const heartRateAt = latest.heartRate?.measuredAt || "";
  const hrv = latest.hrv || null;
  const uploadAge = minutesBetween(generatedAt, uploadAt);
  const heartRateGap = minutesBetween(uploadAt, heartRateAt);
  const parts = [];

  if (!uploadAt) {
    parts.push("No health upload reached Blood yet.");
  } else if (uploadAge != null && uploadAge > 45) {
    parts.push(`Health upload stale: ${formatDateTime(uploadAt)}.`);
  } else {
    parts.push(`Health upload ${formatDateTime(uploadAt)}.`);
  }

  if (!heartRateAt) {
    parts.push("No HR sample reached Blood.");
  } else if (heartRateGap != null && heartRateGap > 30) {
    parts.push(`Samsung/Health Connect HR shared through ${formatDateTime(heartRateAt)}.`);
  } else {
    parts.push(`HR shared ${formatDateTime(heartRateAt)}.`);
  }

  if (hrv?.measuredAt) {
    const hrvSource = hrv.estimated || hrv.derived ? hrvBasisLabel(hrv) : "source RMSSD";
    parts.push(`HRV: ${hrvSource} ${formatDateTime(hrv.measuredAt)}.`);
  } else {
    parts.push("No HRV source reached Blood.");
  }

  return parts.join(" ");
}

function currentReadingsTime(data) {
  return data?.health?.lastCapturedAt || data?.lastCapturedAt || data?.latest?.measuredAt || "";
}

function currentReadingsSourceText(data) {
  const glucoseAt = data?.latest?.measuredAt ? `Glucose ${formatDateTime(data.latest.measuredAt)}.` : "";
  const healthAt = data?.health?.lastCapturedAt ? `Health ${formatDateTime(data.health.lastCapturedAt)}.` : "";
  return [healthAt, glucoseAt].filter(Boolean).join(" ") || "Waiting for bridge response.";
}

function metricStamp(metric, field = "measuredAt") {
  const stamp = metric?.[field];
  const formatted = stamp ? formatDateTime(stamp) : "";
  return formatted ? `as of ${formatted}` : "";
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatHours(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return "";
  return `${(value / 60).toFixed(1)}h`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Math.round(number).toLocaleString();
}

function formatHrvMetric(metric) {
  if (!metric?.value || !Number.isFinite(Number(metric.value))) return "";
  return `${Math.round(Number(metric.value))} ms${metric.estimated || metric.derived ? " est" : ""}`;
}

function formatScore10(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "2.0";
  return score.toFixed(1);
}

function hrvBasisLabel(metric) {
  if (!metric?.estimated && !metric?.derived) return "source RMSSD";
  if (metric.basis === "sleep_heart_rate_samples") return "sleep HR estimate";
  if (metric.basis === "resting_heart_rate_samples") return "resting HR estimate";
  return "HR estimate";
}

function hrvDetailLabel(metric) {
  const parts = [hrvBasisLabel(metric)];
  if (metric?.confidence) parts.push(metric.confidence.replace(/_/g, " "));
  if (Number.isFinite(Number(metric?.restWindowCount))) parts.push(`${metric.restWindowCount} windows`);
  if (Number.isFinite(Number(metric?.pairCount))) parts.push(`${metric.pairCount} pairs`);
  if (Number.isFinite(Number(metric?.medianGapMinutes))) parts.push(`${metric.medianGapMinutes} min median gap`);
  if (Number.isFinite(Number(metric?.windowSpreadMs))) parts.push(`${metric.windowSpreadMs} ms window spread`);
  return parts.join(", ");
}

function daysAgo(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

function sourceLabel(reading, compact = false) {
  if (!reading) return "";
  if (reading.source === "contour-meter-ble") return compact ? "Meter bridge" : "CONTOUR meter bridge";
  if (reading.source === "contour-csv") return compact ? "CSV" : "Contour CSV";
  if (reading.source === "manual-entry") return compact ? "Manual" : "Manual entry";
  if (reading.source === "health-connect") {
    if (compact) return "Health Connect";
    return reading.sourcePackage ? `Health Connect / ${reading.sourcePackage}` : "Health Connect";
  }
  return reading.source || "manual";
}

function markerLabel(reading) {
  const parts = [reading?.relationToMeal, reading?.mealType].filter(Boolean);
  return parts.length ? parts.join(" / ") : "";
}

function filteredTrend(data) {
  const trend = [...(data?.trend || [])];
  if (activeRange === "all") return trend;
  const days = Number.parseInt(activeRange, 10);
  const cutoff = days === 1 ? Date.now() - 24 * 60 * 60 * 1000 : daysAgo(days);
  return trend.filter((reading) => new Date(reading.measuredAt).getTime() >= cutoff);
}

function rangeDurationMs() {
  if (activeRange === "all") return null;
  const days = Number.parseInt(activeRange, 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days * 24 * 60 * 60 * 1000;
}

function selectedTimeWindow(seriesList) {
  const allTimes = seriesList
    .flatMap((series) => series.points || [])
    .map(pointPlotTime)
    .filter((time) => Number.isFinite(time) && time > 0);
  if (!allTimes.length) return null;
  const max = Math.max(...allTimes);
  if (activeRange === "all") {
    return { min: Math.min(...allTimes), max };
  }
  const duration = rangeDurationMs();
  return duration ? { min: max - duration, max } : { min: Math.min(...allTimes), max };
}

function visibleSeriesPoints(points, window) {
  if (!window) return [];
  return points.filter((point) => {
    const time = pointPlotTime(point);
    return time >= window.min && time <= window.max;
  });
}

function lineSeriesPoints(points, visiblePoints, window, key) {
  if (!window || activeRange === "all" || !["hrv", "sleep", "steps"].includes(key)) return visiblePoints;
  const before = [...points].reverse().find((point) => pointPlotTime(point) < window.min);
  const after = points.find((point) => pointPlotTime(point) > window.max);
  return [before, ...visiblePoints, after]
    .filter(Boolean)
    .filter((point, index, list) => list.findIndex((item) => item === point) === index)
    .sort((a, b) => pointPlotTime(a) - pointPlotTime(b));
}

function renderBoundary(message, detail = "") {
  charts.innerHTML = `
    <div class="chart-boundary" role="status">
      <strong>${message}</strong>
      <p>${detail}</p>
    </div>
  `;
}

function buildSeries(data) {
  const healthTrends = data?.health?.trends || {};
  const latest = data?.health?.latest || {};
  const latestAnxiety = data?.health?.anxiety || {};
  const latestGlucose = latest.glucose || data?.latest || null;
  const currentEndpointAt = [
    latestGlucose,
    latest.heartRate,
    latest.hrv,
    latest.sleep,
    latest.steps
  ]
    .map(latestPlotAt)
    .filter(Boolean)
    .sort((a, b) => (timeMs(b) ?? 0) - (timeMs(a) ?? 0))[0] || "";
  const latestSleepMinutes = latest.sleep?.asleepMinutes ?? latest.sleep?.value;
  const currentLabels = {
    anxiety: Number.isFinite(Number(latestAnxiety.score)) ? `${formatScore10(latestAnxiety.score)}/10` : "",
    glucose: latestGlucose?.valueMgDl ? `${latestGlucose.valueMgDl} mg/dL` : "",
    "heart-rate": latest.heartRate?.value ? `${latest.heartRate.value} bpm` : "",
    hrv: formatHrvMetric(latest.hrv),
    sleep: latestSleepMinutes != null && Number.isFinite(Number(latestSleepMinutes))
      ? `${(Number(latestSleepMinutes) / 60).toFixed(1)} h`
      : "",
    steps: latest.steps?.value != null && Number.isFinite(Number(latest.steps.value))
      ? `${formatNumber(latest.steps.value)} steps`
      : ""
  };
  const currentStamps = {
    anxiety: latestAnxiety.label ? latestAnxiety.label : "",
    glucose: metricStamp(latestGlucose),
    "heart-rate": metricStamp(latest.heartRate),
    hrv: latest.hrv ? `${hrvBasisLabel(latest.hrv)}${metricStamp(latest.hrv) ? ` - ${metricStamp(latest.hrv)}` : ""}` : "",
    sleep: metricStamp(latest.sleep),
    steps: metricStamp(latest.steps, "capturedAt")
  };
  const withLatest = (points, latestMetric, valueMapper = (metric) => metric?.value, titleMapper = null) => {
    if (!latestMetric?.measuredAt) return points;
    const value = valueMapper(latestMetric);
    if (!Number.isFinite(Number(value))) return points;
    const latestPoint = {
      measuredAt: latestMetric.measuredAt,
      plotAt: latestPlotAt(latestMetric),
      value: Number(value),
      title: titleMapper
        ? titleMapper(latestMetric, Number(value))
        : `${formatDateTime(latestMetric.measuredAt)}: ${formatNumber(value)}`
    };
    if (!points.length) return [latestPoint];
    const latestTime = timeMs(latestMetric.measuredAt);
    const matchedIndex = points.findIndex((point) => timeMs(point.measuredAt) === latestTime);
    if (matchedIndex >= 0) {
      return points.map((point, index) => (index === matchedIndex ? { ...point, ...latestPoint } : point));
    }
    return [...points, latestPoint];
  };
  return [
    {
      key: "anxiety",
      title: "Anxiety",
      unit: "/10",
      empty: "Waiting for enough source history.",
      currentLabel: currentLabels.anxiety,
      currentStamp: currentStamps.anxiety,
      yFloor: 1,
      yCeil: 10,
      ticks: [1, 3, 5, 7, 10],
      points: [...(healthTrends.anxiety || [])].map((point, index, list) => ({
        measuredAt: point.measuredAt,
        plotAt: index === list.length - 1 ? currentEndpointAt : point.plotAt,
        value: point.value,
        title: `${formatDateTime(point.measuredAt)}: ${formatScore10(point.value)}/10${point.reason ? ` - ${point.reason}` : ""}`
      }))
    },
    {
      key: "glucose",
      title: "Glucose",
      unit: "mg/dL",
      empty: "Waiting for CONTOUR meter upload.",
      currentLabel: currentLabels.glucose,
      currentStamp: currentStamps.glucose,
      reference: [70, 180],
      yFloor: 60,
      yCeil: 200,
      ticks: [60, 100, 140, 180, 220],
      points: withLatest([...(data?.trend || [])].map((reading) => ({
        measuredAt: reading.measuredAt,
        value: reading.valueMgDl,
        title: `${formatDateTime(reading.measuredAt)}: ${reading.valueMgDl} mg/dL`
      })), latestGlucose, (metric) => metric?.valueMgDl, (metric, value) => `${formatDateTime(metric.measuredAt)}: ${Math.round(value)} mg/dL`)
    },
    {
      key: "heart-rate",
      title: "HR",
      unit: "bpm",
      empty: "Waiting for Health Connect heart rate.",
      currentLabel: currentLabels["heart-rate"],
      currentStamp: currentStamps["heart-rate"],
      yFloor: 45,
      yCeil: 120,
      ticks: [50, 70, 90, 110, 130],
      points: withLatest([...(healthTrends.heartRate || [])].map((metric) => ({
        measuredAt: metric.measuredAt,
        value: metric.value,
        title: `${formatDateTime(metric.measuredAt)}: ${metric.value} bpm`
      })), latest.heartRate, (metric) => metric?.value, (metric, value) => `${formatDateTime(metric.measuredAt)}: ${Math.round(value)} bpm`)
    },
    {
      key: "hrv",
      title: "HRV",
      unit: "ms",
      empty: "Waiting for enough sleep/rest HR samples.",
      currentLabel: currentLabels.hrv,
      currentStamp: currentStamps.hrv,
      yFloor: 0,
      yCeil: 100,
      ticks: [0, 25, 50, 75, 100],
      points: withLatest([...(healthTrends.hrv || [])].map((metric) => ({
        measuredAt: metric.measuredAt,
        value: metric.value,
        title: `${formatDateTime(metric.measuredAt)}: ${formatHrvMetric(metric)} (${hrvDetailLabel(metric)})`
      })), latest.hrv, (metric) => metric?.value, (metric) => `${formatDateTime(metric.measuredAt)}: ${formatHrvMetric(metric)} (${hrvDetailLabel(metric)})`)
    },
    {
      key: "sleep",
      title: "Sleep",
      unit: "h",
      empty: "Waiting for Health Connect sleep.",
      currentLabel: currentLabels.sleep,
      currentStamp: currentStamps.sleep,
      yFloor: 0,
      yCeil: 10,
      ticks: [0, 2, 4, 6, 8, 10],
      points: withLatest([...(healthTrends.sleep || [])].map((metric) => {
        const value = Number(metric.value) / 60;
        return {
          measuredAt: metric.measuredAt,
          value,
          title: `${formatDateTime(metric.measuredAt)}: ${value.toFixed(1)}h asleep`
        };
      }), latest.sleep, (metric) => Number(metric.asleepMinutes ?? metric.value) / 60, (metric, value) => `${formatDateTime(metric.measuredAt)}: ${value.toFixed(1)}h asleep`)
    },
    {
      key: "steps",
      title: "Steps",
      unit: "steps",
      empty: "Waiting for Health Connect steps.",
      currentLabel: currentLabels.steps,
      currentStamp: currentStamps.steps,
      yFloor: 0,
      yCeil: 20000,
      ticks: [0, 5000, 10000, 15000, 20000],
      points: withLatest([...(healthTrends.steps || [])].map((metric) => ({
        measuredAt: metric.measuredAt,
        value: metric.value,
        title: `${formatDateTime(metric.measuredAt)}: ${formatNumber(metric.value)} steps`
      })), latest.steps, (metric) => metric?.value, (metric, value) => `${formatDateTime(metric.measuredAt)}: ${formatNumber(value)} steps`)
    }
  ].map((series) => ({
    ...series,
    points: series.points
      .filter((point) => point.measuredAt && Number.isFinite(Number(point.value)))
      .sort((a, b) => pointPlotTime(a) - pointPlotTime(b) || (timeMs(a.measuredAt) ?? 0) - (timeMs(b.measuredAt) ?? 0))
  }));
}

function filterSeriesPoints(points) {
  if (activeRange === "all") return points;
  const days = Number.parseInt(activeRange, 10);
  const cutoff = days === 1 ? Date.now() - 24 * 60 * 60 * 1000 : daysAgo(days);
  return points.filter((point) => pointPlotTime(point) >= cutoff);
}

function formatAxisValue(value, unit) {
  if (unit === "steps") return formatNumber(value);
  if (unit === "h") return Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1);
  return Math.round(value);
}

function renderAllCharts(data) {
  const builtSeries = buildSeries(data);
  const timeWindow = selectedTimeWindow(builtSeries);
  const seriesList = builtSeries.map((series) => {
    const visiblePoints = visibleSeriesPoints(series.points, timeWindow);
    return {
      ...series,
      visiblePoints,
      linePoints: lineSeriesPoints(series.points, visiblePoints, timeWindow, series.key)
    };
  });
  const allPoints = seriesList.flatMap((series) => series.visiblePoints);
  if (!allPoints.length) {
    renderBoundary(
      "No graph data reached Blood.",
      "Install or update Blood Bridge, grant Bluetooth and Health Connect metrics, then tap Start automatic upload once."
    );
    if (rangeSummary) rangeSummary.textContent = "No data";
    if (rangeDetail) rangeDetail.textContent = "Selected range.";
    return;
  }

  const glucosePoints = seriesList.find((series) => series.key === "glucose")?.visiblePoints || [];
  if (glucosePoints.length) {
    const values = glucosePoints.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    if (rangeSummary) rangeSummary.textContent = `${min}-${max}`;
    if (rangeDetail) rangeDetail.textContent = `${glucosePoints.length} readings, ${avg} mg/dL avg.`;
  } else {
    if (rangeSummary) rangeSummary.textContent = "No glucose";
    if (rangeDetail) rangeDetail.textContent = "Health metrics only.";
  }

  const narrow = window.innerWidth <= 760;
  const width = narrow ? 620 : 980;
  const height = narrow ? 176 : 188;
  const pad = narrow
    ? { top: 34, right: 70, bottom: 42, left: 54 }
    : { top: 34, right: 82, bottom: 44, left: 62 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const times = allPoints.map(pointPlotTime);
  const minTime = timeWindow?.min ?? Math.min(...times);
  const maxTime = timeWindow?.max ?? Math.max(...times);
  const timeDomain = Math.max(1, maxTime - minTime);
  const xFor = (time) => pad.left + ((time - minTime) / timeDomain) * plotWidth;
  const xTickTimes = [minTime, minTime + timeDomain / 2, maxTime]
    .filter((time, index, list) => list.findIndex((item) => Math.round(item) === Math.round(time)) === index);

  charts.innerHTML = seriesList.map((series) => {
    const points = series.visiblePoints;
    const linePoints = series.linePoints || points;
    const valuePoints = linePoints.length ? linePoints : points;
    const values = valuePoints.map((point) => Number(point.value));
    const minValue = Math.min(series.yFloor, ...values) - (series.key === "steps" ? 0 : series.key === "sleep" ? 0 : 5);
    const maxValue = Math.max(series.yCeil, ...values) + (series.key === "steps" ? 0 : series.key === "sleep" ? 0 : 5);
    const valueDomain = Math.max(1, maxValue - minValue);
    const yFor = (value) => pad.top + plotHeight - ((value - minValue) / valueDomain) * plotHeight;
    const line = linePoints
      .map((point, index) => {
        const command = index === 0 ? "M" : "L";
        return `${command} ${xFor(pointPlotTime(point)).toFixed(1)} ${yFor(point.value).toFixed(1)}`;
      })
      .join(" ");
    const area = linePoints.length > 1
      ? `${line} L ${xFor(pointPlotTime(linePoints[linePoints.length - 1])).toFixed(1)} ${yFor(minValue).toFixed(1)} L ${xFor(pointPlotTime(linePoints[0])).toFixed(1)} ${yFor(minValue).toFixed(1)} Z`
      : "";
    const ticks = series.ticks
      .filter((value) => value >= minValue && value <= maxValue)
      .map((value) => {
        const y = yFor(value);
        return `
          <g class="gridline">
            <line x1="${pad.left}" x2="${pad.left + plotWidth}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>
            <text x="${pad.left - 10}" y="${(y + 4).toFixed(1)}">${formatAxisValue(value, series.unit)}</text>
          </g>
        `;
      })
      .join("");
    const xTicks = xTickTimes
      .map((time) => {
        const x = xFor(time);
        return `
          <g class="x-tick">
            <line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.top + plotHeight}" y2="${pad.top + plotHeight + 6}"></line>
            <text x="${x.toFixed(1)}" y="${height - 16}">${formatShortDate(time)}</text>
          </g>
        `;
      })
      .join("");
    const circles = points
      .map((point) => {
        const x = xFor(pointPlotTime(point));
        const y = yFor(point.value);
        return `
          <circle class="point ${series.key}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${points.length > 90 ? 2.4 : 3.8}">
            <title>${point.title}</title>
          </circle>
        `;
      })
      .join("");
    const latest = points[points.length - 1];
    const latestLabel = series.currentLabel || (latest
      ? `${formatAxisValue(latest.value, series.unit)} ${series.unit}`
      : series.empty);
    const band = series.reference
      ? `<rect class="reference-band" x="${pad.left}" y="${Math.min(yFor(series.reference[0]), yFor(series.reference[1])).toFixed(1)}" width="${plotWidth}" height="${Math.abs(yFor(series.reference[0]) - yFor(series.reference[1])).toFixed(1)}"></rect>`
      : "";
    const clipId = `clip-${series.key}-${activeRange}`;
    const pathMarkup = points.length || linePoints.length > 1
      ? `
        ${area ? `<path class="trend-area ${series.key}" d="${area}" clip-path="url(#${clipId})"></path>` : ""}
        ${linePoints.length > 1 ? `<path class="trend-line ${series.key}" d="${line}" clip-path="url(#${clipId})"></path>` : ""}
        ${circles}
      `
      : `<text class="empty-series" x="${pad.left}" y="${pad.top + plotHeight / 2}">${series.empty}</text>`;

    return `
      <section class="chart-panel" aria-label="${series.title} graph">
        <div class="chart-panel-head">
          <strong>${series.title}</strong>
          <span class="chart-current">
            <b>${latestLabel}</b>
            ${series.currentStamp ? `<small>${series.currentStamp}</small>` : ""}
          </span>
        </div>
        <svg viewBox="0 0 ${width} ${height}" class="metric-chart" aria-hidden="true">
          <defs>
            <clipPath id="${clipId}">
              <rect x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${plotHeight}"></rect>
            </clipPath>
          </defs>
          <rect class="plot-bg" x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${plotHeight}"></rect>
          ${band}
          ${ticks}
          ${xTicks}
          ${pathMarkup}
          <text class="axis-label" x="${pad.left}" y="20">${series.unit}</text>
        </svg>
      </section>
    `;
  }).join("");
}

function renderTable(data) {
  const rows = [...(data?.readings || [])].slice(0, 14);
  const ignored = Number(data?.ignoredCount || 0);
  recordCount.textContent = `${data?.recordCount || 0} reading${data?.recordCount === 1 ? "" : "s"}${ignored ? `, ${ignored} disregarded` : ""}`;
  if (!rows.length) {
    readingsBody.innerHTML = `<tr><td colspan="5">No readings reached Blood.</td></tr>`;
    return;
  }
  readingsBody.innerHTML = rows.map((reading) => `
    <tr>
      <td>${escapeHtml(formatDateTime(reading.measuredAt))}</td>
      <td><strong>${escapeHtml(reading.valueMgDl)}</strong></td>
      <td>${escapeHtml(markerLabel(reading) || "")}</td>
      <td>${escapeHtml(sourceLabel(reading, true))}</td>
      <td>
        <button class="disregard-button" type="button" data-disregard-id="${escapeHtml(reading.readingId)}" data-disregard-label="${escapeHtml(`${reading.valueMgDl} mg/dL at ${formatDateTime(reading.measuredAt)}`)}">Disregard</button>
      </td>
    </tr>
  `).join("");
}

function setMetricValue(element, value) {
  if (!element) return;
  element.textContent = value || "Waiting";
  element.classList.toggle("is-waiting", !value);
}

function plainSentence(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function capitalizedCopy(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const LEGACY_ROLE_READ_PATTERN = new RegExp(
  [
    "Good ",
    "sign:\\s*(.*?)\\.\\s*",
    "Biggest ",
    "watchout:\\s*(.*?)\\.\\s*",
    "Best ",
    "move:\\s*(.*)$"
  ].join(""),
  "i"
);

function normalizeLegacyRoleHealthRead(value) {
  const text = String(value || "").trim();
  const legacy = text.match(LEGACY_ROLE_READ_PATTERN);
  if (!legacy) return text;
  const good = capitalizedCopy(plainSentence(legacy[1]));
  const watch = String(legacy[2] || "").replace(/\.$/, "").trim();
  const action = capitalizedCopy(plainSentence(legacy[3]));
  return `${action} ${capitalizedCopy(watch)}, and food, fluid, and easy movement give your body a steadier input. ${good}`;
}

function healthReadText(data) {
  const patterns = data?.patterns || {};
  const prediction = patterns.prediction || null;
  const condition = data?.health?.anxiety?.condition || {};
  const conditionText = condition.summary || patterns.simpleDetail || prediction?.simpleDetail || "Blood is waiting for enough current glucose, HR, HRV trend, sleep, and step data to make a useful read.";
  return plainSentence(normalizeLegacyRoleHealthRead(conditionText));
}

function renderHealthReadText(element, text) {
  if (!element) return;
  element.textContent = text || "";
}

function renderHealth(data) {
  const health = data?.health || {};
  const latest = health.latest || {};
  const anxiety = health.anxiety || {};
  const glucose = latest.glucose || data?.latest || null;
  const heartRate = latest.heartRate || null;
  const hrv = latest.hrv || null;
  const sleep = latest.sleep || null;
  const steps = latest.steps || null;
  const asleepMinutes = sleep?.asleepMinutes ?? sleep?.value;
  const stepCount = steps?.value;

  if (anxietyScore) {
    anxietyScore.classList.remove("is-loading");
    anxietyScore.textContent = formatScore10(anxiety.score);
  }
  if (freshnessLine) {
    freshnessLine.textContent = sourceFreshnessText(data);
  }
  if (healthRead) {
    renderHealthReadText(healthRead, healthReadText(data));
  }

  setMetricValue(metricGlucose, glucose?.valueMgDl ? `${glucose.valueMgDl} mg/dL` : "");
  setMetricValue(metricHr, heartRate?.value ? `${heartRate.value} bpm` : "");
  setMetricValue(metricHrv, formatHrvMetric(hrv));
  setMetricValue(metricSleep, asleepMinutes != null && Number.isFinite(Number(asleepMinutes)) ? formatHours(asleepMinutes) : "");
  setMetricValue(metricSteps, stepCount != null && Number.isFinite(Number(stepCount)) ? `${formatNumber(stepCount)} steps` : "");

}

function renderData(data) {
  latestData = data;
  renderHealth(data);
  if (!data?.latest) {
    currentReadings?.classList.add("is-boundary");
    if (latestValue) latestValue.textContent = "No data";
    if (latestUnit) latestUnit.textContent = "";
    latestTime.textContent = "No readings yet.";
    latestSource.textContent = "No upload from CONTOUR meter bridge.";
    if (rangeSummary) rangeSummary.textContent = "No data";
    if (rangeDetail) rangeDetail.textContent = "Selected range.";
    syncLine.textContent = data?.message || "No readings have reached Blood. Waiting for the automatic CONTOUR meter bridge upload.";
    renderAllCharts(data);
    renderTable(data);
    return;
  }

  const latest = data.latest;
  currentReadings?.classList.remove("is-boundary");
  if (latestValue) latestValue.textContent = latest.valueMgDl;
  if (latestUnit) latestUnit.textContent = "mg/dL";
  latestTime.textContent = currentReadingsTime(data) ? formatDateTime(currentReadingsTime(data)) : "Current readings";
  latestSource.textContent = currentReadingsSourceText(data);
  syncLine.textContent = [
    data.lastCapturedAt ? `Glucose upload ${formatDateTime(data.lastCapturedAt)}.` : "Glucose upload time missing.",
    data.health?.lastCapturedAt ? `Health upload ${formatDateTime(data.health.lastCapturedAt)}.` : "Health upload waiting."
  ].join(" ");
  renderAllCharts(data);
  renderTable(data);
}

function setRefreshState(label, busy = false) {
  refreshButton.textContent = label;
  refreshButton.disabled = busy;
  refreshButton.toggleAttribute("aria-busy", busy);
}

async function loadSummary(manual = false) {
  if (manual) setRefreshState("Refreshing", true);
  try {
    const response = await fetch(`${API_BASE}/api/blood/summary`, { cache: "no-store" });
    if (!response.ok) throw new Error(`summary ${response.status}`);
    renderData(await response.json());
    if (manual) {
      setRefreshState("Updated", false);
      window.setTimeout(() => setRefreshState("Refresh", false), 900);
    }
  } catch (error) {
    syncLine.textContent = "Blood API unavailable.";
    renderBoundary("API unavailable.", error.message || "The graphs could not load.");
    if (manual) setRefreshState("Failed", false);
  }
}

rangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeRange = button.dataset.range;
    rangeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    if (latestData) renderAllCharts(latestData);
  });
});

refreshButton.addEventListener("click", () => loadSummary(true));

fillEditKeyInput(storedEditKey() || DEFAULT_EDIT_KEY);
fillWriteTokenInputs(storedWriteToken());
manageTokenInput?.addEventListener("input", () => {
  rememberEditKey(manageTokenInput.value.trim() || DEFAULT_EDIT_KEY);
});
[manualTokenInput, csvTokenInput].forEach((input) => {
  input?.addEventListener("input", () => {
    const token = input.value.trim();
    if (!token) return;
    [manualTokenInput, csvTokenInput].forEach((peer) => {
      if (peer && peer !== input && !peer.value) peer.value = token;
    });
  });
});

readingsBody?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-disregard-id]");
  if (!button) return;
  const readingId = button.dataset.disregardId || "";
  const label = button.dataset.disregardLabel || "this glucose reading";
  const token = currentEditKey();
  if (!token) {
    setManageState("Edit key required to disregard a reading.");
    manageTokenInput?.focus();
    return;
  }
  if (!window.confirm(`Disregard ${label}? This removes it from the graphs, current reading, anxiety score, and patterns.`)) {
    return;
  }

  setManageState("Disregarding reading.", true);
  try {
    const response = await fetch(`${API_BASE}/api/blood/readings/${encodeURIComponent(readingId)}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ reason: "user_disregarded" })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `delete ${response.status}`);
    }
    rememberEditKey(token);
    fillEditKeyInput(token);
    setManageState("Reading disregarded.");
    await loadSummary(true);
  } catch (error) {
    setManageState(`Disregard failed: ${error.message || "not accepted"}.`);
  } finally {
    readingsBody?.querySelectorAll("[data-disregard-id]").forEach((item) => {
      item.disabled = false;
      item.removeAttribute("aria-busy");
    });
  }
});

function setCsvState(message, busy = false) {
  if (!csvStatus || !csvSubmit) return;
  csvStatus.textContent = message;
  csvSubmit.disabled = busy;
  csvSubmit.toggleAttribute("aria-busy", busy);
}

function localDateTimeValue(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function setManualState(message, busy = false) {
  if (!manualStatus || !manualSubmit) return;
  manualStatus.textContent = message;
  manualSubmit.disabled = busy;
  manualSubmit.toggleAttribute("aria-busy", busy);
}

if (manualTimeInput) {
  manualTimeInput.value = localDateTimeValue();
}

manualEntryForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = Number.parseInt(manualValueInput?.value || "", 10);
  const measuredAtValue = manualTimeInput?.value || "";
  const token = manualTokenInput?.value.trim();
  if (!Number.isFinite(value) || value < 20 || value > 600) {
    setManualState("Enter a glucose value in mg/dL.");
    return;
  }
  if (!measuredAtValue) {
    setManualState("Measurement time required.");
    return;
  }
  if (!token) {
    setManualState("Fallback key required.");
    return;
  }

  const measuredAt = new Date(measuredAtValue).toISOString();
  const relationToMeal = manualMarkerInput?.value || "";
  setManualState("Adding reading.", true);
  try {
    const response = await fetch(`${API_BASE}/api/ingest/glucose-readings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: "manual-entry",
        capturedAt: new Date().toISOString(),
        readings: [
          {
            measuredAt,
            valueMgDl: value,
            relationToMeal,
            specimenSource: "capillary_blood"
          }
        ]
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `entry ${response.status}`);
    }
    rememberWriteToken(token);
    fillWriteTokenInputs(token);
    setManualState(`Added ${value} mg/dL.`);
    manualValueInput.value = "";
    if (manualTimeInput) manualTimeInput.value = localDateTimeValue();
    loadSummary(true);
  } catch (error) {
    setManualState(`Entry failed: ${error.message || "not accepted"}.`);
  } finally {
    if (manualSubmit) manualSubmit.disabled = false;
    manualSubmit?.removeAttribute("aria-busy");
  }
});

csvImportForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = csvFileInput?.files?.[0];
  const token = csvTokenInput?.value.trim();
  if (!file) {
    setCsvState("Choose a Contour CSV file.");
    return;
  }
  if (!token) {
    setCsvState("Fallback key required.");
    return;
  }

  setCsvState("Importing CSV.", true);
  try {
    const csvText = await file.text();
    const response = await fetch(`${API_BASE}/api/ingest/contour-csv`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "text/csv"
      },
      body: csvText
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `import ${response.status}`);
    }
    rememberWriteToken(token);
    fillWriteTokenInputs(token);
    setCsvState(`Imported ${result.accepted || 0} reading${result.accepted === 1 ? "" : "s"}.`);
    csvImportForm.reset();
    loadSummary(true);
  } catch (error) {
    setCsvState(`Import failed: ${error.message || "CSV not accepted"}.`);
  } finally {
    if (csvSubmit) csvSubmit.disabled = false;
    csvSubmit?.removeAttribute("aria-busy");
  }
});

loadSummary(false);
pollTimer = window.setInterval(() => loadSummary(false), POLL_MS);
window.addEventListener("beforeunload", () => window.clearInterval(pollTimer));
