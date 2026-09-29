// ============================================================
// CampusOS — Agent Layer
// All Gemini calls go through /api/* on the Flask backend.
// The API key never touches the browser.
// ============================================================

const BASE = "http://localhost:5500";

async function agentPost(endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status} from ${endpoint}`);
  }
  return res.json();
}

// ── AGENT 1: Intake ──────────────────────────────────────────
// Classify complaint → { category, urgency, title, reasoning }
async function intakeAgent(complaintText) {
  return agentPost("/api/intake", { text: complaintText });
}

// ── AGENT 2: Routing ─────────────────────────────────────────
// Decide department + handler → { department, handler, reasoning, avgCloseHours }
async function routingAgent(intakeResult, ticketHistory) {
  return agentPost("/api/route", {
    intake: intakeResult,
    history: ticketHistory,
  });
}

// ── AGENT 3: Escalation ──────────────────────────────────────
// Returns escalation target (no LLM needed — deterministic chain)
async function escalationAgent(ticket, escalationLevelMap) {
  return agentPost("/api/escalate", {
    ticketId: ticket.id,
    currentLevel: escalationLevelMap[ticket.id] || 0,
  });
}

// ── AGENT 4: Insight ─────────────────────────────────────────
// Weekly digest → { headline, body, tags }
async function insightAgent(allTickets) {
  return agentPost("/api/insight", { tickets: allTickets });
}

export { intakeAgent, routingAgent, escalationAgent, insightAgent };
