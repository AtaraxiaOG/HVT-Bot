require('dotenv').config();

const { Rcon } = require('rcon-client');

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST
} = require('discord.js');

const fs = require('fs');

// =========================
// RCON VARIABLES
// =========================
let rcon;

// =========================
// CONNECT TO PALWORLD RCON
// =========================
async function connectRcon() {

  try {

    console.log('Attempting RCON connection...');

    rcon = await Rcon.connect({
      host: process.env.PALWORLD_RCON_IP,
      port: parseInt(process.env.PALWORLD_RCON_PORT),
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

// Initial RCON connection
connectRcon();

// =========================
// SAFE RCON COMMAND FUNCTION
// =========================
async function sendRconCommand(command) {

  try {

    // reconnect if disconnected
    if (!rcon || !rcon.authenticated) {

      console.log('RCON disconnected. Reconnecting...');

      const connected = await connectRcon();

      if (!connected) {
        return false;
      }
    }

    await rcon.send(command);

    return true;

  } catch (err) {

    console.error('RCON command failed:', err);

    rcon = null;

    return false;
  }
}

// =========================
// CREATE DISCORD CLIENT
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =========================
// LINKED USERS FILE
// =========================
const linkedUsersFile = './linkedUsers.json';

function loadLinks() {

  if (!fs.existsSync(linkedUsersFile)) {
    fs.writeFileSync(linkedUsersFile, '{}');
  }

  return JSON.parse(fs.readFileSync(linkedUsersFile));
}

function saveLinks(data) {

  fs.writeFileSync(
    linkedUsersFile,
    JSON.stringify(data, null, 2)
  );
}

// =========================
// SLASH COMMANDS
// =========================
const commands = [

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Palworld account')
    .addStringOption(option =>
      option
        .setName('steamid')
        .setDescription('Your SteamID64')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily reward')

].map(command => command.toJSON());

// =========================
// REGISTER SLASH COMMANDS
// =========================
const rest = new REST({ version: '10' })
  .setToken(process.env.DISCORD_TOKEN);

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

// =========================
// BOT READY
// =========================
client.once('clientReady', () => {

  console.log(`Logged in as ${client.user.tag}`);
});

// =========================
// DISCORD → PALWORLD CHAT
// =========================
client.on('messageCreate', async message => {

  if (message.author.bot) return;

  if (message.channel.id !== process.env.CHANNEL_ID) return;

  const success = await sendRconCommand(
    `broadcast [Discord] ${message.author.username}: ${message.content}`
  );

  if (success) {

    console.log(
      `[Discord Relay] ${message.author.username}: ${message.content}`
    );

  } else {

    console.log(
      'Failed to send Discord message to Palworld.'
    );
  }
});

// =========================
// SLASH COMMAND HANDLER
// =========================
client.on('interactionCreate', async interaction => {

  if (!interaction.isChatInputCommand()) return;

  // =========================
  // /LINK COMMAND
  // =========================
  if (interaction.commandName === 'link') {

    const steamid =
      interaction.options.getString('steamid');

    const links = loadLinks();

    links[interaction.user.id] = steamid;

    saveLinks(links);

    await interaction.reply({
      content:
        `Successfully linked SteamID: ${steamid}`,
      ephemeral: true
    });
  }

  // =========================
  // /DAILY COMMAND
  // =========================
  if (interaction.commandName === 'daily') {

    const links = loadLinks();

    const steamid = links[interaction.user.id];

    if (!steamid) {

      return interaction.reply({
        content:
          'You must link your account first using /link',
        ephemeral: true
      });
    }

    try {

      // =========================
      // GIVE DAILY REWARDS
      // =========================

      await sendRconCommand(
        `GiveItem ${steamid} PalSphere 50`
      );

      await sendRconCommand(
        `GiveItem ${steamid} Money 10000`
      );

      console.log(
        `Daily rewards granted to ${steamid}`
      );

      await interaction.reply({
        content:
          'Daily reward claimed successfully.',
        ephemeral: true
      });

    } catch (err) {

      console.error(
        'Failed to give daily reward:',
        err
      );

      await interaction.reply({
        content:
          'Failed to claim reward.',
        ephemeral: true
      });
    }
  }
});

// =========================
// LOGIN BOT
// =========================
client.login(process.env.DISCORD_TOKEN);
