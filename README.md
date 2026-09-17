# Maison d'Élites — Discord Sales Floor

Speed-to-lead · Setter → Closer · Light automation

## Setup

### 1. Create a Discord Application & Bot
1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy token
3. OAuth2 → URL Generator → scopes: `bot`, `applications.commands` → permissions: `Administrator` (for setup) → open the URL and invite to your server

### 2. Configure environment
```bash
cp .env.example .env
# Fill in DISCORD_TOKEN and DISCORD_GUILD_ID at minimum
```

To get your Guild ID: Discord → Settings → Advanced → enable Developer Mode → right-click your server → Copy Server ID.

### 3. Install dependencies
```bash
npm install
```

### 4. Run the server setup (once)
```bash
npm run setup
```

This creates all 6 categories, 12 channels, the 💼 deals forum with 8 stage tags, and all roles. It prints the channel/role IDs at the end — **paste them into `.env`**.

### 5. Start the bot
```bash
npm run bot
```

---

## Architecture

```
📥 INBOUND          — setter's domain
  #lead-intake      — bot feed (read-only)
  #setter-desk      — Abdellah qualifies and logs

🎯 PIPELINE
  #💼deals          — forum: one post per deal, tags = stages
  #booked-calls     — Cal.com booking feed (read-only)

🔥 FLOOR
  #wins             — closes + leaderboard
  #call-review      — voice: Mirror Close coaching

📚 ARSENAL
  #playbooks        — scripts, objection library, pricing (Founder-locked thread)

🤝 HANDOFF
  #won-handoff      — Closed-Won brief → Slack graduation
```

## Bot features

### Lead capture
- `POST /lead` — webhook endpoint for Whop / form intake
- `/lead` — Discord slash command for manual entry
- Auto-ack fires instantly; deal post created in 💼 deals with 🆕 new tag

### Speed-to-lead ladder
- Cron checks every minute during coverage hours
- 5 min untouched → ping `@Setter` in #setter-desk
- 10 min → ping `@Closer`
- 15 min → ping `@Founder`
- First reply in the thread clears the SLA clock

### Cal.com booking sync (via Google Calendar poll)
No webhook, no public URL — the bot polls your Google Calendar every 60s (`GOOGLE_CALENDAR_POLL_SECONDS`)
and detects Cal.com bookings by their standard "reschedule or cancel" link in the event description
(`https://cal.com/booking/<uid>` — change `CAL_BOOKING_DOMAIN` if you're on a custom domain):
- New booking spotted → moves matching deal to 📅 call-booked (or creates one if none exists), posts to #booked-calls, pings `@Closer`
- Booking disappears from the calendar (cancel/reschedule) → moves deal back to 🔍 qualifying, pings `@Setter` to rebook

**UTM source tracking:** if you add a hidden Cal.com booking question named `utm_source`
(optionally `utm_medium` / `utm_campaign`) pre-filled from your link's query string, the bot
extracts it from the calendar event and shows it on every booking — in #booked-calls and in
the deal's own Source field. See "UTM source setup" below.

### Wins tally
- `/win [deal] [amount]` — logs a close, posts win card, updates leaderboard, moves deal to 🏆 won, posts to #won-handoff
- `/leaderboard` — shows current standings
- `/pipeline` — live stage count across all open deals

## Google Calendar setup (Cal.com bookings)
1. Follow the OAuth steps to get `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Google Cloud Console → OAuth 2.0 Client ID, Desktop app type)
2. Run `npm run gcal-auth` once — log in via the printed URL, paste the code back
3. Set `GOOGLE_CALENDAR_ID` in `.env` to the calendar where Cal.com bookings land
4. `npm run bot` — it prints `[calendar] Primed with N existing Cal.com bookings` on start

## UTM source setup
1. Cal.com → each event type → **Advanced** → **Booking questions** → add a question
2. Name it exactly `utm_source`, type: Text, toggle **Hidden**
3. Repeat for `utm_medium` / `utm_campaign` if you want more than just source
4. Make sure your tracking links use matching query param names, e.g.:
   ```
   https://cal.com/you/discovery-call?utm_source=instagram
   ```
5. Cal.com auto-fills the hidden question from the URL param of the same name — no extra setup needed after that

## Deal stages

| Tag | Stage | Owner | SLA |
|-----|-------|-------|-----|
| 🆕 new | New Lead | Setter | < 5 min |
| 🔍 qualifying | Qualifying | Setter | same day |
| 📅 call-booked | Call Booked | Setter → Closer | detected within 60s of booking |
| 🎯 pitched | Pitched | Closer | follow-up < 24h |
| 🤝 negotiating | Negotiating | Closer | re-touch < 24h |
| 🏆 won | Closed-Won | Closer / Founder | same day → #won-handoff |
| ❌ lost | Closed-Lost | — | reason logged |
| 💤 nurture | Nurture | Setter | weekly sweep |

Nothing reaches `call-booked` until BNDT (Budget, Need, Decision-maker, Timeline) is confirmed.
