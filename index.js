require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST
} = require('discord.js');

const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const linkedUsersFile = './linkedUsers.json';

function loadLinks() {
  if (!fs.existsSync(linkedUsersFile)) {
    fs.writeFileSync(linkedUsersFile, '{}');
  }

  return JSON.parse(fs.readFileSync(linkedUsersFile));
}

function saveLinks(data) {
  fs.writeFileSync(linkedUsersFile, JSON.stringify(data, null, 2));
}

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

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'link') {
    const steamid = interaction.options.getString('steamid');

    const links = loadLinks();

    links[interaction.user.id] = steamid;

    saveLinks(links);

    await interaction.reply({
      content: `Successfully linked SteamID: ${steamid}`,
      ephemeral: true
    });
  }

  if (interaction.commandName === 'daily') {
    const links = loadLinks();

    const steamid = links[interaction.user.id];

    if (!steamid) {
      return interaction.reply({
        content: 'You must link your account first using /link',
        ephemeral: true
      });
    }

    await interaction.reply({
      content: 'Daily reward claimed successfully.',
      ephemeral: true
    });

    console.log(`Daily reward granted to ${steamid}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
