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
  #booked-calls     — Calendly booking feed (read-only)

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
- 5 min untouched → DM Abdellah (setter)
- 10 min → DM Axel (closer)
- 15 min → DM Jacques (founder)
- First reply in the thread clears the SLA clock

### Calendly sync
Point your Calendly webhook at `POST /calendly`:
- `invitee.created` → moves deal to 📅 call-booked, posts to #booked-calls, pings closer
- `invitee.canceled` → flags + pings setter to rebook
- `invitee.no_show` → moves deal back to 🔍 qualifying (not lost), pings setter

### Wins tally
- `/win [deal] [amount]` — logs a close, posts win card, updates leaderboard, moves deal to 🏆 won, posts to #won-handoff
- `/leaderboard` — shows current standings
- `/pipeline` — live stage count across all open deals

## Calendly webhook setup
1. Calendly → Integrations → Webhooks → New webhook
2. URL: `https://your-domain.com/calendly`
3. Events: `invitee.created`, `invitee.canceled`, `invitee.no_show`
4. Copy the signing secret → `CALENDLY_WEBHOOK_SECRET` in `.env`

## Deal stages

| Tag | Stage | Owner | SLA |
|-----|-------|-------|-----|
| 🆕 new | New Lead | Setter | < 5 min |
| 🔍 qualifying | Qualifying | Setter | same day |
| 📅 call-booked | Call Booked | Setter → Closer | T-24h & T-1h reminders |
| 🎯 pitched | Pitched | Closer | follow-up < 24h |
| 🤝 negotiating | Negotiating | Closer | re-touch < 24h |
| 🏆 won | Closed-Won | Closer / Founder | same day → #won-handoff |
| ❌ lost | Closed-Lost | — | reason logged |
| 💤 nurture | Nurture | Setter | weekly sweep |

Nothing reaches `call-booked` until BNDT (Budget, Need, Decision-maker, Timeline) is confirmed.
