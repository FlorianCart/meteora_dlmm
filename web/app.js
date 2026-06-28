const $ = (id) => document.getElementById(id);

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

let latestStatus = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

async function refresh() {
  const [paper, live] = await Promise.all([api("/api/status"), api("/api/live/status")]);
  latestStatus = { paper, live };
  render(latestStatus);
}

function render(status) {
  renderHeader(status.paper);
  renderLive(status.live);
  renderMetrics(status.paper.metrics);
  renderEquity(status.paper.state.equityHistory);
  renderEvents(status.paper.state.events);
  renderPositions(status.paper.state.positions);
  renderCandidates(status.paper.lastScan);
}

function renderHeader(status) {
  const pill = $("runState");
  pill.textContent = status.running ? "Running" : "Stopped";
  pill.className = `status-pill ${status.running ? "running" : "stopped"}`;
  $("busyState").textContent = status.busy ? "Busy" : "Ready";
  $("lastTick").textContent = status.lastTickAt ? relative(status.lastTickAt) : "--";
}

function renderMetrics(metrics) {
  const items = [
    ["Equity", money.format(metrics.equityUsd), pct(metrics.totalPnlPct)],
    ["Cash", money.format(metrics.cashUsd), ""],
    ["Open Value", money.format(metrics.openValueUsd), `${metrics.openPositions} open`],
    ["Realized", money.format(metrics.realizedPnlUsd), ""],
    ["Total PnL", signedMoney(metrics.totalPnlUsd), pct(metrics.totalPnlPct)],
    ["Win Rate", `${num.format(metrics.winRatePct)}%`, `${metrics.closedPositions} closed`]
  ];

  $("metrics").innerHTML = items
    .map(
      ([label, value, delta]) => `
        <div class="metric">
          <div class="label">${label}</div>
          <div class="value ${valueClass(value)}">${value}</div>
          <div class="delta">${delta}</div>
        </div>
      `
    )
    .join("");
}

function renderLive(live) {
  $("liveUpdated").textContent = live.updatedAt ? `Updated ${relative(live.updatedAt)}` : "No live snapshots";
  const items = [
    ["Active", String(live.activeCount), `${live.closedCount} closed`],
    ["Entry", money.format(live.entryValueUsd), ""],
    ["Current", money.format(live.currentValueUsd), ""],
    ["Fees", money.format(live.feeValueUsd), ""],
    ["Live PnL", signedMoney(live.profitUsd), pct(live.profitPct)]
  ];

  $("liveMetrics").innerHTML = items
    .map(
      ([label, value, delta]) => `
        <div class="metric live-metric">
          <div class="label">${label}</div>
          <div class="value ${valueClass(value)}">${value}</div>
          <div class="delta">${delta}</div>
        </div>
      `
    )
    .join("");

  $("livePositionCount").textContent = `${live.activeCount} active`;
  $("livePositions").innerHTML =
    live.positions
      .slice()
      .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
      .map((p) => {
        const snapshot = p.lastSnapshot;
        const currentValue = snapshot?.currentValueUsd ?? p.entryValueUsd;
        const fees = snapshot?.feeValueUsd ?? 0;
        const profitUsd = snapshot?.profitUsd ?? currentValue - p.entryValueUsd;
        const profitPct = snapshot?.profitPct ?? (p.entryValueUsd > 0 ? (profitUsd / p.entryValueUsd) * 100 : 0);
        const poolName = `${p.tokenX.symbol}-${p.tokenY.symbol}`;
        const range = liveRangeStatus(p);
        return `
          <tr>
            <td title="${p.poolAddress}">${escapeHtml(poolName)}</td>
            <td><span class="tag ${liveStatusClass(p.status)}">${p.status}</span></td>
            <td class="num">${money.format(p.entryValueUsd)}</td>
            <td class="num">${money.format(currentValue)}</td>
            <td class="num">${money.format(fees)}</td>
            <td class="num ${profitUsd >= 0 ? "positive" : "negative"}">${signedMoney(profitUsd)} / ${pct(profitPct)}</td>
            <td class="num">${pct(p.takeProfitPct)} / ${pct(p.stopLossPct)}</td>
            <td class="num">${p.lowerBinId} -> ${p.upperBinId}</td>
            <td title="${escapeHtml(range.title)}"><span class="tag ${range.className}">${escapeHtml(range.label)}</span></td>
            <td title="${p.positionAddress}">${shortAddress(p.positionAddress)}</td>
          </tr>
        `;
      })
      .join("") || `<tr><td class="empty" colspan="10">No live positions tracked</td></tr>`;
}

function renderEquity(history) {
  const canvas = $("equityChart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const pad = { left: 54, right: 18, top: 18, bottom: 34 };
  const w = rect.width - pad.left - pad.right;
  const h = rect.height - pad.top - pad.bottom;
  drawGrid(ctx, rect, pad, w, h);

  if (!history.length) {
    drawCentered(ctx, rect, "No equity samples");
    return;
  }

  const values = history.map((p) => p.equityUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);

  ctx.beginPath();
  history.forEach((point, index) => {
    const x = pad.left + (history.length === 1 ? 0 : (index / (history.length - 1)) * w);
    const y = pad.top + h - ((point.equityUsd - min) / span) * h;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#0b5cad";
  ctx.stroke();

  ctx.fillStyle = "#66737d";
  ctx.font = "12px system-ui";
  ctx.fillText(money.format(max), 8, pad.top + 4);
  ctx.fillText(money.format(min), 8, pad.top + h);
}

function drawGrid(ctx, rect, pad, w, h) {
  ctx.strokeStyle = "#e6ebef";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#dbe2e6";
  ctx.strokeRect(pad.left, pad.top, w, h);
}

function drawCentered(ctx, rect, text) {
  ctx.fillStyle = "#66737d";
  ctx.font = "13px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(text, rect.width / 2, rect.height / 2);
  ctx.textAlign = "left";
}

function renderEvents(events) {
  $("events").innerHTML =
    events
      .slice(0, 30)
      .map(
        (event) => `
          <div class="event">
            <span class="event-time">${time(event.at)}</span>
            <span class="tag ${eventClass(event.type)}">${event.type}</span>
            <span>${escapeHtml(event.message)}</span>
          </div>
        `
      )
      .join("") || `<div class="empty">No events</div>`;
}

function renderPositions(positions) {
  $("positionCount").textContent = `${positions.filter((p) => p.status === "OPEN").length} open`;
  $("positions").innerHTML =
    positions
      .slice()
      .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
      .map(
        (p) => `
          <tr>
            <td title="${p.poolAddress}">${escapeHtml(p.poolName)}</td>
            <td><span class="tag ${p.status === "OPEN" ? "good" : "warn"}">${p.status}</span></td>
            <td class="num">${money.format(p.notionalUsd)}</td>
            <td class="num">${money.format(p.currentValueUsd)}</td>
            <td class="num">${money.format(p.feesAccruedUsd)}</td>
            <td class="num ${p.pnlUsd >= 0 ? "positive" : "negative"}">${signedMoney(p.pnlUsd)} / ${pct(p.pnlPct)}</td>
            <td class="num">${p.jupiterScoresAtEntry}</td>
            <td>${relative(p.openedAt)}</td>
          </tr>
        `
      )
      .join("") || `<tr><td class="empty" colspan="8">No positions</td></tr>`;
}

function renderCandidates(candidates) {
  $("scanCount").textContent = `${candidates.length} scanned`;
  $("candidates").innerHTML =
    candidates
      .slice(0, 40)
      .map((c) => {
        const p = c.pool;
        const jup = c.jupiter.map((token) => token.organicScore?.toFixed(0) ?? "na").join("/");
        const ageH = (Date.now() - p.created_at) / 3600000;
        return `
          <tr>
            <td title="${p.address}">${escapeHtml(p.name)}</td>
            <td class="num">${num.format(c.score)}</td>
            <td class="num">${num.format(ageH)}h</td>
            <td class="num">${money.format(p.tvl)}</td>
            <td class="num">${compact.format(p.volume["30m"])}</td>
            <td class="num">${num.format(p.fee_tvl_ratio["30m"])}%</td>
            <td class="num">${num.format(p.fee_tvl_ratio["1h"])}%</td>
            <td class="num">${num.format(p.fee_tvl_ratio["24h"])}%</td>
            <td class="num">${jup}</td>
            <td title="${escapeHtml(c.reasons.join("; "))}">
              <span class="tag ${c.eligible ? "good" : "bad"}">${c.eligible ? "PASS" : "REJECT"}</span>
            </td>
          </tr>
        `;
      })
      .join("") || `<tr><td class="empty" colspan="10">No scan yet</td></tr>`;
}

function eventClass(type) {
  if (type === "OPEN") return "good";
  if (type === "CLOSE") return "warn";
  if (type === "ERROR") return "bad";
  return "";
}

function liveStatusClass(status) {
  if (status === "OPEN") return "good";
  if (status === "EXITING") return "warn";
  if (status === "ERROR") return "bad";
  return "";
}

function liveRangeStatus(position) {
  const activeBinId = position.lastSnapshot?.activeBinId;
  if (typeof activeBinId !== "number") {
    return { label: "--", className: "", title: "No active bin snapshot yet" };
  }

  if (activeBinId > position.upperBinId) {
    const elapsed = position.outOfRangeSince ? elapsedLabel(position.outOfRangeSince) : "0s";
    return {
      label: `Above ${elapsed}`,
      className: "warn",
      title: `Active bin ${activeBinId} is above upper bin ${position.upperBinId}`
    };
  }

  if (activeBinId < position.lowerBinId) {
    return {
      label: "Below",
      className: "warn",
      title: `Active bin ${activeBinId} is below lower bin ${position.lowerBinId}`
    };
  }

  return {
    label: `In ${activeBinId}`,
    className: "good",
    title: `Active bin ${activeBinId} is inside ${position.lowerBinId} -> ${position.upperBinId}`
  };
}

function valueClass(value) {
  return String(value).startsWith("-") ? "negative" : "";
}

function signedMoney(value) {
  return `${value >= 0 ? "+" : ""}${money.format(value)}`;
}

function pct(value) {
  return `${value >= 0 ? "+" : ""}${num.format(value)}%`;
}

function time(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function relative(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function elapsedLabel(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortAddress(value) {
  const text = String(value);
  if (text.length <= 12) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function action(path, body) {
  try {
    const options = { method: "POST" };
    if (body !== undefined) options.body = JSON.stringify(body);
    await api(path, options);
    await refresh();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
}

$("startBtn").addEventListener("click", () => action("/api/bot/start"));
$("stopBtn").addEventListener("click", () => action("/api/bot/stop"));
$("tickBtn").addEventListener("click", () => action("/api/bot/tick"));
$("resetBtn").addEventListener("click", () => {
  if (confirm("Reset paper state?")) action("/api/paper/reset");
});

window.addEventListener("resize", () => latestStatus && renderEquity(latestStatus.paper.state.equityHistory));
refresh().catch(console.error);
setInterval(refresh, 3000);
