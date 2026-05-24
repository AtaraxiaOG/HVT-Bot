require('dotenv').config();
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily kit')
]
.map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');

    await rest.put(
      Routes.applicationGuildCommands(
        '1507905735013568532',
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log('Commands registered.');
  } catch (error) {
    console.error(error);
  }
})();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  console.log(`[Discord Chat] ${message.author.username}: ${message.content}`);

  // Future Palworld relay goes here
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'link') {
    const steamid = interaction.options.getString('steamid');

    const links = loadLinks();

    links[interaction.user.id] = steamid;

    saveLinks(links);

    await interaction.reply({
      content: `Linked SteamID ${steamid} successfully.`,
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
      content: 'Daily kit granted in game.',
      ephemeral: true
    });

    console.log(`Give daily kit to ${steamid}`);

    // RCON reward command goes here
  }
});

client.login(process.env.DISCORD_TOKEN);