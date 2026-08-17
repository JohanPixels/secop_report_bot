# 🔎 Filtr — SECOP II Weekly Watch

*Automated weekly monitoring and reporting of public procurement processes in Cauca using SECOP II data and generative AI.*

Filtr Weekly Watch collects recent SECOP II procurement data, calculates a set of predefined indicators, and generates a concise executive report automatically.

The final report is delivered through Telegram once a week.

## Overview

Public procurement generates large amounts of structured data, but turning that data into something that can be reviewed regularly often requires repetitive manual work.

This project automates that process for procurement activity in Cauca:

1. Fetch recent SECOP II processes.
2. Clean and normalize the data.
3. Calculate predefined indicators.
4. Generate an executive interpretation with Gemini.
5. Deliver the report through Telegram.

## How it works

```
SECOP II API
     │
     ▼
Data collection
     │
     ▼
Normalization
     │
     ▼
Deterministic indicators
     │
     ├───────────────┐
     ▼               ▼
Statistics        Risk signals
     │               │
     └───────┬───────┘
             ▼
        Gemini API
             │
             ▼
     Executive summary
             │
             ▼
          Telegram
```

## Features

- 📊 Weekly SECOP II data collection
- 🔎 Deterministic procurement indicators
- 🧠 AI-generated executive summaries
- 📋 Automated Telegram reports
- ⚙️ Scheduled execution with GitHub Actions
- 🔗 Direct links to SECOP II processes

## Risk indicators

The current version monitors:

- **Low competition**: closed processes with 0–1 unique providers.
- **Direct contracting**: percentage of processes using direct contracting.
- **No budget variation**: awarded processes where the awarded value matches the initial budget.
- **Cancellations**: cancelled procurement processes.
- **High-value processes**: processes above $500M COP.

*These indicators are screening signals, not evidence of corruption or other wrongdoing. They are intended to prioritize processes for further review.*

## AI-generated analysis

Gemini receives aggregated statistics and selected context from the processed data.

The model is used to:

- Identify relevant patterns.
- Prioritize signals worth reviewing.
- Mention specific entities when relevant.
- Generate a concise executive summary.

The underlying indicators and numerical calculations are performed deterministically by the application.

## Tech Stack

- **Node.js** — data processing and automation
- **SECOP II / datos.gov.co** — procurement data
- **Gemini API** — executive analysis
- **Telegram Bot API** — report delivery
- **GitHub Actions** — scheduled execution

## Setup

### Requirements

- Node.js 20+
- Gemini API key
- Telegram bot and chat ID
- Optional SECOP II App Token

Clone the repository and install dependencies:

```bash
git clone https://github.com/YOUR_USERNAME/secop_report_bot.git
cd secop_report_bot
```

### Environment variables

Create a `.env` file:

```
GEMINI_API_KEY=your_gemini_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

# Optional
SECOP_APP_TOKEN=your_secop_app_token
```

**Never commit your `.env` file.**

### Running locally

Run the report with:

```bash
node scripts/secop-report.mjs
```

The script will fetch the latest data, generate the analysis, and send the report to Telegram.

## Automation

The workflow can be executed automatically using GitHub Actions:

```
Scheduled workflow
       ↓
SECOP II
       ↓
Node.js pipeline
       ↓
Indicators
       ↓
Gemini
       ↓
Telegram
```

Once configured, the weekly report requires no manual intervention.

## Example

A typical report includes:

- Total procurement value and processes
- Direct contracting percentage
- Procurement signals worth reviewing
- Highest-value processes
- AI-generated executive interpretation
- Direct links to SECOP II

<!-- Add demo GIF or screenshot here -->

## Limitations

This is a monitoring and screening tool, not an automated investigation system.

The indicators do not establish corruption, fraud, collusion, favoritism, or other wrongdoing. They are intended to help prioritize processes for human review.

The current implementation is focused on Cauca and the processes returned by the configured SECOP II query.

## Roadmap

- [x] SECOP II data ingestion
- [x] Procurement indicators
- [x] Gemini executive analysis
- [x] Telegram reports
- [x] GitHub Actions automation
- [ ] Visual weekly report
- [ ] Historical trend analysis
- [ ] More procurement indicators
- [ ] Expand monitoring beyond Cauca

## License

MIT
