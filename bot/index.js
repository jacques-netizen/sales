/**
 * Maison d'Élites — Sales Floor Bot
 *
 * Four responsibilities:
 *  1. Lead capture → deal post + instant auto-ack
 *  2. Speed-to-lead enforcement (5 / 10 / 15 min escalation ladder)
 *  3. Calendly sync (invitee.created / canceled / no_show)
 *  4. Wins tally (/win command + 🏆 reaction)
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  Routes,
  REST,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
} from 'discord.js';
import express from 'express';
import cron from 'node-cron';
import { DateTime } from 'luxon';
import crypto from 'crypto';
import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────────────────────────

const cfg = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  channels: {
    leadIntake: process.env.CHANNEL_LEAD_INTAKE_ID,
    setterDesk: process.env.CHANNEL_SETTER_DESK_ID,
    dealsForum: process.env.CHANNEL_DEALS_FORUM_ID,
    bookedCalls: process.env.CHANNEL_BOOKED_CALLS_ID,
    wins: process.env.CHANNEL_WINS_ID,
    wonHandoff: process.env.CHANNEL_WON_HANDOFF_ID,
  },
  roles: {
    founder: process.env.ROLE_FOUNDER_ID,
    closer: process.env.ROLE_CLOSER_ID,
    setter: process.env.ROLE_SETTER_ID,
  },
  sla: {
    setter: parseInt(process.env.SLA_PING_SETTER_MIN ?? '5'),
    closer: parseInt(process.env.SLA_PING_CLOSER_MIN ?? '10'),
    founder: parseInt(process.env.SLA_PING_FOUNDER_MIN ?? '15'),
  },
  coverage: {
    start: parseInt(process.env.COVERAGE_START_HOUR ?? '9'),
    end: parseInt(process.env.COVERAGE_END_HOUR ?? '22'),
    tz: process.env.COVERAGE_TIMEZONE ?? 'Europe/Brussels',
  },
  calendlySecret: process.env.CALENDLY_WEBHOOK_SECRET,
  webhookPort: parseInt(process.env.WEBHOOK_PORT ?? '3000'),
};

// ─── In-memory state ─────────────────────────────────────────────────────────
// Tracks open "new" leads awaiting first response
// key: threadId, value: { capturedAt, leadName, escalations: Set }
const newLeads = new Map();

// Wins leaderboard: key: userId, value: { count, totalRevenue }
const leaderboard = new Map();

// ─── Discord client ──────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Coverage hours check ─────────────────────────────────────────────────────

function inCoverage() {
  const now = DateTime.now().setZone(cfg.coverage.tz);
  return now.hour >= cfg.coverage.start && now.hour < cfg.coverage.end;
}

// ─── Deal forum helpers ───────────────────────────────────────────────────────

function dealTemplate({ leadName, source, contact, offerInterest, estDealSize }) {
  return [
    `**Deal:** ${leadName}`,
    `**Source:** ${source}`,
    `**Contact:** ${contact}`,
    `**Offer interest:** ${offerInterest ?? 'TBD'}`,
    `**Est. deal size:** ${estDealSize ?? 'Unknown'}`,
    `**Captured:** ${new Date().toISOString()}`,
    '',
    '─────────────────────────────────',
    '## Setter qualification (the handoff)',
    '- Budget signal:',
    '- Need / what they\'re solving:',
    '- Decision-maker:',
    '- Timeline:',
    '- Notes / rapport / context for the closer:',
    '',
    '─────────────────────────────────',
    'Call summary / objections / next step below ↓',
  ].join('\n');
}

async function getForumTagId(forum, tagName) {
  return forum.availableTags.find((t) => t.name === tagName)?.id;
}

async function createDealPost(forum, data) {
  const newTagId = await getForumTagId(forum, '🆕 new');
  const thread = await forum.threads.create({
    name: data.leadName,
    message: { content: dealTemplate(data) },
    appliedTags: newTagId ? [newTagId] : [],
  });
  return thread;
}

async function moveDealTag(thread, forum, newTagName) {
  const tagId = await getForumTagId(forum, newTagName);
  if (!tagId) return;
  await thread.edit({ appliedTags: [tagId] });
}

// ─── 1. Lead capture ──────────────────────────────────────────────────────────
// External trigger: POST /lead  { leadName, source, contact, offerInterest, estDealSize }
// Also: Discord slash command /lead

async function captureNewLead(data) {
  const guild = await client.guilds.fetch(cfg.guildId);
  const intakeChannel = await guild.channels.fetch(cfg.channels.leadIntake);
  const forum = await guild.channels.fetch(cfg.channels.dealsForum);

  // Post to #lead-intake
  await intakeChannel.send({
    content: [
      `🆕 **New lead captured**`,
      `**Name:** ${data.leadName}`,
      `**Source:** ${data.source}`,
      `**Contact:** ${data.contact}`,
      `**Offer interest:** ${data.offerInterest ?? 'TBD'}`,
      inCoverage()
        ? `⏱️ SLA clock running — <@&${cfg.roles.setter}> respond within ${cfg.sla.setter} min.`
        : `🌙 Outside coverage hours — auto-ack sent, desk picks up when online.`,
    ].join('\n'),
  });

  // Create deal post in forum
  const thread = await createDealPost(forum, data);

  // Fire instant auto-ack (simulated — in production you'd send this via the DM platform API)
  const setterDesk = await guild.channels.fetch(cfg.channels.setterDesk);
  await setterDesk.send({
    content: [
      `📬 **Auto-ack fired** for **${data.leadName}**`,
      `> "Got your message — a teammate will be right with you."`,
      `\nDeal thread: ${thread.url}`,
    ].join('\n'),
  });

  // Register for speed-to-lead tracking (only during coverage)
  if (inCoverage()) {
    newLeads.set(thread.id, {
      leadName: data.leadName,
      capturedAt: Date.now(),
      escalations: new Set(),
      threadUrl: thread.url,
    });
  }

  return thread;
}

// ─── 2. Speed-to-lead escalation ladder ──────────────────────────────────────
// Cron runs every minute and checks unresponded new leads

cron.schedule('* * * * *', async () => {
  if (newLeads.size === 0) return;

  const now = Date.now();
  const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
  if (!guild) return;

  for (const [threadId, lead] of newLeads.entries()) {
    const ageMin = (now - lead.capturedAt) / 60000;

    const checks = [
      { threshold: cfg.sla.founder, level: 'founder', label: `🚨 <@&${cfg.roles.founder}> — lead **${lead.leadName}** untouched for ${cfg.sla.founder} min!` },
      { threshold: cfg.sla.closer, level: 'closer', label: `⚠️ <@&${cfg.roles.closer}> — lead **${lead.leadName}** untouched for ${cfg.sla.closer} min.` },
      { threshold: cfg.sla.setter, level: 'setter', label: `⏰ <@&${cfg.roles.setter}> — new lead **${lead.leadName}** waiting ${cfg.sla.setter} min.` },
    ];

    const setterDesk = await guild.channels.fetch(cfg.channels.setterDesk);
    for (const check of checks) {
      if (ageMin >= check.threshold && !lead.escalations.has(check.level)) {
        lead.escalations.add(check.level);
        await setterDesk.send({
          content: `${check.label}\nDeal: ${lead.threadUrl}`,
          allowedMentions: { roles: [cfg.roles.founder, cfg.roles.closer, cfg.roles.setter] },
        });
      }
    }
  }
});

// Call this when a setter posts in a deal thread to clear it from the watchlist
function markLeadResponded(threadId) {
  newLeads.delete(threadId);
}

// Watch for messages in deal threads — first setter/closer post clears the SLA clock
client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (newLeads.has(message.channelId)) {
    markLeadResponded(message.channelId);
  }
});

// ─── 3. Calendly sync ─────────────────────────────────────────────────────────
// Webhook endpoint receives Calendly events

async function handleCalendlyEvent(event) {
  const guild = await client.guilds.fetch(cfg.guildId);
  const bookedCallsChannel = await guild.channels.fetch(cfg.channels.bookedCalls);
  const forum = await guild.channels.fetch(cfg.channels.dealsForum);
  const setterDesk = await guild.channels.fetch(cfg.channels.setterDesk);

  const type = event.event;
  const payload = event.payload;
  const inviteeName = payload?.invitee?.name ?? 'Unknown';
  const inviteeEmail = payload?.invitee?.email ?? '';
  const startTime = payload?.event?.start_time ?? payload?.scheduled_event?.start_time;
  const eventName = payload?.event_type?.name ?? payload?.event?.name ?? 'Discovery Call';
  const cancelReason = payload?.cancellation?.reason ?? '';
  const rescheduleUrl = payload?.invitee?.reschedule_url ?? '';

  // Try to find the matching deal thread by name (best-effort)
  async function findDealThread(name) {
    const threads = await forum.threads.fetchActive();
    return threads.threads.find((t) =>
      t.name.toLowerCase().includes(name.toLowerCase().split(' ')[0])
    ) ?? null;
  }

  if (type === 'invitee.created') {
    // Move deal to 📅 call-booked
    const thread = await findDealThread(inviteeName);
    if (thread) await moveDealTag(thread, forum, '📅 call-booked');

    await bookedCallsChannel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('📅 Call Booked')
          .addFields(
            { name: 'Lead', value: inviteeName, inline: true },
            { name: 'Email', value: inviteeEmail, inline: true },
            { name: 'Event', value: eventName, inline: true },
            { name: 'Time', value: startTime ? `<t:${Math.floor(new Date(startTime).getTime() / 1000)}:F>` : 'TBD', inline: false },
            { name: 'Deal thread', value: thread ? thread.url : '—', inline: false },
          )
          .setTimestamp(),
      ],
      content: `<@&${cfg.roles.closer}> new call in queue ↑`,
      allowedMentions: { roles: [cfg.roles.closer] },
    });

    // T-24h and T-1h reminders are handled by Calendly's native workflows.
    // The bot registers a note in setter-desk for awareness.
    await setterDesk.send({
      content: `✅ **${inviteeName}** booked. Calendly reminders set for T-24h & T-1h.${thread ? `\nDeal: ${thread.url}` : ''}`,
    });
  }

  if (type === 'invitee.canceled') {
    const thread = await findDealThread(inviteeName);
    await setterDesk.send({
      content: [
        `⚠️ **Booking canceled — ${inviteeName}**`,
        cancelReason ? `Reason: ${cancelReason}` : '',
        rescheduleUrl ? `Reschedule link: ${rescheduleUrl}` : '',
        thread ? `Deal: ${thread.url}` : '',
        `<@&${cfg.roles.setter}> run rebook sequence.`,
      ].filter(Boolean).join('\n'),
      allowedMentions: { roles: [cfg.roles.setter] },
    });
  }

  if (type === 'invitee.no_show') {
    const thread = await findDealThread(inviteeName);
    if (thread) await moveDealTag(thread, forum, '🔍 qualifying'); // back to qualifying, not lost

    await setterDesk.send({
      content: [
        `🚫 **No-show — ${inviteeName}**`,
        `Deal moved back to 🔍 qualifying (not lost).`,
        thread ? `Deal: ${thread.url}` : '',
        `<@&${cfg.roles.setter}> run same-day rebook sequence now.`,
      ].join('\n'),
      allowedMentions: { roles: [cfg.roles.setter] },
    });
  }
}

// ─── 4. Wins tally ───────────────────────────────────────────────────────────

async function postWin({ closerId, dealName, amount, guild }) {
  const winsChannel = await guild.channels.fetch(cfg.channels.wins);

  // Update leaderboard
  const entry = leaderboard.get(closerId) ?? { count: 0, totalRevenue: 0 };
  entry.count += 1;
  entry.totalRevenue += amount;
  leaderboard.set(closerId, entry);

  // Build leaderboard string
  const sorted = [...leaderboard.entries()].sort((a, b) => b[1].totalRevenue - a[1].totalRevenue);
  const lbLines = sorted.map(([uid, stats], i) => `${i + 1}. <@${uid}> — ${stats.count} close${stats.count !== 1 ? 's' : ''} · $${stats.totalRevenue.toLocaleString()}`);

  await winsChannel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🏆 CLOSED')
        .setDescription(`<@${closerId}> closed **${dealName}** for **$${amount.toLocaleString()}**`)
        .addFields({ name: 'Leaderboard', value: lbLines.join('\n') || '—' })
        .setTimestamp(),
    ],
  });
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('lead')
    .setDescription('Manually capture a new inbound lead')
    .addStringOption((o) => o.setName('name').setDescription('Lead / company name').setRequired(true))
    .addStringOption((o) => o.setName('source').setDescription('Source (Whop / IG DM / Referral / Direct)').setRequired(true))
    .addStringOption((o) => o.setName('contact').setDescription('Name + handle').setRequired(true))
    .addStringOption((o) => o.setName('offer').setDescription('Offer interest (clipping / distribution / personal branding)'))
    .addStringOption((o) => o.setName('deal_size').setDescription('Estimated deal size')),

  new SlashCommandBuilder()
    .setName('win')
    .setDescription('Log a close and update the leaderboard')
    .addStringOption((o) => o.setName('deal').setDescription('Deal / lead name').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('Deal value in USD').setRequired(true)),

  new SlashCommandBuilder()
    .setName('pipeline')
    .setDescription('Show a quick summary of open deals by stage'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the current wins leaderboard'),
];

async function registerCommands() {
  const rest = new REST().setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(client.user.id, cfg.guildId), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log('Slash commands registered.');
}

// ─── Interaction handler ──────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'lead') {
    await interaction.deferReply({ ephemeral: true });
    const data = {
      leadName: interaction.options.getString('name'),
      source: interaction.options.getString('source'),
      contact: interaction.options.getString('contact'),
      offerInterest: interaction.options.getString('offer') ?? 'TBD',
      estDealSize: interaction.options.getString('deal_size') ?? 'Unknown',
    };
    const thread = await captureNewLead(data);
    await interaction.editReply(`✅ Lead captured. Deal: ${thread.url}`);
  }

  if (interaction.commandName === 'win') {
    await interaction.deferReply();
    const dealName = interaction.options.getString('deal');
    const amount = interaction.options.getInteger('amount');
    const guild = interaction.guild;

    await postWin({ closerId: interaction.user.id, dealName, amount, guild });

    // Move deal to 🏆 won in forum
    const forum = await guild.channels.fetch(cfg.channels.dealsForum);
    const threads = await forum.threads.fetchActive();
    const thread = threads.threads.find((t) => t.name.toLowerCase().includes(dealName.toLowerCase().split(' ')[0]));
    if (thread) {
      await moveDealTag(thread, forum, '🏆 won');
      // Post to won-handoff
      const wonHandoff = await guild.channels.fetch(cfg.channels.wonHandoff);
      await wonHandoff.send({
        content: [
          `## 🏆 Closed-Won — ${dealName}`,
          `**Closer:** <@${interaction.user.id}>`,
          `**Amount:** $${amount.toLocaleString()}`,
          `**Deal thread:** ${thread.url}`,
          '',
          `Next step: fill in the brief below, then <@&${cfg.roles.founder}> picks up fulfillment handoff.`,
          '',
          '**Onboarding brief:**',
          '- Package / deliverable:',
          '- Key contact + handles:',
          '- Goals / expectations:',
          '- Start date:',
          '- Notes:',
        ].join('\n'),
      });
    }

    await interaction.editReply('🏆 Win logged!');
  }

  if (interaction.commandName === 'pipeline') {
    await interaction.deferReply({ ephemeral: true });
    const forum = await interaction.guild.channels.fetch(cfg.channels.dealsForum);
    const active = await forum.threads.fetchActive();

    const stageCounts = {};
    for (const thread of active.threads.values()) {
      for (const tagId of (thread.appliedTags ?? [])) {
        const tagName = forum.availableTags.find((t) => t.id === tagId)?.name ?? tagId;
        stageCounts[tagName] = (stageCounts[tagName] ?? 0) + 1;
      }
    }

    const lines = Object.entries(stageCounts).map(([stage, count]) => `${stage}: **${count}**`);
    await interaction.editReply(lines.length ? lines.join('\n') : 'No active deals.');
  }

  if (interaction.commandName === 'leaderboard') {
    await interaction.deferReply();
    const sorted = [...leaderboard.entries()].sort((a, b) => b[1].totalRevenue - a[1].totalRevenue);
    if (sorted.length === 0) {
      await interaction.editReply('No wins logged yet. Go close something.');
      return;
    }
    const lines = sorted.map(([uid, stats], i) =>
      `${i + 1}. <@${uid}> — ${stats.count} close${stats.count !== 1 ? 's' : ''} · $${stats.totalRevenue.toLocaleString()}`
    );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle('🏆 Leaderboard')
          .setDescription(lines.join('\n'))
          .setTimestamp(),
      ],
    });
  }
});

// ─── 🏆 reaction on #wins also logs a win ─────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== '🏆') return;
  const msg = reaction.message;
  if (msg.channelId !== cfg.channels.wins) return;

  // Extract amount from message text — format: "$1,234" or "1234"
  const match = msg.content?.match(/\$?([\d,]+)/);
  const amount = match ? parseInt(match[1].replace(/,/g, '')) : 0;
  const guild = msg.guild;
  if (guild && amount > 0) {
    await postWin({ closerId: user.id, dealName: msg.content?.slice(0, 40) ?? 'Deal', amount, guild });
  }
});

// ─── Express webhook server ───────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Calendly webhook signature verification
function verifyCalendlySignature(req) {
  if (!cfg.calendlySecret) return true; // skip if no secret configured
  const sig = req.headers['calendly-webhook-signature'];
  if (!sig) return false;
  const [t, v1] = sig.split(',').reduce((acc, part) => {
    const [k, val] = part.split('=');
    acc[k === 't' ? 0 : 1] = val;
    return acc;
  }, []);
  const expected = crypto.createHmac('sha256', cfg.calendlySecret).update(`${t}.${JSON.stringify(req.body)}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v1 ?? '', 'hex'), Buffer.from(expected, 'hex'));
}

app.post('/calendly', async (req, res) => {
  if (!verifyCalendlySignature(req)) return res.status(401).send('Unauthorized');
  res.sendStatus(200);
  await handleCalendlyEvent(req.body).catch((err) => console.error('Calendly handler error:', err));
});

// Manual lead intake endpoint (for form/Whop webhook)
app.post('/lead', async (req, res) => {
  const { leadName, source, contact, offerInterest, estDealSize } = req.body;
  if (!leadName || !source || !contact) return res.status(400).json({ error: 'leadName, source, contact required' });
  res.sendStatus(202);
  await captureNewLead({ leadName, source, contact, offerInterest, estDealSize }).catch((err) =>
    console.error('Lead capture error:', err)
  );
});

app.get('/health', (_req, res) => res.json({ status: 'ok', leads: newLeads.size }));

// ─── Boot ─────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot ready: ${c.user.tag}`);
  await registerCommands();
  app.listen(cfg.webhookPort, () => console.log(`Webhook server on port ${cfg.webhookPort}`));
});

client.login(cfg.token);
