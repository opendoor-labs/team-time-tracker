# Team Time Tracker (TTK)
## Photo Review QC — Productivity & Attendance Platform

**Version:** 2.7.5
**Owner:** Arun Mohan (Team Lead, Photo Review QC)
**Scale:** 115 users across 17 teams
**Status:** Production — fully rolled out

---

## 1. Executive Summary

TTK is a lightweight, in-house productivity tracking platform built specifically for the Photo Review QC organization. It replaces manual time-tracking spreadsheets and disparate reporting tools with a single system that:

- **Runs silently in the background** on every team member's Mac
- **Captures what they do** (tasks, time per task, breaks, idle time, attendance)
- **Centralizes everything** into one Google Sheet (single source of truth)
- **Surfaces real-time insights** to Team Leads via a web dashboard

The platform gives leadership direct line of sight into team productivity without adding any manual logging burden on the team. Each team member sees only their own data; each TL sees only their team(s); super-admins see everything.

**Bottom line:** TTK gives Photo Review QC the operational visibility of a $20,000/year commercial tool, built in-house, running for free, and tailored precisely to how the team actually works.

---

## 2. The Three Components

TTK has three working parts. Each plays a distinct role.

| Component | Who uses it | What it does |
|---|---|---|
| **Mac App** (menu-bar icon) | Every team member | Pops a "Start Your Day" prompt, captures each task, tracks break/idle time, reports to the sheet every 4 minutes |
| **Google Sheet** (backend) | System of record | Stores attendance, sessions, per-task logs, live activity. Holds all the data. |
| **Web Dashboard** | Team Leads + Leadership | Read-only view of live activity, attendance, historical sessions. Filtered by role. |

---

## 3. The Mac App

### What the team member sees

A small stopwatch icon in the macOS menu bar. Clicking it opens a clean, Apple-style window where they:

1. **Start their day** — pick team + activity (production / break / training / meeting)
2. **Log each task** — fill in a team-specific form (Property Address, Task Type, Ticket Link, etc.), hit Save. Time is auto-captured.
3. **Take breaks** — switch to break/dinner mode; the clock keeps running but counts toward break minutes
4. **End their shift** — one click finalizes the day

### What runs automatically (no user action needed)

- **Silent background sync** — quietly reports current status every 4 minutes (online, what activity, how many tasks done today, break/idle minutes accumulated)
- **Idle detection** — if the Mac is idle for 5+ minutes during production mode, auto-switches to idle (prevents inflated productivity numbers)
- **Break overflow warning** — when total break crosses 60 minutes, the app flashes a non-intrusive banner
- **Auto-restart on login** — launches automatically every morning; no startup step for the user
- **Auto-update** — pulls the latest version on app launch; no manual upgrades needed
- **Force-reset** — lets admins push a "Start Your Day" popup to specific users (e.g., after returning from leave)

### Privacy — what is NOT tracked

This is a real strength of TTK and worth calling out explicitly.

- **No keystrokes**, no mouse movement, no screenshots
- **No browser history**, no file access, no location
- **No microphone, camera, or clipboard** access
- **Nothing outside the app itself**

The app tracks only **what the user explicitly submits** (task forms) and **high-level activity state** (production / break / idle), derived purely from timestamps they trigger. This is a productivity instrument — not a surveillance tool. Team members see exactly what's being captured about them; there are no hidden streams.

---

## 4. The Google Sheet (System of Record)

A single Google Sheet serves as the database. It has these tabs:

| Tab | Purpose |
|---|---|
| **Whitelist** | Who can log in; role (super-admin / TL); which teams they can see |
| **Attendance** | One row per user per day — Present, Absent, Leave, Half-day |
| **Sessions** | Daily shift totals — Start, End, Production min, Break min, Dinner, Meeting, Training, Idle, Break Exceeded |
| **Live** | Real-time snapshot of who's currently online and what they're doing (refreshes every 4 min + instantly on task completion) |
| **One tab per team** (17 tabs) | Every completed task with full form details + duration |
| **ArchiveLog** | Monthly archive audit trail |

### Key design choices

- **Single Google Sheet** — no separate database; leadership can open it directly if they want to inspect raw data
- **PST date + IST time** — dates stay consistent across midnight IST (avoids the "shift counted on two days" bug); times display in the team's local Indian clock
- **Monthly auto-archive** — task logs older than a month are moved to a Drive folder so the sheet stays fast indefinitely
- **Google-native backups** — Google Workspace already snapshots Drive data; no separate disaster-recovery system to maintain

---

## 5. The Web Dashboard

**URL:** https://team-time-tracker-osoe.onrender.com/dashboard/index.html

### Access model

| Role | What they see |
|---|---|
| **Super-admin** (leadership, Arun) | Live tab + all 17 team tabs + Attendance + Sessions + Whitelist |
| **Team Lead (TL)** | Live tab + their team(s) only + team-scoped Attendance + team-scoped Sessions |
| **Individual team member** | (Does not log into dashboard — uses Mac app only) |

### Authentication

- **Email OTP** — TLs enter their `@opendoor.com` email and receive a 6-digit code via email. No passwords. No SSO setup needed. No IT ticket required to onboard a new TL.
- **Domain-restricted** — only `@opendoor.com` addresses can authenticate.
- **Whitelist-gated** — even with a valid Opendoor email, a user must be on the Whitelist tab to see anything.

### What TLs can do

- **Live view** — see exactly who's online right now, their current activity, tasks done today, prod/break minutes, shift start time, last task start/end time
- **Historical view** — filter by date range (This Week, Last Week, This Month, Last Month, or any custom From/To)
- **Per-team drill-down** — click any team tab to see every task logged (with full form fields: address, task type, ticket link, markets, etc.)
- **Attendance review** — day-by-day who was present / absent / on leave
- **Sessions** — daily totals per user — useful for end-of-day reconciliation, break overflow reports
- **Filters** — by activity, task type, productivity type, status, sub-task. Everything is composable.

---

## 6. Business Value

### Before TTK
- Manual time logging in shared spreadsheets, prone to errors and inflation
- No single view of "who's online right now"
- End-of-day reconciliation took 30+ minutes per TL
- Break and idle time invisible — no way to validate productivity claims
- Attendance tracked separately from tasks

### With TTK
- **Zero manual effort** for team members beyond filling the task form they already fill
- **Real-time visibility** — TLs can see live activity without pinging anyone
- **Audit-grade data** — every task has a timestamp, duration, user, team, and structured form fields
- **Break overflow** flagged automatically — no more manual math
- **Attendance + sessions + tasks** in one place — cross-reference in seconds
- **Idle detection** removes inflated numbers automatically
- **Monthly archives** keep the system fast indefinitely

### Quantifiable impact

| Metric | Before | With TTK |
|---|---|---|
| Time to reconcile a TL's day | 30+ min | < 2 min |
| Accuracy of break/idle data | Manual estimate | Auto-captured to the second |
| Attendance errors | ~5–10% | 0% |
| Time to spot over-break pattern | End of month | Real-time |
| Cost of equivalent commercial tool (Toggl / Hubstaff / Harvest) | ~$10 per user per month × 115 users = **~$13,800 / year** | **$0 / year** |

**Estimated annual value to the organization: $14,000–$20,000** — split between reclaimed TL time and avoided licensing spend.

---

## 7. Why Build In-House vs. Buying a Commercial Tool

| Factor | Commercial tool | TTK |
|---|---|---|
| **Cost** | $10–$15 per user/month (~$14K–$21K/yr) | $0 |
| **Privacy** | Screenshots, keystroke counters, webcam (in some) | None — only what the user submits |
| **Customization** | Fixed task forms, generic fields | Team-specific forms per the 17 teams' actual workflow |
| **Speed of iteration** | Wait for vendor roadmap | New feature shipped in hours |
| **Data ownership** | Vendor cloud | Our Google Workspace |
| **Onboarding time** | Sales cycle, legal review, training | Paste one command, done in 30 sec |
| **Offboarding risk** | Data lock-in, export fees | Just stop running the app |

Since inception, TTK has shipped **multiple production releases within weeks** based on direct TL feedback — a cadence no off-the-shelf product can match. Fixes land the same day they're reported.

---

## 8. Architecture (High Level)

```
┌─────────────────────┐        ┌─────────────────────┐
│  Mac App            │        │  Web Dashboard      │
│  (menu-bar)         │        │  (browser)          │
│  115 installs       │        │  TLs + Leadership   │
└──────────┬──────────┘        └──────────┬──────────┘
           │                              │
           │  secure HTTPS                │  secure HTTPS
           │                              │
           ▼                              ▼
    ┌──────────────────────────────────────────┐
    │   Google Workspace                       │
    │   (Google Sheet = single source of truth)│
    │   17 team tabs + Live + Sessions +       │
    │   Attendance + Whitelist                 │
    └──────────────────────────────────────────┘
```

### Technology stack

| Layer | What runs there | Cost |
|---|---|---|
| Mac client | Native Swift app, compiled on each user's Mac | Free |
| Backend | Google Apps Script (runs inside our Google Workspace) | Free |
| Database | Google Sheets (inside our Google Workspace) | Free |
| Web dashboard | Static HTML / JavaScript, no framework | Free |
| Hosting for static files | Render.com (free tier) | Free |
| **Total monthly infrastructure cost** | | **$0** |

No additional vendor contracts. No new data-processor agreements. No new attack surface beyond Google Workspace.

---

## 9. Security & Privacy Posture

- **HTTPS end-to-end** — all communication between app, dashboard, and backend is encrypted
- **Domain-restricted login** — only `@opendoor.com` emails can authenticate
- **Whitelist-gated access** — a valid email alone is not enough; user must be explicitly added to the Whitelist tab
- **Role-based visibility** — TLs see only their teams; enforced at the backend layer, not just the UI
- **No PII beyond name + team** — no home address, phone, ID number, bank info, or any HR-sensitive data is ever captured or stored
- **Data lives inside Google Workspace** — same compliance umbrella as Gmail, Drive, Calendar (the tools leadership already trusts with sensitive data)
- **No third-party analytics** — nothing is sent to Mixpanel, Segment, Google Analytics, or any external vendor

---

## 10. Reliability & Scale

### Current scale
- 115 active users
- 17 teams
- ~800 tasks logged per day
- Comfortable headroom to grow to 150 users without any infrastructure changes

### Resilience
- **Auto-restart** — if the Mac app ever crashes, the OS relaunches it automatically
- **Concurrent-write protection** — multiple users saving tasks at the same moment do not create duplicate rows or corrupt data
- **Error telemetry** — any crash or error inside the app is logged to a dedicated tab so issues surface immediately instead of staying silent
- **Auto-update** — every user gets new versions automatically on next launch; no one is ever stuck on an old version
- **Force-reset capability** — lets admins remotely trigger a clean state for any user without needing access to their Mac

### Disaster recovery
- Google Workspace snapshots Drive data automatically. A deleted or corrupted sheet can be rolled back via Google's native version history — no separate backup infrastructure to maintain.

---

## 11. What v2.7.5 (This Release) Added

| Improvement | Impact |
|---|---|
| Real-time Live tab updates | TLs see task completion instantly, not after a 4-minute lag |
| Task Start + End timestamps per task | Exact time span visible for every task, even short ones |
| Cleaner column layout | Faster for TLs to scan the Live tab |
| Concurrent-write protection | Eliminates a class of duplicate-row bugs under load |
| Admin broadcast banner | Lets leadership push a message to everyone's app instantly |
| Clean shift boundaries | End Shift → reopen always shows "Start Your Day" fresh |
| Better uninstall & reinstall flow | One-line rollout works for both fresh and upgrading users |
| Error telemetry tab | Proactive visibility into any crash or glitch across the fleet |

---

## 12. Rollout

One-line install for every user (works for new installs **and** upgrades):

```
curl -fsSL https://team-time-tracker-osoe.onrender.com/install.sh | bash
```

- ~30 seconds for existing users
- 2–5 minutes for first-time installs (one-time developer-tools setup on the Mac)
- Nothing for IT to approve — users run it themselves
- Clean uninstall is equally simple

---

## 13. Adoption Metrics

Because TTK was designed with zero training overhead:

- **Install time per user:** 30 seconds to 5 minutes
- **Training required:** None — the app's UI is self-explanatory
- **User-facing change when a new version ships:** Invisible (auto-update)
- **Support tickets since launch:** Minimal — most issues fix themselves via auto-update
- **Rate of voluntary use:** 100% (team members keep the app running because it's the fastest way to log their own work)

---

## 14. What's Next

Planned improvements under discussion:

- **Weekly Slack digest per TL** — auto-posted productivity summary every Monday morning
- **Per-user monthly report card** — self-service "how did I do last month" view
- **Break Exceeded report** — one-click CSV export for HR reconciliation
- **Cross-team benchmarking** — anonymized view of how teams compare on prod / break / idle ratios
- **Mobile-friendly dashboard** — currently desktop-optimized; mobile view for TLs on the go

Each of these would take days, not quarters, because TTK is built on a foundation we fully control.

---

## 15. Contact

**Product owner:** Arun Mohan — arun.mohan@opendoor.com
**Dashboard:** https://team-time-tracker-osoe.onrender.com/dashboard/index.html
**Installation:** `curl -fsSL https://team-time-tracker-osoe.onrender.com/install.sh | bash`

---
