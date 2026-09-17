/**
 * Maison d'Élites — Discord Server Setup Script
 *
 * Runs once. Generates all categories, channels, the 💼 deals forum + its 8 tags,
 * and roles/permissions. Prints final IDs so you can paste them into .env.
 *
 * Usage:
 *   cp .env.example .env   # fill DISCORD_TOKEN + DISCORD_GUILD_ID
 *   npm run setup
 */

import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import 'dotenv/config';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeCreate(label, fn) {
  try {
    const result = await fn();
    console.log(`  ✓ ${label}`);
    await sleep(300); // avoid rate-limits
    return result;
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`);
    throw err;
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`\nLogged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  console.log(`Guild: ${guild.name}\n`);

  // ── 1. Roles ───────────────────────────────────────────────────────────────
  console.log('─── Roles ───────────────────────────────────────────────');

  const founderRole = await safeCreate('Role: Founder', () =>
    guild.roles.create({
      name: 'Founder',
      color: 0xffd700,
      hoist: true,
      permissions: [PermissionFlagsBits.Administrator],
      reason: 'MDE setup',
    })
  );

  const closerRole = await safeCreate('Role: Closer', () =>
    guild.roles.create({
      name: 'Closer',
      color: 0x5865f2,
      hoist: true,
      reason: 'MDE setup',
    })
  );

  const setterRole = await safeCreate('Role: Setter', () =>
    guild.roles.create({
      name: 'Setter',
      color: 0x57f287,
      hoist: true,
      reason: 'MDE setup',
    })
  );

  const fulfillmentRole = await safeCreate('Role: Fulfillment', () =>
    guild.roles.create({
      name: 'Fulfillment',
      color: 0x95a5a6,
      hoist: false,
      reason: 'MDE setup',
    })
  );

  const botRole = await safeCreate('Role: Bot', () =>
    guild.roles.create({
      name: 'SalesBot',
      color: 0xeb459e,
      hoist: false,
      reason: 'MDE setup',
    })
  );

  const everyoneId = guild.roles.everyone.id;

  // Helper: build permission overwrites for a channel
  // founders: full; closers/setters/fulfillment/bot: configurable; @everyone: denied
  function overwrites({
    founder = ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
    closer = ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
    setter = ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
    fulfillment = null,
    bot = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'],
    readOnly = [], // role ids that only get read
  } = {}) {
    const perms = [
      { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
      { id: founderRole.id, allow: resolvePerms(founder) },
      { id: closerRole.id, allow: resolvePerms(closer) },
      { id: setterRole.id, allow: resolvePerms(setter) },
      { id: botRole.id, allow: resolvePerms(bot) },
    ];
    if (fulfillment) perms.push({ id: fulfillmentRole.id, allow: resolvePerms(fulfillment) });
    for (const id of readOnly) {
      perms.push({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] });
    }
    return perms;
  }

  function resolvePerms(list) {
    if (!list) return [];
    const map = {
      ViewChannel: PermissionFlagsBits.ViewChannel,
      SendMessages: PermissionFlagsBits.SendMessages,
      ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
      ManageMessages: PermissionFlagsBits.ManageMessages,
      ManageThreads: PermissionFlagsBits.ManageThreads,
      CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads,
      SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
      AddReactions: PermissionFlagsBits.AddReactions,
      Connect: PermissionFlagsBits.Connect,
      Speak: PermissionFlagsBits.Speak,
      UseApplicationCommands: PermissionFlagsBits.UseApplicationCommands,
    };
    return list.map((p) => (typeof p === 'string' ? map[p] : p)).filter(Boolean);
  }

  // read-only shorthand
  const RO = ['ViewChannel', 'ReadMessageHistory'];

  // ── 2. Categories & Channels ───────────────────────────────────────────────
  console.log('\n─── 🧭 COMMAND ─────────────────────────────────────────');

  const catCommand = await safeCreate('Category: 🧭 COMMAND', () =>
    guild.channels.create({
      name: '🧭 COMMAND',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }],
      reason: 'MDE setup',
    })
  );

  const chStartHere = await safeCreate('#start-here', () =>
    guild.channels.create({
      name: 'start-here',
      type: ChannelType.GuildText,
      parent: catCommand.id,
      topic: 'Server map, operating principle, role of each channel. Read-only.',
      permissionOverwrites: overwrites({
        founder: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
        closer: RO,
        setter: RO,
        fulfillment: RO,
        bot: RO,
      }),
      reason: 'MDE setup',
    })
  );

  const chAnnouncements = await safeCreate('#announcements', () =>
    guild.channels.create({
      name: 'announcements',
      type: ChannelType.GuildText,
      parent: catCommand.id,
      topic: 'Founder broadcasts. Read-only for team.',
      permissionOverwrites: overwrites({
        founder: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
        closer: RO,
        setter: RO,
        fulfillment: RO,
        bot: RO,
      }),
      reason: 'MDE setup',
    })
  );

  const chDailyIntentions = await safeCreate('#daily-intentions', () =>
    guild.channels.create({
      name: 'daily-intentions',
      type: ChannelType.GuildText,
      parent: catCommand.id,
      topic: 'Morning post: today\'s focus + what\'s at risk of going cold.',
      permissionOverwrites: overwrites({
        closer: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
        setter: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
        fulfillment: null,
        bot: ['ViewChannel', 'ReadMessageHistory'],
      }),
      reason: 'MDE setup',
    })
  );

  console.log('\n─── 📥 INBOUND ─────────────────────────────────────────');

  const catInbound = await safeCreate('Category: 📥 INBOUND', () =>
    guild.channels.create({
      name: '📥 INBOUND',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }],
      reason: 'MDE setup',
    })
  );

  const chLeadIntake = await safeCreate('#lead-intake', () =>
    guild.channels.create({
      name: 'lead-intake',
      type: ChannelType.GuildText,
      parent: catInbound.id,
      topic: 'Bot drops every new inbound lead here. Read-only feed.',
      permissionOverwrites: overwrites({
        founder: ['ViewChannel', 'ReadMessageHistory'],
        closer: RO,
        setter: RO,
        bot: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages', 'AddReactions'],
      }),
      reason: 'MDE setup',
    })
  );

  const chSetterDesk = await safeCreate('#setter-desk', () =>
    guild.channels.create({
      name: 'setter-desk',
      type: ChannelType.GuildText,
      parent: catInbound.id,
      topic: 'Setter works leads, logs qualification notes, flags blockers.',
      permissionOverwrites: overwrites({
        closer: ['ViewChannel', 'ReadMessageHistory'],
        setter: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
      }),
      reason: 'MDE setup',
    })
  );

  console.log('\n─── 🎯 PIPELINE ────────────────────────────────────────');

  const catPipeline = await safeCreate('Category: 🎯 PIPELINE', () =>
    guild.channels.create({
      name: '🎯 PIPELINE',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }],
      reason: 'MDE setup',
    })
  );

  const chDeals = await safeCreate('#💼 deals (forum)', () =>
    guild.channels.create({
      name: '💼deals',
      type: ChannelType.GuildForum,
      parent: catPipeline.id,
      topic: 'One post = one deal. Change the tag to move the stage.',
      availableTags: [
        { name: '🆕 new', moderated: false },
        { name: '🔍 qualifying', moderated: false },
        { name: '📅 call-booked', moderated: false },
        { name: '🎯 pitched', moderated: false },
        { name: '🤝 negotiating', moderated: false },
        { name: '🏆 won', moderated: false },
        { name: '❌ lost', moderated: false },
        { name: '💤 nurture', moderated: false },
      ],
      permissionOverwrites: overwrites({
        founder: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageThreads', 'CreatePublicThreads', 'SendMessagesInThreads', 'ManageMessages'],
        closer: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'SendMessagesInThreads', 'CreatePublicThreads'],
        setter: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'SendMessagesInThreads', 'CreatePublicThreads'],
        bot: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageThreads', 'CreatePublicThreads', 'SendMessagesInThreads', 'ManageMessages', 'AddReactions'],
      }),
      reason: 'MDE setup',
    })
  );

  const chBookedCalls = await safeCreate('#booked-calls', () =>
    guild.channels.create({
      name: 'booked-calls',
      type: ChannelType.GuildText,
      parent: catPipeline.id,
      topic: 'Cal.com bookings land here — the closer\'s call queue. Read-only feed.',
      permissionOverwrites: overwrites({
        closer: RO,
        setter: RO,
        bot: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'],
      }),
      reason: 'MDE setup',
    })
  );

  console.log('\n─── 🔥 FLOOR ───────────────────────────────────────────');

  const catFloor = await safeCreate('Category: 🔥 FLOOR', () =>
    guild.channels.create({
      name: '🔥 FLOOR',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }],
      reason: 'MDE setup',
    })
  );

  const chWins = await safeCreate('#wins', () =>
    guild.channels.create({
      name: 'wins',
      type: ChannelType.GuildText,
      parent: catFloor.id,
      topic: 'Closes posted here, bot tallies the leaderboard. Use /win @deal $amount',
      permissionOverwrites: overwrites({
        closer: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions'],
        setter: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions'],
        bot: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages', 'AddReactions'],
      }),
      reason: 'MDE setup',
    })
  );

  const chCallReview = await safeCreate('#call-review (voice)', () =>
    guild.channels.create({
      name: 'call-review',
      type: ChannelType.GuildVoice,
      parent: catFloor.id,
      permissionOverwrites: overwrites({
        closer: ['ViewChannel', 'Connect', 'Speak', 'ReadMessageHistory'],
        setter: ['ViewChannel', 'Connect', 'Speak', 'ReadMessageHistory'],
        bot: RO,
      }),
      reason: 'MDE setup',
    })
  );

  console.log('\n─── 📚 ARSENAL ─────────────────────────────────────────');

  const catArsenal = await safeCreate('Category: 📚 ARSENAL', () =>
    guild.channels.create({
      name: '📚 ARSENAL',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }],
      reason: 'MDE setup',
    })
  );

  const chPlaybooks = await safeCreate('#playbooks', () =>
    guild.channels.create({
      name: 'playbooks',
      type: ChannelType.GuildText,
      parent: catArsenal.id,
      topic: 'Mirror Close, scripts, qualification checklist, objection library, pricing (Founder-locked thread).',
      permissionOverwrites: overwrites({
        closer: RO,
        setter: RO,
        bot: RO,
      }),
      reason: 'MDE setup',
    })
  );

  console.log('\n─── 🤝 HANDOFF ─────────────────────────────────────────');

  const catHandoff = await safeCreate('Category: 🤝 HANDOFF', () =>
    guild.channels.create({
      name: '🤝 HANDOFF',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }],
      reason: 'MDE setup',
    })
  );

  const chWonHandoff = await safeCreate('#won-handoff', () =>
    guild.channels.create({
      name: 'won-handoff',
      type: ChannelType.GuildText,
      parent: catHandoff.id,
      topic: 'Closed-Won brief → triggers the Slack graduation. Fulfillment read-only.',
      permissionOverwrites: overwrites({
        closer: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
        setter: ['ViewChannel', 'ReadMessageHistory'],
        fulfillment: RO,
        bot: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'],
      }),
      reason: 'MDE setup',
    })
  );

  // ── 3. Pin the server map in #start-here ───────────────────────────────────
  console.log('\n─── Posting server map to #start-here ──────────────────');
  await safeCreate('Server map message', async () => {
    const msg = await chStartHere.send({
      content: [
        '# Maison d\'Élites — Sales Floor',
        '',
        '**Operating principle:** Discord = the engine. Slack = the record.',
        'A lead lives entirely in Discord (capture → qualify → book → call → close) and only graduates to Slack at **Closed-Won**.',
        '',
        '**The single question this server answers at a glance:**',
        '> *"What needs a response in the next 5 minutes, and is anything going cold?"*',
        '',
        '## Channel map',
        '**🧭 COMMAND**',
        '`#start-here` — you\'re here',
        '`#announcements` — founder broadcasts',
        '`#daily-intentions` — AM focus post + what\'s at risk',
        '',
        '**📥 INBOUND (setter\'s domain)**',
        '`#lead-intake` — every new lead (bot feed, read-only)',
        '`#setter-desk` — `@Setter` qualifies, logs, flags',
        '',
        '**🎯 PIPELINE**',
        '`#💼deals` — the heart. One post = one deal. Tags = stages.',
        '`#booked-calls` — Cal.com bookings (read-only feed)',
        '',
        '**🔥 FLOOR**',
        '`#wins` — post closes, leaderboard lives here',
        '`#call-review` — voice: live call breakdowns & Mirror Close coaching',
        '',
        '**📚 ARSENAL**',
        '`#playbooks` — Mirror Close, scripts, objection library, pricing (Founder-locked thread)',
        '',
        '**🤝 HANDOFF**',
        '`#won-handoff` — Closed-Won brief → triggers Slack graduation',
        '',
        '## Roles',
        '`@Founder` — admin, also closes',
        '`@Closer` — pipeline, calls, floor',
        '`@Setter` — inbound, qualify, tag deals',
        '`@Fulfillment` — read-only on #won-handoff only',
        '',
        '## The 5-minute rule',
        'First human touch on any 🆕 new lead in **< 5 minutes** during coverage hours.',
        'Bot fires an instant auto-ack. If 5 min pass → pings `@Setter`. 10 min → `@Closer`. 15 min → `@Founder`.',
      ].join('\n'),
    });
    await msg.pin();
    return msg;
  });

  // ── 4. Print IDs ──────────────────────────────────────────────────────────
  console.log('\n─── IDs (paste into .env) ───────────────────────────────');
  const ids = {
    'ROLE_FOUNDER_ID': founderRole.id,
    'ROLE_CLOSER_ID': closerRole.id,
    'ROLE_SETTER_ID': setterRole.id,
    'ROLE_FULFILLMENT_ID': fulfillmentRole.id,
    'ROLE_BOT_ID': botRole.id,
    'CHANNEL_LEAD_INTAKE_ID': chLeadIntake.id,
    'CHANNEL_SETTER_DESK_ID': chSetterDesk.id,
    'CHANNEL_DEALS_FORUM_ID': chDeals.id,
    'CHANNEL_BOOKED_CALLS_ID': chBookedCalls.id,
    'CHANNEL_WINS_ID': chWins.id,
    'CHANNEL_WON_HANDOFF_ID': chWonHandoff.id,
    'CHANNEL_ANNOUNCEMENTS_ID': chAnnouncements.id,
    'CHANNEL_DAILY_INTENTIONS_ID': chDailyIntentions.id,
    'CHANNEL_PLAYBOOKS_ID': chPlaybooks.id,
  };
  for (const [k, v] of Object.entries(ids)) console.log(`${k}=${v}`);

  console.log('\n✅ Server setup complete. Copy the IDs above into .env, then run: npm run bot');
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
