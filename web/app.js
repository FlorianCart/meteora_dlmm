const $ = (id) => document.getElementById(id);

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const tokenColors = ["#0f766e", "#4f46e5", "#0b5cad", "#b45309", "#be123c", "#047857", "#7c3aed"];
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
    { label: "Equity", value: money.format(metrics.equityUsd), delta: pct(metrics.totalPnlPct) },
    { label: "Cash", value: money.format(metrics.cashUsd), delta: "" },
    { label: "Open value", value: money.format(metrics.openValueUsd), delta: `${metrics.openPositions} open` },
    { label: "Realized", value: signedMoney(metrics.realizedPnlUsd), delta: "" },
    { label: "Total PnL", value: signedMoney(metrics.totalPnlUsd), delta: pct(metrics.totalPnlPct) },
    { label: "Win rate", value: `${num.format(metrics.winRatePct)}%`, delta: `${metrics.closedPositions} closed` }
  ];

  $("metrics").innerHTML = items.map(metricHtml).join("");
}

function renderLive(live) {
  const activePositions = live.positions.filter((p) => p.status === "OPEN" || p.status === "EXITING");
  const cooldownMs = live.outOfRangeUpCooldownMs ?? 300000;
  const ranges = activePositions.map((position) => liveRangeInfo(position, cooldownMs));
  const outOfRange = ranges.filter((range) => range.state === "above" || range.state === "below");
  const above = ranges.filter((range) => range.state === "above");
  const nextExit = above
    .slice()
    .sort((a, b) => a.remainingMs - b.remainingMs)[0];

  $("liveUpdated").textContent = live.updatedAt ? `Updated ${relative(live.updatedAt)}` : "No live snapshots";
  $("autoReopenState").textContent = live.autoReopenAfterExit ? "Auto-reopen ON" : "Auto-reopen OFF";
  $("autoReopenState").className = `mini-pill ${live.autoReopenAfterExit ? "good" : "warn"}`;

  const rangeMetricClass = outOfRange.length > 0 ? "risk" : "";
  const pnlClass = live.profitUsd < 0 ? "loss" : "";
  const items = [
    { label: "Active", value: String(live.activeCount), delta: `${live.closedCount} closed` },
    { label: "Net current", value: money.format(live.currentValueUsd), delta: `Entry ${money.format(live.entryValueUsd)}` },
    { label: "Liquidity", value: money.format(live.liquidityValueUsd ?? 0), delta: "excludes fees" },
    { label: "Live PnL", value: signedMoney(live.profitUsd), delta: pct(live.profitPct), className: pnlClass },
    { label: "Fees", value: money.format(live.feeValueUsd), delta: feeYield(live.feeValueUsd, live.entryValueUsd) },
    {
      label: "Range risk",
      value: outOfRange.length ? `${outOfRange.length} alert` : "Clear",
      delta: nextExit ? `Exit in ${durationLabel(nextExit.remainingMs)}` : `${activePositions.length} watched`,
      className: rangeMetricClass
    }
  ];

  $("liveMetrics").innerHTML = items.map(metricHtml).join("");
  renderRangeWatch(activePositions, ranges, cooldownMs);
  renderLiveExposure(live, activePositions, ranges);
  renderLivePositions(live.positions, cooldownMs);
}

function renderRangeWatch(activePositions, ranges, cooldownMs) {
  const riskCount = ranges.filter((range) => range.state === "above" || range.state === "below").length;
  $("rangeWatchCount").textContent = riskCount > 0 ? `${riskCount} alert` : `${activePositions.length} watched`;

  if (activePositions.length === 0) {
    $("rangeAlerts").innerHTML = `<div class="empty">No live positions tracked</div>`;
    return;
  }

  $("rangeAlerts").innerHTML = activePositions
    .map((position, index) => {
      const info = ranges[index] ?? liveRangeInfo(position, cooldownMs);
      const poolName = poolLabel(position);
      const color = tokenColor(poolName);
      return `
        <div class="range-row ${info.state === "above" ? "alert" : ""}" style="--token-color:${color}">
          <div class="range-main">
            <div class="range-title">
              <span class="token-dot" style="background:${color}; box-shadow:0 0 0 4px ${softColor(color)}"></span>
              <span>${escapeHtml(poolName)}</span>
              <span class="tag ${info.className}">${escapeHtml(info.label)}</span>
            </div>
            <div class="range-sub">${escapeHtml(info.detail)}</div>
          </div>
          <div class="cooldown">
            <div class="cooldown-label">
              <span>${escapeHtml(info.elapsedText)}</span>
              <span>${escapeHtml(info.progressText)}</span>
            </div>
            <div class="cooldown-track">
              <span class="cooldown-fill" style="--cooldown:${info.progressPct}%"></span>
            </div>
          </div>
          <div class="range-countdown">
            ${escapeHtml(info.remainingText)}
            <small>${escapeHtml(info.countdownNote)}</small>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderLiveExposure(live, activePositions, ranges) {
  const pnlValues = activePositions.map((position) => {
    const snapshot = position.lastSnapshot;
    if (snapshot) return snapshot.profitPct;
    const fallbackProfitUsd = (snapshot?.currentValueUsd ?? position.entryValueUsd) - position.entryValueUsd;
    return position.entryValueUsd > 0 ? (fallbackProfitUsd / position.entryValueUsd) * 100 : 0;
  });
  const avgPnl = pnlValues.length > 0 ? pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length : 0;
  const feesPct = live.entryValueUsd > 0 ? (live.feeValueUsd / live.entryValueUsd) * 100 : 0;
  const worstDistance = ranges.reduce((max, range) => Math.max(max, Math.abs(range.distanceBins)), 0);
  const snapshotCount = activePositions.filter((position) => position.lastSnapshot).length;

  $("liveExposureState").textContent = `${snapshotCount}/${activePositions.length} snapshots`;
  $("liveExposure").innerHTML = [
    { label: "Entry capital", value: money.format(live.entryValueUsd), note: `${activePositions.length} active positions` },
    { label: "Net current", value: money.format(live.currentValueUsd), note: signedMoney(live.profitUsd) },
    { label: "Liquidity only", value: money.format(live.liquidityValueUsd ?? 0), note: "before unclaimed fees" },
    { label: "Fee yield", value: pct(feesPct), note: money.format(live.feeValueUsd) },
    { label: "Avg PnL", value: pct(avgPnl), note: `${num.format(worstDistance)} bins max distance` },
    { label: "Cooldown", value: durationLabel(live.outOfRangeUpCooldownMs ?? 300000), note: "out-of-range up" }
  ]
    .map(
      (item) => `
        <div class="exposure-item">
          <div class="exposure-label">${escapeHtml(item.label)}</div>
          <div class="exposure-value ${valueClass(item.value)}">${escapeHtml(item.value)}</div>
          <div class="exposure-note">${escapeHtml(item.note)}</div>
        </div>
      `
    )
    .join("");
}

function renderLivePositions(positions, cooldownMs) {
  $("livePositionCount").textContent = `${positions.filter((p) => p.status === "OPEN" || p.status === "EXITING").length} active`;
  $("livePositions").innerHTML =
    positions
      .slice()
      .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
      .map((position) => {
        const snapshot = position.lastSnapshot;
        const currentValue = snapshot?.currentValueUsd ?? position.entryValueUsd;
        const liquidityValue = snapshot?.liquidityValueUsd ?? currentValue - (snapshot?.feeValueUsd ?? 0);
        const fees = snapshot?.feeValueUsd ?? 0;
        const profitUsd = snapshot?.profitUsd ?? currentValue - position.entryValueUsd;
        const profitPct = snapshot?.profitPct ?? (position.entryValueUsd > 0 ? (profitUsd / position.entryValueUsd) * 100 : 0);
        const range = liveRangeInfo(position, cooldownMs);
        const valuationSource = snapshot?.valuationSource ?? "legacy";
        return `
          <tr>
            <td title="${position.poolAddress}">${escapeHtml(poolLabel(position))}</td>
            <td><span class="tag ${liveStatusClass(position.status)}">${escapeHtml(position.status)}</span></td>
            <td class="num">${money.format(position.entryValueUsd)}</td>
            <td class="num">${money.format(liquidityValue)}</td>
            <td class="num">${money.format(currentValue)}</td>
            <td class="num">${money.format(fees)}</td>
            <td class="num ${profitUsd >= 0 ? "positive" : "negative"}">${signedMoney(profitUsd)} / ${pct(profitPct)}</td>
            <td class="num">${pct(position.takeProfitPct)} / ${pct(position.stopLossPct)}</td>
            <td class="num">${position.lowerBinId} -> ${position.upperBinId}</td>
            <td title="${escapeHtml(range.detail)}">${rangeCellHtml(range)}</td>
            <td><span class="tag info">${escapeHtml(valuationSource)}</span></td>
            <td>${relative(position.openedAt)}</td>
            <td title="${position.positionAddress}" class="address">${shortAddress(position.positionAddress)}</td>
          </tr>
        `;
      })
      .join("") || `<tr><td class="empty" colspan="13">No live positions tracked</td></tr>`;
}

function rangeCellHtml(range) {
  return `
    <div class="range-cell">
      <span class="tag ${range.className}">${escapeHtml(range.shortLabel)}</span>
      <span class="mini-range">
        <span class="mini-marker ${range.state === "above" || range.state === "below" ? "warn" : ""}" style="--marker:${range.markerPct}%"></span>
      </span>
    </div>
  `;
}

function liveRangeInfo(position, cooldownMs) {
  const activeBinId = position.lastSnapshot?.activeBinId;
  const lower = position.lowerBinId;
  const upper = position.upperBinId;
  const span = Math.max(1, upper - lower);

  if (position.status === "CLOSED") {
    const markerPct = Number.isFinite(activeBinId) ? clamp(((activeBinId - lower) / span) * 100, 0, 100) : 50;
    return {
      state: "closed",
      className: "info",
      label: "Closed",
      shortLabel: "Closed",
      detail: position.exitReason ? `Closed by ${position.exitReason}` : "Closed position",
      elapsedText: position.closedAt ? `Closed ${relative(position.closedAt)}` : "Closed",
      progressText: "100%",
      remainingText: "--",
      countdownNote: "inactive",
      progressPct: 100,
      remainingMs: 0,
      distanceBins: 0,
      markerPct
    };
  }

  if (!Number.isFinite(activeBinId)) {
    return {
      state: "pending",
      className: "",
      label: "No snapshot",
      shortLabel: "--",
      detail: `Range ${lower} -> ${upper}`,
      elapsedText: "Waiting",
      progressText: "0%",
      remainingText: "--",
      countdownNote: "no snapshot",
      progressPct: 0,
      remainingMs: cooldownMs,
      distanceBins: 0,
      markerPct: 50
    };
  }

  if (activeBinId > upper) {
    const elapsedMs = position.outOfRangeSince ? elapsedMsSince(position.outOfRangeSince) : 0;
    const remainingMs = Math.max(0, cooldownMs - elapsedMs);
    const progressPct = cooldownMs > 0 ? clamp((elapsedMs / cooldownMs) * 100, 0, 100) : 100;
    const distance = activeBinId - upper;
    return {
      state: "above",
      className: "warn",
      label: `Above ${durationLabel(elapsedMs)}`,
      shortLabel: `Above ${durationLabel(elapsedMs)}`,
      detail: `Active bin ${activeBinId}, upper ${upper}, distance +${distance} bins`,
      elapsedText: `Out since ${durationLabel(elapsedMs)}`,
      progressText: `${num.format(progressPct)}%`,
      remainingText: durationLabel(remainingMs),
      countdownNote: remainingMs > 0 ? "before exit" : "exit ready",
      progressPct,
      remainingMs,
      distanceBins: distance,
      markerPct: 100
    };
  }

  if (activeBinId < lower) {
    const distance = lower - activeBinId;
    return {
      state: "below",
      className: "warn",
      label: "Below range",
      shortLabel: "Below",
      detail: `Active bin ${activeBinId}, lower ${lower}, distance -${distance} bins`,
      elapsedText: "No up-exit",
      progressText: "0%",
      remainingText: "--",
      countdownNote: "below range",
      progressPct: 0,
      remainingMs: cooldownMs,
      distanceBins: -distance,
      markerPct: 0
    };
  }

  const markerPct = clamp(((activeBinId - lower) / span) * 100, 0, 100);
  return {
    state: "inside",
    className: "good",
    label: `In range ${activeBinId}`,
    shortLabel: `In ${activeBinId}`,
    detail: `Active bin ${activeBinId}, range ${lower} -> ${upper}`,
    elapsedText: "Inside range",
    progressText: "0%",
    remainingText: "OK",
    countdownNote: `${num.format(markerPct)}% across range`,
    progressPct: 0,
    remainingMs: cooldownMs,
    distanceBins: 0,
    markerPct
  };
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

  const pad = { left: 58, right: 18, top: 18, bottom: 34 };
  const w = rect.width - pad.left - pad.right;
  const h = rect.height - pad.top - pad.bottom;
  drawGrid(ctx, rect, pad, w, h);

  if (!history.length) {
    drawCentered(ctx, rect, "No equity samples");
    return;
  }

  const values = history.map((point) => point.equityUsd);
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
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#0f766e";
  ctx.stroke();

  ctx.fillStyle = "#63717d";
  ctx.font = "12px system-ui";
  ctx.fillText(money.format(max), 8, pad.top + 4);
  ctx.fillText(money.format(min), 8, pad.top + h);
}

function drawGrid(ctx, rect, pad, w, h) {
  ctx.strokeStyle = "#e2e9ed";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#cfdae0";
  ctx.strokeRect(pad.left, pad.top, w, h);
}

function drawCentered(ctx, rect, text) {
  ctx.fillStyle = "#63717d";
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
            <span class="tag ${eventClass(event.type)}">${escapeHtml(event.type)}</span>
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
        (position) => `
          <tr>
            <td title="${position.poolAddress}">${escapeHtml(position.poolName)}</td>
            <td><span class="tag ${position.status === "OPEN" ? "good" : "warn"}">${escapeHtml(position.status)}</span></td>
            <td class="num">${money.format(position.notionalUsd)}</td>
            <td class="num">${money.format(position.currentValueUsd)}</td>
            <td class="num">${money.format(position.feesAccruedUsd)}</td>
            <td class="num ${position.pnlUsd >= 0 ? "positive" : "negative"}">${signedMoney(position.pnlUsd)} / ${pct(position.pnlPct)}</td>
            <td class="num">${escapeHtml(position.jupiterScoresAtEntry)}</td>
            <td>${relative(position.openedAt)}</td>
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
      .map((candidate) => {
        const pool = candidate.pool;
        const jup = candidate.jupiter.map((token) => token.organicScore?.toFixed(0) ?? "na").join("/");
        const ageH = (Date.now() - pool.created_at) / 3600000;
        return `
          <tr>
            <td title="${pool.address}">${escapeHtml(pool.name)}</td>
            <td class="num">${num.format(candidate.score)}</td>
            <td class="num">${num.format(ageH)}h</td>
            <td class="num">${money.format(pool.tvl)}</td>
            <td class="num">${compact.format(pool.volume["30m"])}</td>
            <td class="num">${num.format(pool.fee_tvl_ratio["30m"])}%</td>
            <td class="num">${num.format(pool.fee_tvl_ratio["1h"])}%</td>
            <td class="num">${num.format(pool.fee_tvl_ratio["24h"])}%</td>
            <td class="num">${escapeHtml(jup)}</td>
            <td title="${escapeHtml(candidate.reasons.join("; "))}">
              <span class="tag ${candidate.eligible ? "good" : "bad"}">${candidate.eligible ? "PASS" : "REJECT"}</span>
            </td>
          </tr>
        `;
      })
      .join("") || `<tr><td class="empty" colspan="10">No scan yet</td></tr>`;
}

function metricHtml(item) {
  return `
    <div class="metric ${item.className ?? ""}">
      <div class="label">${escapeHtml(item.label)}</div>
      <div class="value ${valueClass(item.value)}">${escapeHtml(item.value)}</div>
      <div class="delta">${escapeHtml(item.delta)}</div>
    </div>
  `;
}

function eventClass(type) {
  if (type === "OPEN") return "good";
  if (type === "CLOSE") return "warn";
  if (type === "ERROR") return "bad";
  return "info";
}

function liveStatusClass(status) {
  if (status === "OPEN") return "good";
  if (status === "EXITING") return "warn";
  if (status === "ERROR") return "bad";
  if (status === "CLOSED") return "info";
  return "";
}

function poolLabel(position) {
  return `${position.tokenX.symbol}-${position.tokenY.symbol}`;
}

function feeYield(feeValueUsd, entryValueUsd) {
  if (entryValueUsd <= 0) return "0% yield";
  return `${pct((feeValueUsd / entryValueUsd) * 100)} yield`;
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
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function elapsedMsSince(iso) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Date.now() - parsed);
}

function durationLabel(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function tokenColor(value) {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return tokenColors[hash % tokenColors.length];
}

function softColor(color) {
  return `${color}24`;
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
