# Firebot × YouTube Integration

This fork adds native YouTube streaming support to Firebot. It is built as a **native
integration** under `src/backend/integrations/builtin/youtube/` — it does not refactor
Firebot's Twitch platform core. This document is the operational reference: architecture,
quota budget, manual QA, failure drills, and the production consent-screen flip.

> **Before you can test anything live**, complete the manual steps in
> [`SETUP.md`](../SETUP.md) (GCP project, OAuth client, `secrets.json`, bot-as-moderator).
> The code is written against the API contract; only live verification needs real creds.

---

## 1. What it does

- **Two Google OAuth accounts** — a *streamer* account (your main channel) and a *bot*
  account (a second Google account you make a channel moderator). Both use the same GCP
  OAuth client; the bot is optional but recommended for automated messages.
- **Live detection** — polls `liveBroadcasts.list` every 60s while connected and emits
  `stream-online` / `stream-offline` events (with concurrent viewer count).
- **Merged chat feed** — YouTube chat is ingested and shown in the same dashboard feed as
  Twitch, with a platform badge. Commands work from either platform.
- **Dual-platform responses** — command chat responses fan out to **both** platforms
  (locked decision D7).
- **Cross-platform relay** — optional (default off) relay of each platform's chat into the
  other, with loop prevention and a per-minute cap.
- **Moderation parity** — delete / timeout / ban / unban for YouTube from the merged feed.
- **Title sync** — a title update from a command/effect lands on both platforms.
- **Monetization events** — members, super chat, super stickers, gifts (fire once your
  channel is enrolled).
- **Viewer DB** — every viewer is keyed `<platform>:<user_id>` (`twitch:123`, `youtube:UC…`).

---

## 2. Architecture map

| Concern | Module |
|---|---|
| Integration definition + wiring | `src/backend/integrations/builtin/youtube/youtube.ts` |
| OAuth (streamer + bot providers) | `youtube-auth.ts` |
| Account store (tokens + channel info) | `account-store.ts` |
| REST client (quota-aware) | `youtube-api-client.ts` |
| Live monitor (60s poll) | `live-monitor.ts` |
| Chat ingest (read loop → commands + feed) | `chat-ingest.ts` |
| Chat outbound (serialized, quota-guarded) | `chat-sender.ts` |
| Dual-platform dispatch | `src/backend/chat/platform-dispatch.ts` |
| Cross-platform relay | `chat-relay.ts` |
| Moderation + title/stream control | `moderation.ts`, `stream-control.ts` |
| Monetization events + variables | `youtube-events.ts`, `youtube-variables.ts` |
| Members roster (best-effort) | `members-roster.ts` |
| Viewer identity (`<platform>:<id>`) | `src/backend/viewers/viewer-identity.ts` |
| Event/type contracts | `contracts.ts` |

**Ownership rule:** `youtube.ts` wiring is owned by the coordinator. Feature modules report
wiring needs rather than editing it directly.

---

## 3. Quota budget

Default GCP quota is **10,000 units/day** per project, resetting at midnight Pacific. Both
linked accounts share the **same** project quota.

| Operation | Cost | Notes |
|---|---|---|
| `liveBroadcasts.list` (live check) | 1 unit/call | ~2,880/24h at 60s polling; only polled while connected |
| `liveChatMessages.list` (chat read) | low | polled only while live |
| `liveChatMessages.insert` (bot send) | **50 units** | the expensive one |
| moderation / title / members | varies | see Google's cost table |

**Outbound send budget:** the chat sender caps at **80 sends/day** (≈4,000 units) to leave
headroom for polling + moderation. When the cap is hit, the message is dropped, a warning is
logged, a danger toast fires, and a persistent notification-center entry is added. The cap
resets daily (UTC).

**Relay cap:** the cross-platform relay is capped at **12 messages/min** per direction by
default (sliding window) to prevent quota spikes.

### Quota audit (live, blocked on `SETUP.md`)

Run a scripted **15-minute dual-platform session** and record actual unit consumption vs.
budget:

1. Link both accounts; start both streams.
2. Have a few viewers chat on each platform; trigger a handful of commands (so responses
   fan out to both platforms); enable the relay and let it run.
3. Watch <https://console.cloud.google.com/apis/dashboard> → YouTube Data API v3 →
   *Quota & System Limits*.
4. Record: live-poll units, chat-read units, insert units (×50 each), moderation units.
5. If the projected 24h usage exceeds ~8,000 units, lower `DEFAULT_DAILY_SEND_BUDGET`
   (in `chat-sender.ts`) and/or the relay cap (`DEFAULT_RELAY_MAX_PER_MINUTE` in
   `chat-relay.ts`).

---

## 4. Manual QA script

These steps need both streams live and both accounts linked. Work through them in order.

1. **Link accounts** — OAuth the streamer account, then the bot account. Confirm both appear
   in the YouTube integration settings.
2. **Weekly-expiry simulation** — advance the system clock +7 days (or wait) and confirm the
   app re-prompts for re-auth on the next token use (testing-mode consent expiry).
3. **Detect live** — start the YouTube broadcast; confirm the dashboard header shows the
   YouTube icon + concurrent viewer count; confirm it disappears when the stream ends.
4. **Merged chat** — confirm YouTube messages appear in the dashboard feed with the YouTube
   badge, and that chatters appear in the CHAT USERS panel (platform-tagged).
5. **Commands both directions** — run a command from a Twitch message and from a YouTube
   message; confirm both trigger and that chat responses land on **both** platforms.
6. **Responses both platforms** — confirm a command response appears in Twitch chat AND
   YouTube chat.
7. **Relay loop check** — enable the relay; confirm messages flow both directions with
   `[Twitch]` / `[YT]` prefixes, no infinite loops, and that relayed copies stay visible
   while Firebot-authored command responses stay hidden (with `ChatHideBotAccountMessages` on).
8. **Moderation** — delete a YouTube message from the feed, timeout a user 300s, ban + unban;
   confirm each on the YouTube side and that quota is logged.
9. **Title sync** — set the title via the effect while both streams are live; confirm it
   lands in YouTube Studio and Twitch.
10. **Event test-fires** — if enrolled, confirm members / super chat / gift events fire and
    their variables resolve.

---

## 5. Failure drills

- **Revoke token mid-stream** — revoke the streamer token in Google; confirm the next API
  call surfaces a re-auth path (and a clear error) rather than a silent hang.
- **Kill network 60s** — disconnect for 60s; confirm the chat reader backs off and recovers
  once the network returns (the reader self-schedules with backoff).
- **Quota-exceeded simulation** — exhaust the daily send budget (or mock it) and confirm:
  warning logs at 50/75/80, a danger toast, a notification-center entry, and that further
  sends are silently skipped (no crash).

---

## 6. Consent-screen production flip

While the consent screen is in **Testing** status, Google expires refresh tokens after
**7 days** (you re-login both accounts weekly). Flipping to **In production** removes the
expiry but shows an "unverified app" warning screen for non-test users unless the app passes
Google's verification (not worth it for a personal 2-user app).

Steps (only after the integration is stable):

1. <https://console.cloud.google.com/apis/credentials/consent>
2. **Publish app** → confirm the "unverified app" warning is acceptable.
3. Remove the two test users (no longer needed once published).
4. Re-login both accounts once so the new (non-expiring) refresh tokens are stored.
5. Confirm the 7-day expiry no longer applies.

---

## 7. Known limitations / follow-ups

- **Relay marker** — the frontend tags relayed copies by bot-author + `[YT] ` prefix. A
  fully-authoritative relay-side marker isn't feasible because the frontend send fires
  before the relay's chat handler runs (see `chat-messages.service.js`). A bot-authored
  command response that happens to start with `[YT] ` would still be exempted from hiding.
- **Viewers page filter** — now server-side (WS-11); the client-side filter remains as a
  belt-and-suspenders fallback.
- **Polls** — YouTube live polls are on the roadmap, not built.
- **Cross-platform identity merge** — a YouTube viewer and a Twitch viewer are distinct
  records; no auto-merge (decision D14).
- **Category/game** — YouTube has no category metadata mapping yet; category stays
  Twitch-only (decision D11).
