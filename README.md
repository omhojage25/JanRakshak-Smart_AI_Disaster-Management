<div align="center">

# 🇮🇳 JanRakshak

### AI-Assisted Emergency Response & Resource Coordination

**From emergency reports to intelligent, coordinated response — with humans always in control.**

<br>

[🚨 Features](#-key-features) •
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

## 🎯 Problem

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

---

# 🤖 AI + ML

### Gemini AI

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

### XGBoost Risk Assessment

Extracted incident evidence is passed to an **XGBoost multiclass model**.

```text
LOW  →  MEDIUM  →  HIGH  →  CRITICAL
```

**Test Accuracy:** `95.57%`

> The evaluation uses controlled/synthetic data and is not real-world emergency severity validation.

---

# 🚑 Resource Optimization

Instead of independently assigning the nearest unit to every incident, JanRakshak considers **multiple incidents and available resources together**.

```text
Incidents + Resources
        │
        ▼
Resource Requirements
        │
        ▼
Road-Based ETAs
        │
        ▼
Risk / Priority
        │
        ▼
Hungarian Algorithm
        │
        ▼
Recommended Allocation
        │
        ▼
Coordinator Approval
```

This allows the system to coordinate resources globally rather than treating every incident independently.

---

# 📍 Location + Routing

### Location Resolution

```text
Emergency Report
       │
       ▼
Geocoding Candidates
       │
       ▼
Candidate Scoring
       │
       ▼
GPS Reconciliation
       │
       ▼
Confidence / Precision
       │
       ▼
Verification
```

### Road Routing

```text
OpenStreetMap + OSRM
          │
          ▼
Real Road Travel Time
          │
          ▼
Blocked Road Handling
          │
          ▼
Alternative Routes
```

---

# 🏗️ System Architecture

```text
┌─────────────────────────────┐
│      👤 Citizen / Staff     │
│       Text / Voice / GPS    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│       🤖 AI Extraction      │
│      Gemini / Fallback      │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│    📍 Location Resolution   │
│      + Deduplication        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│    🧠 XGBoost Risk Model    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│    🚑 Resource Optimization │
│      Hungarian Algorithm    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│      🛣️ OSRM Routing        │
│       + Blocked Roads       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│    👨‍💼 Coordinator Approval  │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│     🚒 Field Response       │
│      + Live Tracking        │
└─────────────────────────────┘
```

---

# 🛠️ Technology Stack

| Category | Technologies |
|---|---|
| **Frontend** | React, TypeScript, Vite, Tailwind CSS |
| **Backend** | Node.js, Express, TypeScript |
| **Database** | PGlite / PostgreSQL |
| **AI** | Google Gemini |
| **ML** | XGBoost |
| **Maps** | Leaflet, OpenStreetMap |
| **Geocoding** | Nominatim |
| **Routing** | OSRM |
| **Optimization** | Hungarian Algorithm |
| **Real-Time** | Socket.IO |
| **State Management** | Zustand |

---

# 📊 Prototype Results

### 🧠 Risk Model

| Metric | Result |
|---|---:|
| XGBoost Test Accuracy | **95.57%** |

### 🚑 Resource Allocation Benchmark

| Metric | Baseline | JanRakshak |
|---|---:|---:|
| Incidents fully covered | 38% | **83%** |
| Duplicate unit assignments | 16 | **0** |
| Wrong unit type assignments | 4 | **0** |

> ⚠️ Results are from controlled/synthetic benchmark scenarios and demonstrate prototype behavior rather than real-world emergency performance.

---

# 🎯 Project Scope

### 📍 Location

**Mumbai, India**

### 🚨 Supported Emergencies

`🔥 Fire` • `🌊 Flood` • `🏢 Building Collapse` • `☣️ Gas Leak` • `🚗 Road Accident`

### 👥 Main Users

```text
👥 Citizen
     │
     ▼
👨‍💼 Emergency Coordinator
     │
     ▼
🚒 Field Units
     │
     ▼
🔐 Administrator
```

---

# 🚀 Quick Start

### Requirements

- Node.js 20+
- npm

### 1. Clone Repository

```bash
git clone https://github.com/omhojage25/JanRakshak-Smart_AI_Disaster-Management.git
```

### 2. Enter Project

```bash
cd JanRakshak-Smart_AI_Disaster-Management
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Create `.env`

```env
GEMINI_API_KEY=your_api_key
```

### 5. Run

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

---

# 🔮 Future Scope

- 🌐 Multi-city deployment
- 🛰️ Additional real-time disaster data sources
- 📡 IoT and sensor integration
- 🚦 Live traffic integration
- 🧠 Real-world risk model validation
- 📍 Improved multilingual location understanding
- ☁️ Scalable cloud deployment

---

# 👥 Team

| Member |
|---|
| **Om Hojage** |
| **Avishkar Padwal** |
| **Aditya Pallerla** |
| **Sohan Pangale** |

---

# 📚 Documentation

For complete technical details covering:

**Architecture • AI/ML Methodology • Database • APIs • Algorithms • Testing • Security • Implementation • Future Scope**

### 👉 [📖 View Complete Project Documentation](JANRAKSHAK_PROJECT_DOCUMENTATION.md)

---

<div align="center">

## 🇮🇳 JanRakshak

**Understand → Prioritize → Coordinate → Respond**

*AI-assisted emergency response with humans always in control.*

</div>
