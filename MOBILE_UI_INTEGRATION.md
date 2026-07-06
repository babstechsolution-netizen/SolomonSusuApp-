# Mobile UI ↔ Backend Integration Spec

Purpose: reconcile the new mobile design (Awinbire Savings — Design System v1.0) with the
existing `awinbire-enterprise-api` backend so that **data is consistent and efficient across
devices** (field phones, tablets, office desktops). This document lists everything the design
assumes, what the backend already supports, and exactly what is still missing.

Legend: ✅ already works · ⚠️ partial · ❌ missing (needs building)

---

## 1. What already matches — no work needed ✅

| Design element | Backend support |
|---|---|
| Login (username + password) | `POST /api/auth/login` |
| Roles (Super Admin / Branch Manager / Field Collector / Accountant / Customer) | `User.role` + `requireRole` |
| Roles & Privileges editor (toggles, per-employee) | `Employee.privileges[]`, `PATCH /api/employees/:id` (now persists) |
| Collector sees only their assigned customers | login now returns real `employeeId` + `privileges` |
| Customer list, search, status filter | `GET /api/customers` |
| Customer profile: balance, total deposits/withdrawals, dailyAmount, savingsTarget, nationalId, location, phone, collector, member-since | `Customer` model (all fields exist) |
| QR scan → load customer | `GET /api/customers/qr/:code` |
| Deposit / Withdrawal recording | `POST /api/transactions` |
| Withdrawal fee % + minimum-balance rule | `Setting.withdrawalSettings` + logic in `transactionRoutes` |
| Withdrawal approvals queue (approve/reject) | `PATCH /api/transactions/:id/status` |
| Admin dashboard KPIs (deposits, withdrawals, active customers/employees, balance, loans) | `GET /api/dashboard` |
| Reports: by-month, by-method breakdown, top collectors | `GET /api/dashboard/reports` |
| Leaderboard (collections, performance) | `Employee.collections`, `.performance` |
| Customer portal: balance, savings target, request withdrawal, my QR | `Customer` + `POST /api/transactions` (customer → pending) |
| Excel/CSV import (skips duplicates, captures balances) | `POST /api/customers/import` |
| Real-time updates for customers / transactions / employees | Socket.IO `sync()` |
| Themes + dark mode (on-screen) | client-side |

---

## 2. Gaps to close ❌⚠️

### A. Data-model additions

1. **`Transaction.reference`** ❌ — human-readable receipt number (design shows `AW-TXN-240706-0891`).
   Generate on create; store it; use it on every receipt so the same reference shows on any device.
2. **`Transaction.idempotencyKey`** ❌ (unique, sparse) — required for safe **offline retry**. When a
   queued transaction is re-sent, the backend returns the existing record instead of double-recording.
3. **`Employee.dailyTarget`** ❌ (number) — powers the collector home "Daily Target Progress" bar.
4. **New model `Notification`** ❌ — `{ recipientUser, recipientRole, type, title, body, amount,
   customer, read, createdAt }`. Today notifications are **socket-only and not saved**, so the
   Notifications history screen has nothing to load and different devices see different alerts.
5. **User preferences** ❌ — add `preferences { darkMode, accentColor, textSize }` to `User`
   so appearance settings follow the person to any device (currently only in browser localStorage).

### B. New / expanded API endpoints

1. **`GET /api/transactions/collector-summary`** ❌ — for the logged-in collector: today's collected
   total, customers visited today, remaining, total assigned, daily target, % progress.
   (The collector home screen needs these; today they'd be guessed on the client.)
2. **`GET /api/dashboard/timeseries?days=7`** ❌ — deposits vs withdrawals per day for the dashboard chart.
3. **`GET /api/dashboard/reports`** ⚠️ — extend with `?period=today|week|month|quarter&from&to`
   so the Reports period chips return server-computed totals (consistent on every device).
4. **Notifications API** ❌ — `GET /api/notifications` (mine), `PATCH /api/notifications/:id/read`,
   `PATCH /api/notifications/read-all`.
5. **User preferences API** ❌ — `GET/PATCH /api/auth/preferences`.
6. **Forgot / reset password** ❌ — design has "Forgot password?"; backend has no flow
   (option: admin-initiated reset to avoid needing email/SMS infrastructure).
7. **PDF report export** ⚠️ — design shows "Full Report PDF"; only Excel customer export exists today.

### C. Consistency across devices (server-authoritative + real-time)

1. **Persist + target notifications** ❌ — save each notification and emit to the right recipient
   (per-user / per-role socket rooms) instead of a single global admin blast. Then any device can
   load the same history via `GET /api/notifications`.
2. **Broadcast all mutations** ⚠️ — confirm `sync()` is also emitted for **loans** and **settings**
   changes (customers/transactions/employees already broadcast). Anything not broadcast goes stale
   on other devices until refresh.
3. **Compute stats on the server** ❌ — collector-summary, dashboard timeseries and report periods
   should be calculated by the backend so every device shows *identical* numbers rather than each
   client recomputing from a partial local list.
4. **Store preferences server-side** ❌ — see A.5; makes theme/accent consistent across devices.

### D. Efficiency & offline — the PWA layer (currently ABSENT)

> Important: this app is **not yet a PWA**. `public/` has no `manifest.json` and no service worker.
> The design's offline-first screens (queued transactions, "works offline", background sync) are
> entirely aspirational for this app today.

1. **`manifest.json`** ❌ — name, icons, `theme_color:#1A5C2E`, `display:standalone` (installable).
2. **Service worker** ❌ — cache the app shell + GET responses (stale-while-revalidate) so the app
   opens and shows last-known data with no connection.
3. **Offline transaction queue** ❌ — store queued deposits in IndexedDB; on reconnect POST them with
   `idempotencyKey` (see A.2) so retries never double-record. Show the queued-count badge from the design.
4. **Pagination** ⚠️ — transactions are already paginated (good); add the same to activity log &
   notifications to keep large accounts fast on phones.

### E. Small alignment fixes

1. **Receipt reference** — implement `Transaction.reference` (A.1) so printed & WhatsApp receipts match.
2. **Withdrawal-approval mismatch** — backend currently **auto-approves** employee-initiated
   withdrawals (`status:'approved'`), but the design shows collector withdrawals as *"requires manager
   approval"*. Decide the rule; if approval is required, set collector withdrawals to `pending`.
3. **Min-balance rule at approval** — enforce the minimum-balance rule when a manager approves a
   pending withdrawal (currently only checked for customer-initiated requests).

---

## 3. Recommended build order

1. **Foundation / consistency** — `Transaction.reference` + `idempotencyKey`; `collector-summary`
   & `timeseries` endpoints; verify loans/settings broadcast. *(Small, safe, additive.)*
2. **Consistency** — `Notification` model + endpoints + per-user emit; user preferences persistence.
3. **Efficiency / offline** — PWA manifest + service worker; IndexedDB offline queue using idempotency.
4. **Polish** — forgot/reset password, PDF export, withdrawal-approval alignment.

All of Section 2 is **additive** (new fields default to empty, new endpoints are new URLs), so it can
ship without breaking the current app or the live data.
