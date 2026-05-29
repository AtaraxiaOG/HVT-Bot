require('dotenv').config();

const { Rcon } = require('rcon-client');

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// =========================
// CONFIG
// =========================
const DB_PATH = process.env.PALBOT_DB_PATH || '/data/hvt-bot.sqlite';
const LINK_APPROVAL_REQUIRED =
  String(process.env.LINK_APPROVAL_REQUIRED || 'true').toLowerCase() === 'true';

const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID || '';
const DAILY_TIMEZONE = process.env.DAILY_TIMEZONE || 'UTC';

// In-memory choices for active /link dropdowns.
// This does not need to persist because it is only used during the short linking interaction.
const pendingChoices = new Map();

// =========================
// DATABASE
// =========================
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS linked_users (
      discord_id TEXT PRIMARY KEY,
      discord_tag TEXT NOT NULL,
      pal_name TEXT NOT NULL,
      player_uid TEXT,
      steam_id TEXT,
      target_id TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      approved_by TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS pending_links (
      id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      discord_tag TEXT NOT NULL,
      pal_name TEXT NOT NULL,
      player_uid TEXT,
      steam_id TEXT,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS daily_claims (
      discord_id TEXT PRIMARY KEY,
      last_claim_date TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  console.log(`SQLite database ready at ${DB_PATH}`);
}

const dbReady = initDb();

async function saveLinkedUser(link, approvedBy = null) {
  await dbRun(
    `
    INSERT INTO linked_users (
      discord_id,
      discord_tag,
      pal_name,
      player_uid,
      steam_id,
      target_id,
      linked_at,
      approved_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      discord_tag = excluded.discord_tag,
      pal_name = excluded.pal_name,
      player_uid = excluded.player_uid,
      steam_id = excluded.steam_id,
      target_id = excluded.target_id,
      linked_at = excluded.linked_at,
      approved_by = excluded.approved_by
    `,
    [
      link.discordId,
      link.discordTag,
      link.palName,
      link.playerUid || '',
      link.steamId || '',
      link.targetId,
      new Date().toISOString(),
      approvedBy
    ]
  );
}

// =========================
// RCON
// =========================
let rcon;

async function connectRcon() {
  try {
    console.log('Attempting RCON connection...');

    rcon = await Rcon.connect({
      host: process.env.PALWORLD_RCON_IP,
      port: parseInt(process.env.PALWORLD_RCON_PORT, 10),
      password: process.env.PALWORLD_RCON_PASSWORD
    });

    console.log('Connected to Palworld RCON');
    return true;
  } catch (err) {
    console.error('RCON Connection Failed:', err);
    rcon = null;
    return false;
  }
}

async function sendRconCommand(command) {
  try {
    if (!rcon || !rcon.authenticated) {
      console.log('RCON disconnected. Reconnecting...');

      const connected = await connectRcon();

      if (!connected) {
        throw new Error('Could not connect to RCON.');
      }
    }

    const response = await rcon.send(command);
    return response || '';
  } catch (err) {
    console.error('RCON command failed:', err);
    rcon = null;
    throw err;
  }
}

connectRcon();

// =========================
// PALWORLD PLAYER PARSING
// =========================
function parseShowPlayers(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const players = [];

  for (const line of lines) {
    // Palworld ShowPlayers commonly returns CSV-style output:
    // name,playeruid,steamid
    const parts = line.split(',').map(part => part.trim());

    if (parts.length < 2) continue;

    const first = parts[0].toLowerCase();

    if (
      first === 'name' ||
      first === 'playername' ||
      first.includes('player name')
    ) {
      continue;
    }

    const palName = parts[0];
    const playerUid = parts[1] || '';
    const steamIdRaw = parts[2] || '';

    const steamId =
      steamIdRaw &&
      !['0', 'none', 'null', 'undefined', '-'].includes(steamIdRaw.toLowerCase())
        ? steamIdRaw
        : '';

    // For Steam players, use SteamID if available.
    // For Xbox/Game Pass/console players, use PlayerUID.
    const targetId = steamId || playerUid;

    if (!palName || !targetId) continue;

    players.push({
      palName,
      playerUid,
      steamId,
      targetId
    });
  }

  return players.slice(0, 25);
}

function getTodayString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_TIMEZONE
  }).format(new Date());
}

// =========================
// DISCORD CLIENT
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =========================
// SLASH COMMANDS
// =========================
const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your online Palworld character'),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink your Palworld character'),

  new SlashCommandBuilder()
    .setName('whoami')
    .setDescription('Check your linked Palworld character'),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily Palworld reward')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log('Slash commands registered.');
  } catch (error) {
    console.error(error);
  }
})();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// =========================
// DISCORD → PALWORLD CHAT
// =========================
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.channel.id !== process.env.CHANNEL_ID) return;

  try {
    await sendRconCommand(
      `Broadcast [Discord]_${message.author.username}:_${message.content.replace(/\s+/g, '_')}`
    );

    console.log(`[Discord Relay] ${message.author.username}: ${message.content}`);
  } catch (err) {
    console.log('Failed to send Discord message to Palworld.');
  }
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async interaction => {
  await dbReady;

  // =========================
  // SLASH COMMANDS
  // =========================
  if (interaction.isChatInputCommand()) {
    // -------------------------
    // /link
    // -------------------------
    if (interaction.commandName === 'link') {
      await interaction.deferReply({ ephemeral: true });

      let output;

      try {
        output = await sendRconCommand('ShowPlayers');
      } catch (err) {
        return interaction.editReply(
          'I could not reach Palworld RCON. Check your Railway RCON variables and make sure the server is online.'
        );
      }

      const players = parseShowPlayers(output);

      if (players.length === 0) {
        return interaction.editReply(
          `I reached RCON, but I could not find any online players.\n\nRaw ShowPlayers response:\n\`\`\`\n${String(output).slice(0, 1500)}\n\`\`\``
        );
      }

      pendingChoices.set(interaction.user.id, players);

      const select = new StringSelectMenuBuilder()
        .setCustomId(`link_select:${interaction.user.id}`)
        .setPlaceholder('Choose your Palworld character')
        .addOptions(
          players.map((player, index) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(player.palName.slice(0, 100))
              .setDescription(`ID: ${player.targetId}`.slice(0, 100))
              .setValue(String(index))
          )
        );

      const row = new ActionRowBuilder().addComponents(select);

      return interaction.editReply({
        content:
          'Choose the Palworld character you are currently online as.\n\nConsole players can do this from Discord on their phone. No in-game typing needed.',
        components: [row]
      });
    }

    // -------------------------
    // /unlink
    // -------------------------
    if (interaction.commandName === 'unlink') {
      await dbRun(
        `DELETE FROM linked_users WHERE discord_id = ?`,
        [interaction.user.id]
      );

      return interaction.reply({
        content: 'Your Palworld link has been removed.',
        ephemeral: true
      });
    }

    // -------------------------
    // /whoami
    // -------------------------
    if (interaction.commandName === 'whoami') {
      const link = await dbGet(
        `SELECT * FROM linked_users WHERE discord_id = ?`,
        [interaction.user.id]
      );

      if (!link) {
        return interaction.reply({
          content: 'You are not linked yet. Use `/link` while your character is online.',
          ephemeral: true
        });
      }

      return interaction.reply({
        content:
          `You are linked to **${link.pal_name}**.\n` +
          `Target ID: \`${link.target_id}\``,
        ephemeral: true
      });
    }

    // -------------------------
    // /daily
    // -------------------------
    if (interaction.commandName === 'daily') {
      await interaction.deferReply({ ephemeral: true });

      const link = await dbGet(
        `SELECT * FROM linked_users WHERE discord_id = ?`,
        [interaction.user.id]
      );

      if (!link) {
        return interaction.editReply(
          'You must link first using `/link` while your Palworld character is online.'
        );
      }

      const today = getTodayString();

      const claim = await dbGet(
        `SELECT * FROM daily_claims WHERE discord_id = ?`,
        [interaction.user.id]
      );

      if (claim && claim.last_claim_date === today) {
        return interaction.editReply(
          'You already claimed your daily reward today.'
        );
      }

      try {
        // Keep these if your mod/server supports Give commands.
        // If RewardsEngine uses different commands, replace these two lines.
        await sendRconCommand(`Give ${link.target_id} PalSphere 50`);
        await sendRconCommand(`Give ${link.target_id} Money 10000`);

        await dbRun(
          `
          INSERT INTO daily_claims (
            discord_id,
            last_claim_date,
            updated_at
          )
          VALUES (?, ?, ?)
          ON CONFLICT(discord_id) DO UPDATE SET
            last_claim_date = excluded.last_claim_date,
            updated_at = excluded.updated_at
          `,
          [interaction.user.id, today, new Date().toISOString()]
        );

        return interaction.editReply(
          `Daily reward claimed for **${link.pal_name}**.`
        );
      } catch (err) {
        console.error('Failed to give daily reward:', err);

        return interaction.editReply(
          'Failed to claim reward. RCON connected, but the reward command may have failed. Check Railway logs.'
        );
      }
    }
  }

  // =========================
  // LINK DROPDOWN
  // =========================
  if (interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith('link_select:')) return;

    const ownerId = interaction.customId.split(':')[1];

    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: 'This link menu is not for you.',
        ephemeral: true
      });
    }

    const choices = pendingChoices.get(interaction.user.id) || [];
    const selectedIndex = Number(interaction.values[0]);
    const selected = choices[selectedIndex];

    if (!selected) {
      return interaction.update({
        content: 'That link selection expired. Run `/link` again.',
        components: []
      });
    }

    const linkData = {
      discordId: interaction.user.id,
      discordTag: interaction.user.tag,
      palName: selected.palName,
      playerUid: selected.playerUid,
      steamId: selected.steamId,
      targetId: selected.targetId
    };

    pendingChoices.delete(interaction.user.id);

    if (LINK_APPROVAL_REQUIRED) {
      if (!APPROVAL_CHANNEL_ID) {
        return interaction.update({
          content:
            'Link approval is enabled, but APPROVAL_CHANNEL_ID is missing in Railway variables.',
          components: []
        });
      }

      const pendingId = `${Date.now()}_${interaction.user.id}`;

      await dbRun(
        `
        INSERT INTO pending_links (
          id,
          discord_id,
          discord_tag,
          pal_name,
          player_uid,
          steam_id,
          target_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          pendingId,
          linkData.discordId,
          linkData.discordTag,
          linkData.palName,
          linkData.playerUid || '',
          linkData.steamId || '',
          linkData.targetId,
          new Date().toISOString()
        ]
      );

      const approveButton = new ButtonBuilder()
        .setCustomId(`approve_link:${pendingId}`)
        .setLabel('Approve Link')
        .setStyle(ButtonStyle.Success);

      const denyButton = new ButtonBuilder()
        .setCustomId(`deny_link:${pendingId}`)
        .setLabel('Deny Link')
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder().addComponents(
        approveButton,
        denyButton
      );

      const approvalChannel = await client.channels.fetch(APPROVAL_CHANNEL_ID);

      await approvalChannel.send({
        content:
          `New Palworld link request:\n\n` +
          `Discord: <@${linkData.discordId}> / ${linkData.discordTag}\n` +
          `Palworld Name: **${linkData.palName}**\n` +
          `Target ID: \`${linkData.targetId}\`\n\n` +
          `Approve only if this Discord user really owns this character.`,
        components: [row]
      });

      return interaction.update({
        content:
          `Your link request for **${linkData.palName}** was sent to staff for approval.`,
        components: []
      });
    }

    await saveLinkedUser(linkData, 'auto-approved');

    return interaction.update({
      content:
        `Successfully linked your Discord to **${linkData.palName}**.\nTarget ID: \`${linkData.targetId}\``,
      components: []
    });
  }

  // =========================
  // APPROVE / DENY BUTTONS
  // =========================
  if (interaction.isButton()) {
    const [action, pendingId] = interaction.customId.split(':');

    if (!['approve_link', 'deny_link'].includes(action)) return;

    const pending = await dbGet(
      `SELECT * FROM pending_links WHERE id = ?`,
      [pendingId]
    );

    if (!pending) {
      return interaction.reply({
        content: 'This link request no longer exists or was already handled.',
        ephemeral: true
      });
    }

    if (action === 'deny_link') {
      await dbRun(
        `DELETE FROM pending_links WHERE id = ?`,
        [pendingId]
      );

      return interaction.update({
        content:
          `Denied link request for <@${pending.discord_id}> → **${pending.pal_name}**.`,
        components: []
      });
    }

    await saveLinkedUser(
      {
        discordId: pending.discord_id,
        discordTag: pending.discord_tag,
        palName: pending.pal_name,
        playerUid: pending.player_uid,
        steamId: pending.steam_id,
        targetId: pending.target_id
      },
      interaction.user.id
    );

    await dbRun(
      `DELETE FROM pending_links WHERE id = ?`,
      [pendingId]
    );

    return interaction.update({
      content:
        `Approved link: <@${pending.discord_id}> → **${pending.pal_name}**.\nTarget ID: \`${pending.target_id}\``,
      components: []
    });
  }
});

// =========================
// LOGIN BOT
// =========================
client.login(process.env.DISCORD_TOKEN);
