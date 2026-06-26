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
  if (reading.source === "contour-csv") return "Contour CSV";
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
      "Waiting for readings.",
      "No readings exist in the selected range."
    );
    rangeSummary.textContent = "No data";
    rangeDetail.textContent = "Selected range.";
    return;
  }

  const narrow = window.innerWidth <= 760;
  const width = narrow ? 620 : 920;
  const height = narrow ? 420 : 430;
  const pad = narrow
    ? { top: 34, right: 32, bottom: 50, left: 46 }
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
        <text x="${Math.min(width - 92, latestX + 13).toFixed(1)}" y="${(latestY - 10).toFixed(1)}">${latest.valueMgDl}</text>
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
    readingsBody.innerHTML = `<tr><td colspan="4">No readings loaded.</td></tr>`;
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
    latestSource.textContent = "Waiting for Contour data.";
    rangeSummary.textContent = "No data";
    rangeDetail.textContent = "Selected range.";
    syncLine.textContent = data?.message || "Contour readings sync here after the bridge or CSV import sends data.";
    renderBoundary(
      "No readings synced.",
      "The graph will fill after the phone bridge reads Health Connect glucose records or a Contour CSV export is imported."
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

loadSummary(false);
pollTimer = window.setInterval(() => loadSummary(false), POLL_MS);
window.addEventListener("beforeunload", () => window.clearInterval(pollTimer));
