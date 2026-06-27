const syncLine = document.getElementById("sync-line");
const refreshButton = document.getElementById("refresh-button");
const latestValue = document.getElementById("latest-value");
const latestUnit = document.getElementById("latest-unit");
const latestTime = document.getElementById("latest-time");
const latestSource = document.getElementById("latest-source");
const rangeSummary = document.getElementById("range-summary");
const rangeDetail = document.getElementById("range-detail");
const chart = document.getElementById("chart");
const latestStrip = document.querySelector(".latest-strip");
const readingsBody = document.getElementById("readings-body");
const recordCount = document.getElementById("record-count");
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

const LIVE_API_BASE = "https://blood.aolabs.io";
const configuredApiBase = document.querySelector("meta[name='blood-api-base']")?.content || "";
const API_BASE = (configuredApiBase || (location.hostname === "aolabs.io" ? LIVE_API_BASE : "")).replace(/\/$/, "");
const POLL_MS = 30 * 1000;

let latestData = null;
let activeRange = "7";
let pollTimer = 0;

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

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daysAgo(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

function sourceLabel(reading) {
  if (!reading) return "";
  if (reading.source === "contour-meter-ble") return "CONTOUR meter bridge";
  if (reading.source === "contour-csv") return "Contour CSV";
  if (reading.source === "manual-entry") return "Manual entry";
  if (reading.source === "health-connect") {
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

function renderBoundary(message, detail = "") {
  chart.innerHTML = `
    <div class="chart-boundary" role="status">
      <strong>${message}</strong>
      <p>${detail}</p>
    </div>
  `;
}

function renderChart(data) {
  const points = filteredTrend(data);
  if (!points.length) {
    renderBoundary(
      "No readings reached Blood.",
      "Install or update Blood Bridge, grant Bluetooth, tap Start automatic upload once, and keep the upload notification running."
    );
    rangeSummary.textContent = "No data";
    rangeDetail.textContent = "Selected range.";
    return;
  }

  const narrow = window.innerWidth <= 760;
  const width = narrow ? 560 : 920;
  const height = narrow ? 420 : 430;
  const pad = narrow
    ? { top: 34, right: 70, bottom: 50, left: 46 }
    : { top: 30, right: 54, bottom: 54, left: 56 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const times = points.map((reading) => new Date(reading.measuredAt).getTime());
  const values = points.map((reading) => reading.valueMgDl);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(60, ...values) - 10;
  const maxValue = Math.max(200, ...values) + 10;
  const domain = Math.max(1, maxTime - minTime);
  const valueDomain = Math.max(1, maxValue - minValue);
  const xFor = (time) => pad.left + ((time - minTime) / domain) * plotWidth;
  const yFor = (value) => pad.top + plotHeight - ((value - minValue) / valueDomain) * plotHeight;
  const line = points
    .map((reading, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command} ${xFor(new Date(reading.measuredAt).getTime()).toFixed(1)} ${yFor(reading.valueMgDl).toFixed(1)}`;
    })
    .join(" ");
  const area = `${line} L ${xFor(maxTime).toFixed(1)} ${yFor(minValue).toFixed(1)} L ${xFor(minTime).toFixed(1)} ${yFor(minValue).toFixed(1)} Z`;
  const ticks = [60, 100, 140, 180, 220]
    .filter((value) => value >= minValue && value <= maxValue)
    .map((value) => {
      const y = yFor(value);
      return `
        <g class="gridline">
          <line x1="${pad.left}" x2="${pad.left + plotWidth}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>
          <text x="${pad.left - 12}" y="${(y + 4).toFixed(1)}">${value}</text>
        </g>
      `;
    })
    .join("");
  const xTicks = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]
    .filter(Boolean)
    .filter((reading, index, arr) => arr.findIndex((item) => item.measuredAt === reading.measuredAt) === index)
    .map((reading) => {
      const x = xFor(new Date(reading.measuredAt).getTime());
      return `
        <g class="x-tick">
          <line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.top + plotHeight}" y2="${pad.top + plotHeight + 7}"></line>
          <text x="${x.toFixed(1)}" y="${height - 18}">${formatShortDate(reading.measuredAt)}</text>
        </g>
      `;
    })
    .join("");
  const circles = points
    .map((reading) => {
      const x = xFor(new Date(reading.measuredAt).getTime());
      const y = yFor(reading.valueMgDl);
      return `
        <circle class="point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.8">
          <title>${formatDateTime(reading.measuredAt)}: ${reading.valueMgDl} mg/dL</title>
        </circle>
      `;
    })
    .join("");
  const latest = points[points.length - 1];
  const latestX = xFor(new Date(latest.measuredAt).getTime());
  const latestY = yFor(latest.valueMgDl);
  const latestLabelOnLeft = latestX > width - (narrow ? 120 : 132);
  const latestLabelX = latestLabelOnLeft ? latestX - 14 : latestX + 13;
  const latestLabelAnchor = latestLabelOnLeft ? "end" : "start";
  const bandTop = Math.min(yFor(180), yFor(70));
  const bandBottom = Math.max(yFor(180), yFor(70));

  chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="glucose-chart" aria-hidden="true">
      <rect class="plot-bg" x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${plotHeight}"></rect>
      <rect class="reference-band" x="${pad.left}" y="${bandTop.toFixed(1)}" width="${plotWidth}" height="${(bandBottom - bandTop).toFixed(1)}"></rect>
      ${ticks}
      ${xTicks}
      <path class="trend-area" d="${area}"></path>
      <path class="trend-line" d="${line}"></path>
      ${circles}
      <g class="latest-marker">
        <circle cx="${latestX.toFixed(1)}" cy="${latestY.toFixed(1)}" r="8"></circle>
        <text x="${latestLabelX.toFixed(1)}" y="${(latestY - 10).toFixed(1)}" text-anchor="${latestLabelAnchor}">${latest.valueMgDl}</text>
      </g>
      <text class="axis-label" x="${pad.left}" y="18">blood glucose</text>
    </svg>
  `;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  rangeSummary.textContent = `${min}-${max}`;
  rangeDetail.textContent = `${points.length} readings, ${avg} mg/dL avg.`;
}

function renderTable(data) {
  const rows = [...(data?.readings || [])].slice(0, 14);
  recordCount.textContent = `${data?.recordCount || 0} reading${data?.recordCount === 1 ? "" : "s"}`;
  if (!rows.length) {
    readingsBody.innerHTML = `<tr><td colspan="4">No readings reached Blood.</td></tr>`;
    return;
  }
  readingsBody.innerHTML = rows.map((reading) => `
    <tr>
      <td>${formatDateTime(reading.measuredAt)}</td>
      <td><strong>${reading.valueMgDl}</strong></td>
      <td>${markerLabel(reading) || ""}</td>
      <td>${sourceLabel(reading)}</td>
    </tr>
  `).join("");
}

function renderData(data) {
  latestData = data;
  if (!data?.latest) {
    latestStrip.classList.add("is-boundary");
    latestValue.textContent = "No data";
    latestUnit.textContent = "";
    latestTime.textContent = "No readings yet.";
    latestSource.textContent = "No upload from CONTOUR meter bridge.";
    rangeSummary.textContent = "No data";
    rangeDetail.textContent = "Selected range.";
    syncLine.textContent = data?.message || "No readings have reached Blood. Waiting for the automatic CONTOUR meter bridge upload.";
    renderBoundary(
      "No readings reached Blood.",
      "The phone bridge now runs an always-on CONTOUR NEXT ONE Bluetooth upload service. Manual entry and CSV import are fallback only."
    );
    renderTable(data);
    return;
  }

  const latest = data.latest;
  latestStrip.classList.remove("is-boundary");
  latestValue.textContent = latest.valueMgDl;
  latestUnit.textContent = "mg/dL";
  latestTime.textContent = formatDateTime(latest.measuredAt);
  latestSource.textContent = sourceLabel(latest);
  syncLine.textContent = data.lastCapturedAt
    ? `Last upload ${formatDateTime(data.lastCapturedAt)}.`
    : "Readings are present; no bridge upload time was stored.";
  renderChart(data);
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
    renderBoundary("API unavailable.", error.message || "The graph could not load.");
    if (manual) setRefreshState("Failed", false);
  }
}

rangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeRange = button.dataset.range;
    rangeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    if (latestData) renderChart(latestData);
  });
});

refreshButton.addEventListener("click", () => loadSummary(true));

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
    setManualState("Bridge token required.");
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
    setCsvState("Bridge token required.");
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
