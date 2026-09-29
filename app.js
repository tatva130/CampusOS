// ============================================================
// CampusOS — App Logic (state, UI, escalation loop)
// API key is on the backend — this file is key-free.
// ============================================================
import {
  intakeAgent,
  routingAgent,
  escalationAgent,
  insightAgent,
} from "./agents.js";

// ── STATE ────────────────────────────────────────────────────
let tickets = [];
let agentLog = [];
let escalationLevels = {};     // ticketId → escalation level
let ticketCounter = 100;
let SLA_SECONDS = 30;          // demo: 30s; production: 86400s (24h)
let escalationTimers = {};     // ticketId → interval id
let insightCache = null;

// ── STORAGE ──────────────────────────────────────────────────
function loadFromStorage() {
  try {
    const t = localStorage.getItem("campusOS_tickets");
    if (t) tickets = JSON.parse(t);
    const l = localStorage.getItem("campusOS_log");
    if (l) agentLog = JSON.parse(l);
    const lv = localStorage.getItem("campusOS_levels");
    if (lv) escalationLevels = JSON.parse(lv);
    const c = localStorage.getItem("campusOS_counter");
    if (c) ticketCounter = parseInt(c, 10);
  } catch (_) {}
}

function saveToStorage() {
  localStorage.setItem("campusOS_tickets", JSON.stringify(tickets));
  localStorage.setItem("campusOS_log", JSON.stringify(agentLog));
  localStorage.setItem("campusOS_levels", JSON.stringify(escalationLevels));
  localStorage.setItem("campusOS_counter", String(ticketCounter));
}

// ── HELPERS ──────────────────────────────────────────────────
function generateId() {
  ticketCounter++;
  return `CMP-${(ticketCounter * 7 + 100000).toString().slice(-6)}`;
}

function ageSeconds(ticket) {
  return Math.floor((Date.now() - ticket.createdAt) / 1000);
}

function timeAgoLabel(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// ── TOAST NOTIFICATIONS ──────────────────────────────────────
function showToast(message, type = "info") {
  const existing = document.getElementById("toast-container");
  const container = existing || (() => {
    const el = document.createElement("div");
    el.id = "toast-container";
    document.body.appendChild(el);
    return el;
  })();

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add("toast-show"), 10);
  setTimeout(() => {
    toast.classList.remove("toast-show");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── AGENT LOG ────────────────────────────────────────────────
function pushLog(type, ticketId, text) {
  agentLog.unshift({ type, ticketId, text, ts: Date.now() });
  if (agentLog.length > 100) agentLog.pop();
  saveToStorage();
  renderLog();
}

// ── ESCALATION LOOP ──────────────────────────────────────────
// Runs independently — no human trigger needed
function startEscalationTimer(ticket) {
  if (escalationTimers[ticket.id]) return;
  escalationTimers[ticket.id] = setInterval(async () => {
    const live = tickets.find((t) => t.id === ticket.id);
    if (!live || live.status === "resolved") {
      clearInterval(escalationTimers[ticket.id]);
      delete escalationTimers[ticket.id];
      return;
    }

    const age = ageSeconds(live);
    const sla = live.slaSecs || SLA_SECONDS;
    live.secondsUntilEscalation = Math.max(0, sla - age);
    renderTickets();

    if (age >= sla && !live.escalated) {
      live.escalated = true;
      try {
        const result = await escalationAgent(live, escalationLevels);
        escalationLevels[live.id] = result.newLevel;
        live.status = "escalated";
        live.escalationNote = result.message;
        live.escalatedTo = result.escalateTo;
        saveToStorage();
        pushLog("ESCALATION", live.id, result.message);
        showToast(`🚨 ${live.id} auto-escalated to ${result.escalateTo}`, "error");
        showEscalationBurst(live.id);
      } catch (e) {
        live.escalated = false; // retry next tick
        console.error("Escalation agent error:", e);
      }
      renderTickets();
      renderStats();
    }
  }, 1000);
}

function restartAllTimers() {
  tickets.forEach((t) => {
    if (t.status === "open" || t.status === "escalated") {
      startEscalationTimer(t);
    }
  });
}

// ── FILE COMPLAINT ───────────────────────────────────────────
async function fileComplaint(text, name, location) {
  const id = generateId();
  const ticket = {
    id,
    text,
    name: name || "Anonymous",
    location: location || "Campus",
    status: "open",
    createdAt: Date.now(),
    slaSecs: SLA_SECONDS,
    secondsUntilEscalation: SLA_SECONDS,
    escalated: false,
    source: "web",
  };
  tickets.unshift(ticket);
  saveToStorage();
  renderTickets();
  renderStats();
  pushLog("INTAKE", id, "Complaint received — classifying…");
  showToast(`${id} received — agents processing…`, "info");

  // AGENT 1: Intake classification
  let intake;
  try {
    intake = await intakeAgent(text);
    if (!intake.category) throw new Error("Empty intake response");
  } catch (e) {
    intake = {
      category: "other",
      urgency: "medium",
      title: text.slice(0, 50),
      reasoning: `Intake agent error: ${e.message}`,
    };
    showToast(`⚠ Intake fallback used: ${e.message}`, "warn");
  }
  Object.assign(ticket, intake);
  saveToStorage();
  pushLog("INTAKE", id, `${intake.category} / ${intake.urgency} — ${intake.reasoning}`);
  renderTickets();

  // AGENT 2: Routing decision
  let routing;
  try {
    const history = tickets.filter((t) => t.category === intake.category && t.handler);
    routing = await routingAgent(intake, history);
    if (!routing.department) throw new Error("Empty routing response");
  } catch (e) {
    routing = {
      department: "Warden Office",
      handler: "Admin Staff",
      reasoning: `Routing agent error: ${e.message}`,
      avgCloseHours: 24,
    };
    showToast(`⚠ Routing fallback used: ${e.message}`, "warn");
  }
  Object.assign(ticket, routing);
  saveToStorage();
  pushLog("ROUTING", id, routing.reasoning);
  showToast(`✓ Routed to ${routing.department} → ${routing.handler}`, "success");
  renderTickets();
  renderStats();

  // Start autonomous escalation watcher
  startEscalationTimer(ticket);
  insightCache = null;
  return ticket;
}

// ── RESOLVE ──────────────────────────────────────────────────
function resolveTicket(id) {
  const t = tickets.find((t) => t.id === id);
  if (!t) return;
  t.status = "resolved";
  t.resolvedAt = Date.now();
  t.resolvedIn = parseFloat(((t.resolvedAt - t.createdAt) / 3600000).toFixed(4));
  clearInterval(escalationTimers[id]);
  delete escalationTimers[id];
  saveToStorage();
  pushLog("RESOLVED", id, `Marked resolved in ${Math.round(t.resolvedIn * 3600)}s.`);
  showToast(`✓ ${id} resolved`, "success");
  renderTickets();
  renderStats();
  insightCache = null;
}

// ── INSIGHT DIGEST ───────────────────────────────────────────
async function runInsightDigest() {
  const btn = document.getElementById("btn-digest");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Thinking…';
  try {
    insightCache = await insightAgent(tickets);
    pushLog("INSIGHT", "—", insightCache.headline);
    showToast("📊 Insight digest ready", "success");
  } catch (e) {
    insightCache = { headline: "Error running digest", body: e.message, tags: [] };
    showToast(`⚠ Insight error: ${e.message}`, "error");
  }
  renderInsight();
  btn.disabled = false;
  btn.textContent = "↻ Run digest";
}

// ── ESCALATION BURST ─────────────────────────────────────────
function showEscalationBurst(id) {
  const el = document.getElementById(`ticket-${id}`);
  if (!el) return;
  el.classList.add("escalation-burst");
  setTimeout(() => el.classList.remove("escalation-burst"), 2000);
}

// ── RENDER: STATS ────────────────────────────────────────────
function renderStats() {
  const open = tickets.filter((t) => t.status === "open").length;
  const escalated = tickets.filter((t) => t.status === "escalated").length;
  const resolved = tickets.filter((t) => t.status === "resolved").length;
  const total = tickets.length;
  document.getElementById("stat-open").textContent = open;
  document.getElementById("stat-escalated").textContent = escalated;
  document.getElementById("stat-resolved").textContent = resolved;
  document.getElementById("stat-total").textContent = total;

  const inFlight = open + escalated;
  document.getElementById("in-flight-count").textContent =
    inFlight === 0 ? "All clear" : `${inFlight} in flight`;

  renderScorecard();
}

// ── RENDER: SCORECARD ────────────────────────────────────────
function renderScorecard() {
  const depts = {};
  tickets.forEach((t) => {
    const d = t.department || "Unassigned";
    if (!depts[d]) depts[d] = { total: 0, open: 0, escalated: 0, resolved: 0, totalHours: 0, slaHit: 0 };
    depts[d].total++;
    if (t.status === "open") depts[d].open++;
    else if (t.status === "escalated") { depts[d].open++; depts[d].escalated++; }
    else if (t.status === "resolved") {
      depts[d].resolved++;
      depts[d].totalHours += t.resolvedIn || 0;
      if ((t.resolvedIn || 999) <= (t.avgCloseHours || 24)) depts[d].slaHit++;
    }
  });

  const container = document.getElementById("scorecard-rows");
  if (Object.keys(depts).length === 0) {
    container.innerHTML = `<div class="scorecard-empty">No tickets yet — file a complaint to populate.</div>`;
    return;
  }

  const arr = Object.entries(depts).sort((a, b) => b[1].total - a[1].total);
  const maxAvg = Math.max(...arr.map(([, d]) => d.resolved > 0 ? d.totalHours / d.resolved : 0), 1);

  container.innerHTML = arr.map(([name, d]) => {
    const avg = d.resolved > 0 ? (d.totalHours / d.resolved).toFixed(1) : "—";
    const avgNum = d.resolved > 0 ? d.totalHours / d.resolved : 0;
    const slaPct = d.resolved > 0 ? Math.round((d.slaHit / d.resolved) * 100) : 0;
    const barW = maxAvg > 0 ? Math.round((avgNum / maxAvg) * 100) : 10;
    const barColor = avgNum < 0.01 ? "var(--green)" : avgNum < 0.5 ? "var(--cyan)" : "var(--orange)";
    return `
      <div class="scorecard-row">
        <div class="scorecard-dept-name">${name}</div>
        <div class="scorecard-avg">${avg === "—" ? "—" : avg + "h avg"}</div>
        <div class="scorecard-bar-wrap">
          <div class="scorecard-bar" style="width:${Math.max(barW, 4)}%;background:${barColor}"></div>
        </div>
        <div class="scorecard-meta">
          ${d.total} ticket${d.total !== 1 ? "s" : ""}
          &nbsp;·&nbsp;${d.open} open
          &nbsp;·&nbsp;${d.escalated} escalated
          &nbsp;·&nbsp;SLA hit ${slaPct}%
        </div>
      </div>`;
  }).join("");
}

// ── RENDER: TICKETS ──────────────────────────────────────────
function renderTickets() {
  const open = tickets.filter((t) => t.status !== "resolved");
  const closed = tickets.filter((t) => t.status === "resolved");

  const liveContainer = document.getElementById("live-tickets");
  liveContainer.innerHTML = open.length === 0
    ? `<div class="empty-state">✓ No open tickets — all quiet on campus.</div>`
    : open.map(renderTicketCard).join("");

  const closedContainer = document.getElementById("closed-tickets");
  if (closed.length === 0) {
    closedContainer.innerHTML = "";
  } else {
    closedContainer.innerHTML = `
      <div class="closed-header">RECENTLY CLOSED</div>
      ${closed.slice(0, 8).map((t) => `
        <div class="closed-row">
          <span class="closed-id">${t.id}</span>
          <span class="closed-title">${t.title || t.text.slice(0, 50)}</span>
          <span class="closed-age">${timeAgoLabel(t.resolvedAt)}</span>
        </div>`).join("")}`;
  }
}

function renderTicketCard(t) {
  const isEscalated = t.status === "escalated";
  const secs = t.secondsUntilEscalation ?? (t.slaSecs || SLA_SECONDS);
  const slaPct = Math.max(0, Math.min(100, (secs / (t.slaSecs || SLA_SECONDS)) * 100));
  const slaColor = slaPct > 60 ? "var(--green)" : slaPct > 25 ? "var(--orange)" : "var(--red)";
  const urgClass = `urgency-${t.urgency || "medium"}`;
  const catIcon = { electrical:"⚡", plumbing:"💧", mess:"🍽", wifi:"📶", timetable:"📅", safety:"🚨", other:"📋" }[t.category] || "📋";
  const isProcessing = !t.category; // Still being classified

  return `
    <div class="ticket-card ${isEscalated ? "ticket-escalated" : ""} ${isProcessing ? "ticket-processing" : ""}" id="ticket-${t.id}">
      <div class="ticket-top-row">
        <span class="ticket-id">${t.id}</span>
        <div class="ticket-tags">
          ${isProcessing
            ? `<span class="tag tag-processing">⟳ CLASSIFYING…</span>`
            : `<span class="tag tag-status-open">${isEscalated ? "ESCALATED" : "OPEN"}</span>
               ${t.urgency ? `<span class="tag ${urgClass}">${t.urgency.toUpperCase()}</span>` : ""}
               ${t.category ? `<span class="tag tag-cat">${catIcon} ${t.category.toUpperCase()}</span>` : ""}`}
        </div>
        <span class="ticket-age">${timeAgoLabel(t.createdAt)}</span>
      </div>

      <div class="ticket-title">${t.title || t.text.slice(0, 60)}</div>
      <div class="ticket-quote">"${t.text.slice(0, 100)}${t.text.length > 100 ? "…" : ""}"</div>

      <div class="ticket-meta-row">
        ${t.name ? `<span class="meta-item">👤 ${t.name}</span>` : ""}
        ${t.location ? `<span class="meta-item">📍 ${t.location}</span>` : ""}
        ${t.department ? `<span class="meta-item">🏢 ${t.department}</span>` : ""}
        ${t.handler ? `<span class="meta-item">🙋 ${t.handler}</span>` : ""}
      </div>

      ${(t.reasoning && t.department) ? `
        <div class="ticket-reasoning">
          <div class="reasoning-section">
            <div class="reasoning-label">INTAKE REASONING</div>
            <div>${t.reasoning}</div>
          </div>
          <div class="reasoning-section" style="margin-top:8px">
            <div class="reasoning-label">ROUTING DECISION</div>
            <div>Category "${t.category}" maps to ${t.department}. Handler ${t.handler} picked (avg close ${t.avgCloseHours || "?"}h).</div>
          </div>
        </div>` : ""}

      ${isEscalated ? `
        <div class="escalation-note">🚨 ${t.escalationNote || "Auto-escalated — SLA breached."}</div>` : ""}

      <div class="sla-row">
        <div class="sla-bar-wrap">
          <div class="sla-bar" style="width:${slaPct}%;background:${slaColor}"></div>
        </div>
        ${!isEscalated
          ? `<span class="sla-label">${isProcessing ? "awaiting classification" : secs + "s until auto-escalation"}</span>`
          : `<span class="sla-label escalated-label">Escalated → ${t.escalatedTo || "higher authority"}</span>`}
      </div>

      <div class="ticket-actions">
        <button class="btn-resolve" onclick="window.resolveTicket('${t.id}')">◎ Mark resolved</button>
      </div>
    </div>`;
}

// ── RENDER: LOG ──────────────────────────────────────────────
function renderLog() {
  const container = document.getElementById("agent-log");
  if (agentLog.length === 0) {
    container.innerHTML = `<div class="log-empty">Agent activity will appear here as tickets are processed.</div>`;
    return;
  }
  container.innerHTML = agentLog.slice(0, 20).map((entry) => {
    const typeClass = {
      INTAKE: "log-tag-intake", ROUTING: "log-tag-routing",
      ESCALATION: "log-tag-escalation", RESOLVED: "log-tag-resolved",
      INSIGHT: "log-tag-insight"
    }[entry.type] || "log-tag-intake";
    return `
      <div class="log-entry">
        <span class="log-tag ${typeClass}">${entry.type}</span>
        <span class="log-ticket-id">${entry.ticketId}</span>
        <span class="log-text">${entry.text}</span>
        <span class="log-ts">${timeAgoLabel(entry.ts)}</span>
      </div>`;
  }).join("");
}

// ── RENDER: INSIGHT ──────────────────────────────────────────
function renderInsight() {
  const container = document.getElementById("insight-content");
  if (!insightCache) {
    container.innerHTML = `<div class="insight-placeholder">Click "Run digest" to generate the weekly insight report powered by Gemini (server-side).</div>`;
    return;
  }
  const { headline, body, tags } = insightCache;
  container.innerHTML = `
    <div class="insight-headline">${headline}</div>
    <div class="insight-body">${body}</div>
    <div class="insight-tags">
      ${(tags || []).map((tag) => `<span class="insight-tag">${tag}</span>`).join("")}
    </div>`;
}

// ── EXAMPLE CHIPS ────────────────────────────────────────────
const EXAMPLES = [
  "The plug in my room sparked when I tried to charge my laptop",
  "Dinner dal smelled off again, second time this week",
  "WiFi in Block C keeps dropping every ten minutes",
  "My DBMS lecture and the DSA lab are scheduled in the same room at 2 PM",
  "There's no water supply in Hostel 2 washrooms since morning",
  "Someone broke the lock on the main gate of Block A",
];

// ── HEALTH CHECK ─────────────────────────────────────────────
async function checkBackendHealth() {
  const statusEl = document.getElementById("backend-status");
  try {
    const res = await fetch("http://localhost:5500/api/health");
    const data = await res.json();
    const keyOk = data.groq_key_set || data.gemini_key_set;
    if (keyOk) {
      statusEl.textContent = "Backend connected  ·  Groq key active";
      statusEl.className = "backend-status ok";
    } else {
      statusEl.textContent = "Backend running but API key not set in .env";
      statusEl.className = "backend-status warn";
    }
  } catch (_) {
    statusEl.textContent = "Backend not reachable -- run: py server.py";
    statusEl.className = "backend-status err";
  }
}

// ── INIT ─────────────────────────────────────────────────────
function init() {
  loadFromStorage();
  renderStats();
  renderTickets();
  renderLog();
  renderInsight();
  restartAllTimers();
  checkBackendHealth();

  // SLA toggle
  const slaToggle = document.getElementById("sla-toggle");
  slaToggle?.addEventListener("change", () => {
    SLA_SECONDS = slaToggle.checked ? 30 : 86400;
    document.getElementById("sla-label").textContent =
      slaToggle.checked ? "Demo mode · SLA 30s" : "Production mode · SLA 24h";
  });

  // Complaint form
  const form = document.getElementById("complaint-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = document.getElementById("complaint-text").value.trim();
    const name = document.getElementById("complaint-name").value.trim();
    const location = document.getElementById("complaint-location").value;
    if (!text) {
      showToast("Please describe the issue before filing.", "warn");
      return;
    }
    const btn = document.getElementById("btn-file");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Processing…';
    try {
      await fileComplaint(text, name, location);
      document.getElementById("complaint-text").value = "";
      document.getElementById("complaint-name").value = "";
      document.getElementById("complaint-location").value = "";
    } catch (err) {
      showToast(`Error: ${err.message}`, "error");
      console.error(err);
    }
    btn.disabled = false;
    btn.innerHTML = "⊳ File complaint";
  });

  // Example chips
  const chipsContainer = document.getElementById("example-chips");
  EXAMPLES.forEach((c) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = c.slice(0, 45) + (c.length > 45 ? "…" : "");
    chip.title = c;
    chip.addEventListener("click", () => {
      document.getElementById("complaint-text").value = c;
      document.getElementById("complaint-text").focus();
    });
    chipsContainer.appendChild(chip);
  });

  // Insight digest
  document.getElementById("btn-digest").addEventListener("click", runInsightDigest);

  // Clear all data
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (!confirm("Clear all ticket data? This cannot be undone.")) return;
    Object.values(escalationTimers).forEach(clearInterval);
    escalationTimers = {};
    tickets = [];
    agentLog = [];
    escalationLevels = {};
    ticketCounter = 100;
    insightCache = null;
    saveToStorage();
    renderStats();
    renderTickets();
    renderLog();
    renderInsight();
    showToast("All data cleared", "info");
  });
}

window.resolveTicket = resolveTicket;
document.addEventListener("DOMContentLoaded", init);
