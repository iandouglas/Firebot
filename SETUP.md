# Firebot YouTube Support — Manual Setup Checklist

These are the steps that **you** must do by hand (agents can't click through Google's consoles or your YouTube channel settings). Check items off as you complete them.

> **Context:** This file covers everything outside the codebase. The GCP work takes ~10–15
> minutes. None of it blocks writing the code — it only blocks *testing* the OAuth + chat flow.

---

## 1. Google Cloud Project & OAuth Client

Work in your **existing GCP project** (the one that already has the API key you use for
live-status checks). Keeping everything in one project keeps quota usage and any future
quota-increase request in one place.

### 1.1 Verify the YouTube Data API is enabled
- [ ] Go to <https://console.cloud.google.com/apis/library>
- [ ] Select your project (top bar)
- [ ] Confirm **"YouTube Data API v3"** shows as *Enabled* (it should already, since your API key works)
- [ ] While there, note the **Project ID** (shown in the project switcher) — you'll need it for quota monitoring later

### 1.2 Configure the OAuth consent screen
- [ ] Go to <https://console.cloud.google.com/apis/credentials/consent>
- [ ] Choose **External** user type (personal accounts require this) → **Create**
- [ ] Fill in: App name (e.g. `Firebot`), User support email (yours), Developer contact email (yours)
- [ ] Leave the rest of the sections (domains, branding) empty — nothing else is required for personal use
- [ ] **Scopes**: nothing needs to be added here manually; the app requests scopes at login time
- [ ] Under **Test users**, click **+ Add users** and add:
  - [ ] Your **main** Google account (the one you stream with)
  - [ ] Your **bot** Google account

> ⚠️ **Testing mode consequence:** while the consent screen stays in "Testing" status,
> Google expires refresh tokens after **7 days**. You'll have to re-login both accounts
> roughly weekly. That's the accepted tradeoff for now (no Google verification process
> needed for personal use). Flipping to "In production" later is a known follow-up item —
> it removes the expiry but shows an "unverified app" warning screen unless the app goes
> through Google's verification (not worth it for a personal 2-user app).

### 1.3 Create the OAuth client
- [ ] Go to <https://console.cloud.google.com/apis/credentials>
- [ ] **+ Create credentials → OAuth client ID**
- [ ] Application type: **Web application**
- [ ] Name: `Firebot YouTube (localhost)`
- [ ] **Authorized redirect URIs** — add exactly:
  ```
  http://localhost:7472/api/v1/auth/callback
  ```
  > `7472` is Firebot's default web server port. If you ever change
  > Firebot's **WebServerPort** setting, add a second redirect URI matching the new port.
- [ ] Click **Create**, then copy both values:
  - [ ] **Client ID**: `_PASTE_INTO_secrets.json_`
  - [ ] **Client secret**: `_PASTE_INTO_secrets.json_`

> 🔑 **Scope note (no console action needed):** the app requests
> `https://www.googleapis.com/auth/youtube.force-ssl` at login — that one scope covers
> chat read, chat send, and broadcast/live-status management. If/when the member roster
> (`members.list`) feature is built, a second scope
> (`youtube.channel-memberships.creator`) gets added to the same consent flow — no
> console changes needed.

---

## 2. Firebot `secrets.json`

Firebot validates a `secrets.json` in the repo root at startup (`src/backend/secrets-manager.ts`)
and refuses to run if required keys are missing.

- [ ] If `secrets.json` does **not** exist in the repo root yet, create it from the template:
  ```sh
  cp secrets.template.json secrets.json
  ```
  (Run this in `/Users/id/src/public/Firebot` — the file is gitignored so your secrets won't be committed.)
- [ ] Add the two Google keys (and see the note below about the other required keys):
  ```json
  {
      "googleClientId": "PASTE-CLIENT-ID-HERE",
      "googleClientSecret": "PASTE-CLIENT-SECRET-HERE",

      "...": "other existing keys must remain / be filled — see note"
  }
  ```
  (Exact key names will be finalized in the code as `googleClientId` / `googleClientSecret`
  unless the build process says otherwise — they will be added to
  `src/backend/secrets-manager.ts` as part of the implementation.)

> ⚠️ **Note on the other secret keys:** building/running Firebot from this fork also
> requires Firebot's own keys (`twitchClientId`, `tipeeeStream*`, `streamLabs*`,
> `fontAwesome5KitId`). These ship encrypted with the official maintainers
> (`secrets.gpg`). For your personal fork you'll need to obtain the values embedded in
> the official release — e.g. extracted from the installed `Firebot` app bundle. We'll
> pin down the exact extraction method when wiring up the dev environment; if you run
> into a wall, tell the agent working the foundation workstream and it can assist.

---

## 3. Bot Account as Channel Moderator

- [ ] Sign into YouTube as your **main** account
- [ ] Go to **YouTube Studio → Settings → Community** (<https://studio.youtube.com/channel/UC/comments/moderation> → Settings gear)
  - or directly: <https://www.youtube.com/studio/settings> → *Community* tab
- [ ] In the **Moderators** section, click **+ Add moderator** / choose from your subscriber list
- [ ] Add the channel of your **bot** Google account → Save

> Why: moderator status lets the bot bypass slow-mode limits and exposes the
> `isChatModerator` role flag so Firebot command restrictions ("mods only") recognize it.

- [ ] Also confirm the bot account can actually chat: open one of your past live streams
  as the bot account and send a test message (catches "blocked words"/ban filter issues early).

---

## 4. Quota Awareness (reference, no action required now)

- Default: **10,000 units/day** per project. Reset at midnight Pacific.
- Cost estimates for what the integration uses per stream:
  - `liveBroadcasts.list` (live check poll): 1 unit/call (~2,880 per 24h at 60s polling; we only poll while "connected")
  - `liveChatMessages.list` (chat read): low cost per call, polled only while live
  - `liveChatMessages.insert` (bot sends a message): **50 units each**
- Where to watch usage: <https://console.cloud.google.com/apis/dashboard> → YouTube Data API v3 → *Quota & System Limits*
- If a busy chat night exhausts it, symptoms are `quotaExceeded` errors and the bot goes silent until midnight PT — a quota increase request to Google is routine for legit apps.

---

## 5. YouTube Channel Monetization (when you enroll)

The integration is built for all YouTube monetization events — they simply won't fire
until the corresponding channel features exist:

- [ ] **Memberships**: when you enroll (<https://studio.youtube.com> → Earn → Memberships),
  paid-member events will flow automatically. If the "Members" list in the dashboard stays
  empty after enrolling, tell the agent — `members.list` may need a one-time YouTube
  approval check on the GCP project.
- [ ] **Super Chat / Super Stickers**: available once your channel monetization is set up;
  no extra setup needed for the events.

## 6. Coming Later (placeholders — will be expanded)

- [ ] Flip OAuth consent screen to **Production** status after the integration is stable (removes the 7-day token expiry; expect the "unverified app" warning screen for non-test users)
- [ ] Optional: request a quota increase if needed