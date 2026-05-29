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
  ButtonStyle,
  PermissionFlagsBits
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

const DAILY_TIMEZONE = process.env.DAILY_TIMEZONE || 'America/Chicago';

// Add this in Railway Variables:
// DAILY_ITEMS=PalSphere:50 GoldCoin:10000
const DAILY_ITEMS = process.env.DAILY_ITEMS || 'PalSphere:50 GoldCoin:10000';

// Discord ephemeral response flag.
// Using 64 avoids the old "ephemeral is deprecated" warning.
const EPHEMERAL = 64;

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

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function columnExists(tableName, columnName) {
  const columns = await dbAll(`PRAGMA table_info(${tableName})`);
  return columns.some(col => col.name === columnName);
}

async function addColumnIfMissing(tableName, columnName, columnSql) {
  const exists = await columnExists(tableName, columnName);

  if (!exists) {
    await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
    console.log(`Added missing column ${columnName} to ${tableName}`);
  }
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS linked_users (
      discord_id TEXT PRIMARY KEY,
      discord_tag TEXT NOT NULL,
      pal_name TEXT NOT NULL,
      player_uid TEXT,
      steam_id TEXT,
      target_id TEXT,
      paldefender_user_id TEXT,
      linked_at TEXT NOT NULL,
      approved_by TEXT
    )
  `);

  await addColumnIfMissing('linked_users', 'target_id', 'target_id TEXT');
  await addColumnIfMissing('linked_users', 'paldefender_user_id', 'paldefender_user_id TEXT');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS pending_links (
      id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      discord_tag TEXT NOT NULL,
      pal_name TEXT NOT NULL,
      player_uid TEXT,
      steam_id TEXT,
      target_id TEXT,
      paldefender_user_id TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await addColumnIfMissing('pending_links', 'target_id', 'target_id TEXT');
  await addColumnIfMissing('pending_links', 'paldefender_user_id', 'paldefender_user_id TEXT');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS daily_claims (
      discord_id TEXT PRIMARY KEY,
      last_claim_date TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await dbRun(`
    UPDATE linked_users
    SET paldefender_user_id = target_id
    WHERE
      (paldefender_user_id IS NULL OR paldefender_user_id = '')
      AND target_id IS NOT NULL
      AND target_id != ''
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
      paldefender_user_id,
      linked_at,
      approved_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      discord_tag = excluded.discord_tag,
      pal_name = excluded.pal_name,
      player_uid = excluded.player_uid,
      steam_id = excluded.steam_id,
      target_id = excluded.target_id,
      paldefender_user_id = excluded.paldefender_user_id,
      linked_at = excluded.linked_at,
      approved_by = excluded.approved_by
    `,
    [
      link.discordId,
      link.discordTag,
      link.palName,
      link.playerUid || '',
      link.steamId || '',
      link.targetId || '',
      link.palDefenderUserId || '',
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

async function sendRconCommand(command, options = {}) {
  const allowTimeout = options.allowTimeout || false;

  try {
    if (!rcon || !rcon.authenticated) {
      console.log('RCON disconnected. Reconnecting...');

      const connected = await connectRcon();

      if (!connected) {
        throw new Error('Could not connect to RCON.');
      }
    }

    console.log(`[RCON COMMAND] ${command}`);

    const response = await rcon.send(command);

    console.log(`[RCON RESPONSE] ${response}`);

    return response || '';
  } catch (err) {
    const message = String(err?.message || err);

    if (allowTimeout && message.toLowerCase().includes('timeout')) {
      console.warn(
        `[RCON TIMEOUT IGNORED] Command was sent, but no response came back: ${command}`
      );

      rcon = null;

      return '';
    }

    console.error('RCON command failed:', err);

    rcon = null;

    throw err;
  }
}

connectRcon();

// =========================
// PALDEFENDER HELPERS
// =========================
function normalizePalDefenderUserId(rawId) {
  let id = String(rawId || '').trim();

  if (!id) return '';

  id = id.replace(/^"|"$/g, '');

  if (/^(steam|gdk)_/i.test(id)) {
    const [prefix, value] = id.split('_');
    return `${prefix.toLowerCase()}_${value}`;
  }

  if (/^765\d{14}$/.test(id)) {
    return `steam_${id}`;
  }

  return id;
}

function getPalDefenderUserIdFromLink(link) {
  if (!link) return '';

  const stored =
    link.paldefender_user_id ||
    link.target_id ||
    link.steam_id ||
    link.player_uid ||
    '';

  return normalizePalDefenderUserId(stored);
}

function looksLikeRconError(response) {
  const text = String(response || '').toLowerCase();

  return (
    text.includes('unknown command') ||
    text.includes('not found') ||
    text.includes('notfound') ||
    text.includes('invalid') ||
    text.includes('failed') ||
    text.includes('error') ||
    text.includes('does not exist') ||
    text.includes('no player') ||
    text.includes('player not')
  );
}

// =========================
// SHOWPLAYERS PARSING
// =========================
function parseShowPlayers(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const players = [];

  for (const line of lines) {
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
    const steamId = parts[2] || '';

    const targetId = steamId || playerUid;
    const palDefenderUserId = normalizePalDefenderUserId(targetId);

    if (!palName || !targetId) continue;

    players.push({
      palName,
      playerUid,
      steamId,
      targetId,
      palDefenderUserId
    });
  }

  return players.slice(0, 25);
}

function getTodayString() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DAILY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const year = parts.find(part => part.type === 'year').value;
  const month = parts.find(part => part.type === 'month').value;
  const day = parts.find(part => part.type === 'day').value;

  return `${year}-${month}-${day}`;
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
    .setDescription('Claim your daily Palworld reward'),

  new SlashCommandBuilder()
    .setName('resetdaily')
    .setDescription('Staff only: reset a user’s daily claim cooldown')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option
        .setName('discord_user')
        .setDescription('The Discord user to reset')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('setpdid')
    .setDescription('Staff only: set a user’s PalDefender UserId manually')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option
        .setName('discord_user')
        .setDescription('The linked Discord user')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('paldefender_userid')
        .setDescription('Example: steam_7656119... or gdk_253...')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('pdtest')
    .setDescription('Staff only: test normal Palworld RCON connection')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

// =========================
// REGISTER SLASH COMMANDS
// =========================
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

  const cleanMessage = message.content
    .replace(/\r?\n/g, ' ')
    .slice(0, 250);

  try {
    await sendRconCommand(
      `Broadcast [Discord] ${message.author.username}: ${cleanMessage}`
    );

    console.log(`[Discord Relay] ${message.author.username}: ${cleanMessage}`);
  } catch (err) {
    console.log('Failed to send Discord message to Palworld.');
  }
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async interaction => {
  await dbReady;

  if (interaction.isChatInputCommand()) {
    // =========================
    // /link
    // =========================
    if (interaction.commandName === 'link') {
      await interaction.deferReply({ flags: EPHEMERAL });

      let output;

      try {
        output = await sendRconCommand('ShowPlayers');
      } catch (err) {
        return interaction.editReply(
          'I could not reach Palworld RCON. Check Railway variables and make sure the Palworld server is online.'
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
              .setDescription(
                `PD ID: ${player.palDefenderUserId || player.targetId}`.slice(0, 100)
              )
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

    // =========================
    // /unlink
    // =========================
    if (interaction.commandName === 'unlink') {
      await dbRun(
        `DELETE FROM linked_users WHERE discord_id = ?`,
        [interaction.user.id]
      );

      await dbRun(
        `DELETE FROM daily_claims WHERE discord_id = ?`,
        [interaction.user.id]
      );

      return interaction.reply({
        content: 'Your Palworld link and daily cooldown have been removed.',
        flags: EPHEMERAL
      });
    }

    // =========================
    // /whoami
    // =========================
    if (interaction.commandName === 'whoami') {
      const link = await dbGet(
        `SELECT * FROM linked_users WHERE discord_id = ?`,
        [interaction.user.id]
      );

      if (!link) {
        return interaction.reply({
          content: 'You are not linked yet. Use `/link` while your character is online.',
          flags: EPHEMERAL
        });
      }

      const palDefenderUserId = getPalDefenderUserIdFromLink(link);

      return interaction.reply({
        content:
          `You are linked to **${link.pal_name}**.\n` +
          `PalDefender UserId: \`${palDefenderUserId || 'missing'}\`\n\n` +
          `If /daily says player not found, staff may need to run /setpdid for your account.`,
        flags: EPHEMERAL
      });
    }

    // =========================
    // /daily
    // =========================
    if (interaction.commandName === 'daily') {
      await interaction.deferReply({ flags: EPHEMERAL });

      const link = await dbGet(
        `SELECT * FROM linked_users WHERE discord_id = ?`,
        [interaction.user.id]
      );

      if (!link) {
        return interaction.editReply(
          'You must link first using `/link` while your Palworld character is online.'
        );
      }

      const palDefenderUserId = getPalDefenderUserIdFromLink(link);

      if (!palDefenderUserId) {
        return interaction.editReply(
          'Your link is missing a PalDefender UserId. Ask staff to use `/setpdid` for your account.'
        );
      }

      const today = getTodayString();

      const claim = await dbGet(
        `SELECT * FROM daily_claims WHERE discord_id = ?`,
        [interaction.user.id]
      );

      if (claim && claim.last_claim_date === today) {
        return interaction.editReply(
          'You already claimed your daily reward today. Staff can reset your cooldown with `/resetdaily`.'
        );
      }

      const dailyItems = String(DAILY_ITEMS || '').trim();

      if (!dailyItems) {
        return interaction.editReply(
          'DAILY_ITEMS is empty in Railway Variables. Add something like `PalSphere:50 GoldCoin:10000`.'
        );
      }

      // DatHost console / RCON does NOT need a slash here.
      const command = `giveitems ${palDefenderUserId} ${dailyItems}`;

      let response;

      try {
        response = await sendRconCommand(command, { allowTimeout: true });
      } catch (err) {
        console.error('Failed to give daily reward:', err);

        return interaction.editReply(
          'Failed to claim reward because RCON failed. Check Railway logs.'
        );
      }

      if (response && looksLikeRconError(response)) {
        return interaction.editReply(
          `PalDefender rejected the reward command.\n\n` +
          `Command sent:\n\`${command}\`\n\n` +
          `Response:\n\`\`\`\n${String(response).slice(0, 1500)}\n\`\`\`\n\n` +
          `If this says player not found, staff should run /setpdid with the correct PalDefender UserId.`
        );
      }

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
        `Daily reward claimed for **${link.pal_name}**.\n\n` +
        `Reward: \`${dailyItems}\``
      );
    }

    // =========================
    // /resetdaily
    // =========================
    if (interaction.commandName === 'resetdaily') {
      const targetUser =
        interaction.options.getUser('discord_user') || interaction.user;

      await dbRun(
        `DELETE FROM daily_claims WHERE discord_id = ?`,
        [targetUser.id]
      );

      return interaction.reply({
        content:
          `Daily cooldown reset for ${targetUser}. They can now use /daily again.`,
        flags: EPHEMERAL
      });
    }

    // =========================
    // /setpdid
    // =========================
    if (interaction.commandName === 'setpdid') {
      const targetUser = interaction.options.getUser('discord_user');
      const inputId = interaction.options.getString('paldefender_userid');
      const palDefenderUserId = normalizePalDefenderUserId(inputId);

      const link = await dbGet(
        `SELECT * FROM linked_users WHERE discord_id = ?`,
        [targetUser.id]
      );

      if (!link) {
        return interaction.reply({
          content:
            `${targetUser} is not linked yet. Have them run /link first, then use /setpdid if needed.`,
          flags: EPHEMERAL
        });
      }

      await dbRun(
        `
        UPDATE linked_users
        SET
          paldefender_user_id = ?,
          target_id = ?,
          linked_at = ?
        WHERE discord_id = ?
        `,
        [
          palDefenderUserId,
          palDefenderUserId,
          new Date().toISOString(),
          targetUser.id
        ]
      );

      return interaction.reply({
        content:
          `Updated ${targetUser}'s PalDefender UserId to:\n\`${palDefenderUserId}\``,
        flags: EPHEMERAL
      });
    }

    // =========================
    // /pdtest
    // =========================
    if (interaction.commandName === 'pdtest') {
      await interaction.deferReply({ flags: EPHEMERAL });

      let response;

      try {
        response = await sendRconCommand('Info');
      } catch (err) {
        return interaction.editReply(
          'RCON failed. Check Railway logs and your Palworld RCON settings.'
        );
      }

      return interaction.editReply(
        `RCON test response:\n\`\`\`\n${String(response).slice(0, 1800)}\n\`\`\``
      );
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
        flags: EPHEMERAL
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
      targetId: selected.targetId,
      palDefenderUserId: selected.palDefenderUserId
    };

    pendingChoices.delete(interaction.user.id);

    if (LINK_APPROVAL_REQUIRED) {
      if (!APPROVAL_CHANNEL_ID) {
        return interaction.update({
          content:
            'Link approval is enabled, but APPROVAL_CHANNEL_ID is missing in Railway Variables.',
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
          paldefender_user_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          pendingId,
          linkData.discordId,
          linkData.discordTag,
          linkData.palName,
          linkData.playerUid || '',
          linkData.steamId || '',
          linkData.targetId || '',
          linkData.palDefenderUserId || '',
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

      let approvalChannel;

      try {
        approvalChannel = await client.channels.fetch(APPROVAL_CHANNEL_ID);
      } catch (err) {
        console.error('Could not fetch approval channel:', err);

        return interaction.update({
          content:
            'I could not find the approval channel. Check APPROVAL_CHANNEL_ID in Railway Variables.',
          components: []
        });
      }

      await approvalChannel.send({
        content:
          `New Palworld link request:\n\n` +
          `Discord: <@${linkData.discordId}> / ${linkData.discordTag}\n` +
          `Palworld Name: **${linkData.palName}**\n` +
          `ShowPlayers Target ID: \`${linkData.targetId || 'missing'}\`\n` +
          `PalDefender UserId Guess: \`${linkData.palDefenderUserId || 'missing'}\`\n\n` +
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
        `Successfully linked your Discord to **${linkData.palName}**.\n` +
        `PalDefender UserId: \`${linkData.palDefenderUserId || 'missing'}\``,
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
        flags: EPHEMERAL
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
        targetId: pending.target_id,
        palDefenderUserId: pending.paldefender_user_id || pending.target_id
      },
      interaction.user.id
    );

    await dbRun(
      `DELETE FROM pending_links WHERE id = ?`,
      [pendingId]
    );

    return interaction.update({
      content:
        `Approved link: <@${pending.discord_id}> → **${pending.pal_name}**.\n` +
        `PalDefender UserId: \`${pending.paldefender_user_id || pending.target_id || 'missing'}\``,
      components: []
    });
  }
});

// =========================
// LOGIN BOT
// =========================
client.login(process.env.DISCORD_TOKEN);
