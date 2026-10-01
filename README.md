<div align="center">

# 🇮🇳 JanRakshak

### AI-Assisted Emergency Response & Resource Coordination

**From emergency reports to intelligent, coordinated response — with humans always in control.**

<br>

[🚨 Features](#-key-features) •
[📸 Screenshots](#-project-screenshots) •
[🔄 Workflow](#-main-workflow) •
[🏗️ Architecture](#️-system-architecture) •
[🛠️ Tech Stack](#️-technology-stack) •
[📊 Results](#-prototype-results) •
[📚 Documentation](#-documentation)

</div>

---

## 🚨 Overview

**JanRakshak** is an AI-assisted emergency response platform designed for **Mumbai**.

It processes emergency reports from citizens and response teams, understands the incident, determines its risk, resolves the location, detects duplicate reports, and coordinates available emergency resources.

The system combines **AI, Machine Learning, location intelligence, route optimization, and real-time communication** to support emergency coordinators in making faster and more informed decisions.

> ### 🤝 AI recommends. Humans decide.
>
> Resource dispatch and reassignment require coordinator approval.

---

# 📸 Project Screenshots

### 👤 Citizen Emergency Reporting

Users can submit an emergency report with location and incident details.

![Citizen Emergency Reporting](screenshots/citizen-reporting.png)

### 📍 Citizen Report Tracking

Citizens can track the reported incident, its location, and response progress.

![Citizen Report Tracking](screenshots/report-tracking.png)

### 🖥️ Emergency Command Center

The control room provides a real-time view of incidents, locations, routes, and responding units.

![Emergency Command Center](screenshots/command-center.png)

### 🤖 AI Risk Assessment

The system analyzes the incident and provides a risk score, class probabilities, and extracted evidence.

![AI Risk Assessment](screenshots/ai-risk-assessment.png)

---

# 🎯 Problem

Emergency situations can generate large numbers of reports that may be:

- 🌐 Multilingual
- 📍 Incomplete or location-ambiguous
- 🔁 Duplicate reports of the same incident
- ⚠️ Different in severity
- 🚑 Competing for limited emergency resources

Traditional nearest-resource assignment can therefore lead to inefficient allocation and poor coordination across multiple incidents.

---

# 💡 Key Features

| Feature | Purpose |
|---|---|
| 🗣️ **Multilingual Reporting** | English, Hindi and Marathi emergency reports |
| 🤖 **AI Extraction** | Converts reports into structured incident information |
| 🧠 **XGBoost Risk Assessment** | Classifies incidents as Low, Medium, High or Critical |
| 📍 **Location Resolution** | Resolves landmarks, vague locations and GPS |
| 🔁 **Duplicate Detection** | Identifies reports belonging to the same incident |
| 🚑 **Resource Optimization** | Coordinates emergency resources across incidents |
| 🛣️ **Road-Aware Routing** | Uses real road routes and travel times |
| 🔄 **Dynamic Re-optimization** | Updates recommendations when situations change |
| 👨‍💼 **Human Approval** | Coordinator approves response recommendations |
| 📡 **Real-Time Updates** | Live synchronization using Socket.IO |
| 👥 **Citizen Tracking** | Citizens can report and track emergencies |

---

# 🔄 Main Workflow

```text
👤 Emergency Report
        │
        ▼
🤖 AI Information Extraction
        │
        ▼
📍 Location Resolution
        │
        ▼
🔁 Duplicate Detection
        │
        ▼
🧠 XGBoost Risk Assessment
        │
        ▼
🚑 Resource Requirement
        │
        ▼
🧮 Global Resource Allocation
        │
        ▼
🛣️ Road-Aware Route Calculation
        │
        ▼
👨‍💼 Coordinator Review & Approval
        │
        ▼
🚒 Field Unit Response
        │
        ▼
📡 Live Tracking & Updates
        │
        ▼
🔄 Re-optimization
```

# 🤖 AI + ML

## Gemini AI

Gemini extracts important information from emergency reports, including:

- Incident type
- People affected
- Injuries
- Trapped people
- Vulnerable people
- Emergency requirements
- Urgency indicators
- Location information

If Gemini is unavailable, a **keyword + regex fallback classifier** can continue basic incident processing.

## XGBoost Risk Assessment

Extracted incident evidence is passed to an **XGBoost multiclass model**.

```text
LOW  →  MEDIUM  →  HIGH  →  CRITICAL

For complete technical details covering:

Architecture • AI/ML Methodology • Database • APIs • Algorithms • Testing • Security • Implementation • Future Scope
```

👉 📖 View Complete Project Documentation
