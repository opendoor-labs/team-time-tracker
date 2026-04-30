# Security & Operational Controls

This document describes the security controls protecting the Team Time Tracker (TTK) — the Mac app, the Apps Script backend, and the data they handle.

## Threat model

TTK collects **per-user productivity telemetry** (shift times, activity, task counts) for ~115 users across 17 teams. The data is internal but sensitive: it informs performance reviews and team capacity planning.

The realistic threats:
1. **Tampered binary** — a user modifies the Mac app to fabricate higher productive minutes or task counts.
2. **Direct API forgery** — a user crafts HTTP requests to the Apps Script web app to inject fake heartbeats.
3. **Spreadsheet access leakage** — non-admin users gain read access to the source-of-truth Google Sheet (which contains every user's full activity log).
4. **Account takeover** — a user's Opendoor email is compromised and used to log in to the dashboard.

The controls below address each.

## Binary integrity (defends threat 1)

| Layer | Where | What it does |
|---|---|---|
| Filesystem lockdown | `install.sh` (PR #37) | After install, runs `chmod -R 555` on the `.app` bundle so casual file edits are blocked at the OS level. |
| SHA256 fingerprint | `install.sh` (PR #36) | Computes SHA256 of the compiled binary, writes it (read-only `chmod 444`) to `~/Library/TeamTracker/binary.sha256`. |
| Self-integrity check | `TeamTimeTracker.swift` (PR #38) | At every launch, the Swift app re-hashes itself and compares to the stored fingerprint. Mismatch → user-visible alert + immediate exit. |
| Server-side allowlist | `apps-script/Code.gs` (PR #39) | The Mac app sends its computed binary hash on every API call. Apps Script checks the hash against `Config!B13` (newline-delimited allowlist of known-good hashes). Mismatch → request rejected. |
| Email alerting | `apps-script/Code.gs` (PR #40) | First hash mismatch per user triggers a one-time email to all super_admins (computed from the Whitelist sheet). Subsequent mismatches for the same user are suppressed for 24h. |

**Operational rotation**: when a new Mac app version ships, the SHA256 of the new binary must be appended to `Config!B13`. Old hashes can be removed once telemetry confirms no users are still on the old version (check Errors tab for `binaryHashRejected` events in the last 7 days).

## Account & session controls (defends threat 4)

| Layer | What it does |
|---|---|
| Email-only login | Dashboard authentication is `@opendoor.com` email + 6-digit OTP delivered by Gmail. No passwords stored anywhere. |
| HMAC-signed sessions | Session tokens are HMAC-SHA256 signed with a secret stored in `Config!B10`. Tokens expire after 7 days. |
| Whitelist gating | `Whitelist` sheet (manually curated) lists every authorised user and their team(s). A user not on the whitelist cannot log in even with a valid OTP. |
| Role separation | `super_admin` (sees all 17 teams + Sessions/Attendance/Whitelist/Config), `team_lead` (sees only their team(s)), `qc` (tasks-only contract — no Live activity, no Drive access). |
| 2FA | All Opendoor email accounts require 2FA (Okta-enforced). The OTP factor inherits this. |

**Quarterly access review**: every quarter, the Whitelist is reviewed by the platform owner against current employment records (Workday) and team assignments (Hamlet). Departed employees are removed within 24h of off-boarding (manual process, triggered by HR's standard departure ticket).

## Data access (defends threat 3)

The source-of-truth Google Sheet (ID `1mNOj9MWZAAVNEaWvnNjIkHkoUG1rMWHg0HWM1m47OXs`) is shared with **only** the platform owner and the Apps Script service account. End users never get direct sheet access — all reads go through the Apps Script web app, which enforces team-scoped filtering before returning rows.

The Drive archive folder (`_System (Sessions + Attendance)`) is locked to admins only. PR #5 added strict gating in `syncArchivePermissions` so QC users get **no** Drive access. PR #5 also shipped `revokeQcDriveAccess()`, a one-shot cleanup that removed 4 historical permission entries from QC users.

## Daily security audit (PR #43)

A cron-triggered job runs every morning at **6 AM IST** (`dailySecurityAudit_`):

1. Scans the previous 24h of `Errors` tab for `binaryHashRejected`, `forbidden`, and `session_expired` events.
2. Counts heartbeats per user; flags any user with > 200 heartbeats/hour (anomalous polling).
3. Checks the Whitelist sheet for any rows added in the last 24h that don't match a known team.
4. Emails a one-line summary to all super_admins: counts of each anomaly type plus a link to the Errors tab.

A green-day email still sends ("0 anomalies in last 24h") so silence doesn't get mistaken for "audit didn't run."

## Incident response runbook

If you suspect a security incident (tampered binary in the wild, leaked credentials, anomalous activity in the audit email):

1. **Contain** — Edit `Config!B13` to remove the suspect hash. Within ~4 minutes, all clients on that hash will get rejected. For credential compromise, remove the user from `Whitelist` (immediate effect on next dashboard load).
2. **Investigate** — Open the `Errors` tab. Filter by user email and date. Cross-reference with that user's recent heartbeats in `Sessions` and the daily archive Drive files.
3. **Rotate** — If the HMAC session secret may have leaked, generate a new one and update `Config!B10`. All existing dashboard sessions invalidate immediately; users re-log via OTP.
4. **Notify** — For any incident affecting > 1 user or any data exfiltration, page the Opendoor security team via the standard incident channel.
5. **Document** — File a brief post-incident note in this repository under `docs/incidents/YYYY-MM-DD-short-name.md` (folder created on first incident).

## Reporting a vulnerability

If you find a security issue in TTK:
- **DO NOT** file a public GitHub issue.
- Email **arun.mohan@opendoor.com** with a description of the issue and reproduction steps.
- Acknowledgement within 1 business day. Triage + fix typically within 1 week.
