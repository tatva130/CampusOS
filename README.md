# CampusOS
### Autonomous Grievance & Accountability System for Institutional Campuses

> **Hackathon Track:** Agentic AI  
> **Built at:** RNS Institute of Technology, Bangalore

---

## What it does

CampusOS is a multi-agent system that autonomously manages hostel/campus complaints — end-to-end — without a human babysitting each step.

| Agent | Job | Why it's agentic |
|---|---|---|
| **Intake Agent** | Reads complaint, classifies category + urgency | LLM reasoning, not keyword rules |
| **Routing Agent** | Decides which department handles it | Adapts based on resolution history |
| **Escalation Agent** | Auto-escalates if unresolved after SLA | Acts without any human trigger |
| **Insight Agent** | Weekly pattern digest for admins | Proactive, not reactive |

**Flow:** Intake → Classify → Route → Wait → Check → Escalate if unresolved → Aggregate → Report

---

## Tech Stack

| Layer | Tool |
|---|---|
| Frontend | HTML + Vanilla CSS + JS (ES Modules) |
| Backend | Python Flask |
| LLM | Groq API (free tier) |
| State | Browser `localStorage` |
| Key security | `.env` file, never in browser |

---

## Run locally

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/campusos.git
cd campusos
```

### 2. Install dependencies
```bash
py -m pip install flask flask-cors python-dotenv groq
```

### 3. Set up your API key
```bash
copy .env.example .env
```
Open `.env` and replace `your_groq_api_key_here` with your key from [console.groq.com](https://console.groq.com).

### 4. Start the server
```bash
py server.py
```

### 5. Open the dashboard
Navigate to **http://localhost:5500** in Chrome or Edge.

---

## Share with friends (ngrok)

To give anyone a public URL without deploying:

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 5500
```

Copy the `https://xxxx.ngrok-free.app` URL and share it. Anyone can access your running instance.

---

## Project structure

```
campusos/
├── index.html        # Dashboard UI
├── styles.css        # Design system
├── app.js            # UI logic + escalation timer loop
├── agents.js         # Calls backend /api/* endpoints
├── server.py         # Flask backend with all 4 agents
├── .env              # YOUR API KEY (never committed)
├── .env.example      # Safe template (committed)
├── .gitignore        # Blocks .env from git
└── requirements.txt  # Python dependencies
```

---

## Security note

The API key lives **only in `.env`** on the server. It is never sent to the browser. The `.gitignore` blocks `.env` from being committed to GitHub.
