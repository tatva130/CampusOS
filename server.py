"""
CampusOS -- Flask Backend Server
API key lives in .env only -- never exposed to the browser.
Uses Groq (free tier, fast inference) with llama-3.3-70b-versatile.

Endpoints:
  GET  /api/health   -> key configured check
  POST /api/intake   -> classify complaint
  POST /api/route    -> decide department + handler
  POST /api/escalate -> escalation chain (no LLM needed)
  POST /api/insight  -> weekly digest
"""

import os
import json
import re
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from groq import Groq

# -- Load .env -------------------------------------------------------
load_dotenv()
API_KEY = os.getenv("GROQ_API_KEY", "")

if not API_KEY:
    print("\n  WARNING: GROQ_API_KEY not set in .env")
    print("   Get a free key at https://console.groq.com\n")

client = Groq(api_key=API_KEY)
MODEL  = "openai/gpt-oss-120b"   # confirmed working on this Groq account

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)


# -- Helpers ---------------------------------------------------------
def call_llm(prompt: str) -> str:
    """Send a prompt to Groq and return the text response."""
    completion = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=800,
    )
    return completion.choices[0].message.content


def safe_parse_json(text: str) -> dict:
    """Strip markdown code fences then parse JSON."""
    cleaned = re.sub(r"```json\s*", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"```\s*", "", cleaned)
    return json.loads(cleaned.strip())


def api_error(message: str, status: int = 500):
    return jsonify({"error": message}), status


# -- Serve frontend --------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(".", "index.html")


# -- Health check ----------------------------------------------------
@app.route("/api/health")
def health():
    key_ok = bool(API_KEY)
    return jsonify({"status": "ok", "groq_key_set": key_ok})


# -- AGENT 1: Intake -------------------------------------------------
@app.route("/api/intake", methods=["POST"])
def intake():
    data = request.get_json(silent=True) or {}
    complaint_text = (data.get("text") or "").strip()
    if not complaint_text:
        return api_error("complaint text is required", 400)

    prompt = f"""You are the Intake Agent for CampusOS, an autonomous grievance management system for a college hostel campus.

Your job: read a raw complaint from a resident and output a structured classification.

Categories (pick exactly one):
- electrical   (power cuts, sparks, faulty wiring, switches, fans, AC)
- plumbing     (water supply, leaks, blocked drains, washroom issues)
- mess         (food quality, hygiene, late meals, missing items)
- wifi         (internet down, slow connectivity, router issues)
- timetable    (class clashes, room conflicts, schedule errors)
- safety       (security, emergency, theft, harassment)
- other        (anything that does not fit above)

Urgency levels:
- critical  (safety risk, emergency -- act within 1 hour)
- high      (significant impact on daily life -- act within 4 hours)
- medium    (notable but manageable -- act within 24 hours)
- low       (minor inconvenience -- act within 72 hours)

Instructions:
- Use LLM reasoning, NOT keyword matching. "plug sparked" -> electrical + critical even without the word "electrical".
- Generate a short, clear title (max 8 words).
- Write a one-sentence reasoning explaining your classification.

Complaint: "{complaint_text}"

Respond ONLY with valid JSON. No markdown fences, no extra text, no explanation outside the JSON object:
{{
  "category": "<one of the categories>",
  "urgency": "<one of the urgency levels>",
  "title": "<short title>",
  "reasoning": "<one sentence>"
}}"""

    try:
        raw = call_llm(prompt)
        result = safe_parse_json(raw)
        return jsonify(result)
    except json.JSONDecodeError:
        return api_error(f"LLM returned non-JSON: {raw[:300]}")
    except Exception as e:
        return api_error(str(e))


# -- AGENT 2: Routing ------------------------------------------------
@app.route("/api/route", methods=["POST"])
def route():
    data = request.get_json(silent=True) or {}
    intake_result  = data.get("intake", {})
    ticket_history = data.get("history", [])

    departments = {
        "electrical": {"name": "Hostel Maintenance", "handlers": ["Ramesh Kumar",    "Suresh Nair"]},
        "plumbing":   {"name": "Hostel Maintenance", "handlers": ["Ramesh Kumar",    "Priya Sharma"]},
        "mess":       {"name": "Mess Committee",     "handlers": ["Anita Desai",     "Vikram Iyer"]},
        "wifi":       {"name": "IT & Networking",    "handlers": ["Arjun Mehta",     "Sneha Patel"]},
        "timetable":  {"name": "Academic Office",    "handlers": ["Dr. Kavitha Rao", "Prof. Sunil Bhat"]},
        "safety":     {"name": "Warden Office",      "handlers": ["Kavya Reddy",     "Security Head"]},
        "other":      {"name": "Warden Office",      "handlers": ["Kavya Reddy",     "Admin Staff"]},
    }
    category = intake_result.get("category", "other")
    dept = departments.get(category, departments["other"])

    relevant = [
        t for t in ticket_history
        if t.get("category") == category and t.get("handler")
    ][-10:]
    history_lines = "\n".join(
        f"  handler: {t['handler']}, resolvedIn: {t.get('resolvedIn', 'unresolved')}h"
        for t in relevant
    ) or "  No prior history -- first ticket of this category."

    prompt = f"""You are the Routing Agent for CampusOS. Decide which handler within the assigned department should own this ticket.

New ticket:
  Category: {intake_result.get("category")}
  Urgency:  {intake_result.get("urgency")}
  Title:    {intake_result.get("title")}

Department: {dept["name"]}
Available handlers: {", ".join(dept["handlers"])}

Recent history for this category:
{history_lines}

Instructions:
- Pick the handler who has historically resolved this category fastest. If no history, pick any.
- Write one sentence of routing reasoning.
- Estimate average close time in hours (use a sensible default if no history).

Respond ONLY with valid JSON. No markdown fences, no extra text:
{{
  "department": "{dept["name"]}",
  "handler": "<handler name>",
  "reasoning": "<one sentence>",
  "avgCloseHours": <number>
}}"""

    try:
        raw = call_llm(prompt)
        result = safe_parse_json(raw)
        return jsonify(result)
    except json.JSONDecodeError:
        return api_error(f"LLM returned non-JSON: {raw[:300]}")
    except Exception as e:
        return api_error(str(e))


# -- AGENT 3: Escalation (deterministic, no LLM needed) -------------
@app.route("/api/escalate", methods=["POST"])
def escalate():
    data = request.get_json(silent=True) or {}
    current_level = int(data.get("currentLevel", 0))

    escalation_chain = [
        {"to": "Warden Office",      "contact": "Kavya Reddy"},
        {"to": "Dean of Students",   "contact": "Dr. Ramesh Acharya"},
        {"to": "Principal's Office", "contact": "Dr. Meena Joshi"},
    ]
    idx  = min(current_level, len(escalation_chain) - 1)
    step = escalation_chain[idx]

    return jsonify({
        "escalateTo": step["to"],
        "contact":    step["contact"],
        "newLevel":   min(current_level + 1, len(escalation_chain) - 1),
        "message":    (
            f"Auto-escalated to {step['to']} ({step['contact']}) "
            f"-- SLA breached with no resolution."
        ),
    })


# -- AGENT 4: Insight ------------------------------------------------
@app.route("/api/insight", methods=["POST"])
def insight():
    data = request.get_json(silent=True) or {}
    all_tickets = data.get("tickets", [])

    if not all_tickets:
        return jsonify({
            "headline": "No complaints filed yet",
            "body": "No ticket data available. File some complaints to see the weekly insight digest.",
            "tags": [],
        })

    summary = [
        {
            "id":         t.get("id"),
            "category":   t.get("category"),
            "urgency":    t.get("urgency"),
            "status":     t.get("status"),
            "location":   t.get("location", "unknown"),
            "escalated":  t.get("escalated", False),
            "resolvedIn": t.get("resolvedIn"),
        }
        for t in all_tickets
    ]

    prompt = f"""You are the Insight Agent for CampusOS. Analyze this campus complaint history and write a proactive weekly digest for administrators.

Ticket data:
{json.dumps(summary, indent=2)}

Your job:
1. Identify the most recurring complaint category or location pattern.
2. Flag any SLA breaches or escalated tickets.
3. Recommend one concrete action for administration.
4. Generate 3-6 short uppercase tags (e.g. "WIFI COMPLAINTS x4") for display.

Max 120 words for body. Professional but direct tone.

Respond ONLY with valid JSON. No markdown fences, no extra text:
{{
  "headline": "<bold finding in 10 words max>",
  "body": "<digest paragraph, max 120 words>",
  "tags": ["TAG xN", ...]
}}"""

    try:
        raw = call_llm(prompt)
        result = safe_parse_json(raw)
        return jsonify(result)
    except json.JSONDecodeError:
        return api_error(f"LLM returned non-JSON: {raw[:300]}")
    except Exception as e:
        return api_error(str(e))


if __name__ == "__main__":
    print("\n  CampusOS backend -> http://localhost:5500")
    print(f"  LLM: Groq / {MODEL}")
    print(f"  Key set: {'YES' if API_KEY else 'NO -- check .env'}\n")
    app.run(host="0.0.0.0", port=5500, debug=True)
