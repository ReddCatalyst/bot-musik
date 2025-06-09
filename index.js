require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const ytdlp = require('yt-dlp-exec');
const { REST } = require('@discordjs/rest');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const queue = new Map();

const commands = [
    new SlashCommandBuilder().setName('play').setDescription('Putar lagu dari YouTube').addStringOption(option =>
        option.setName('query').setDescription('Judul lagu atau URL').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Lewati lagu saat ini'),
    new SlashCommandBuilder().setName('pause').setDescription('Jeda lagu'),
    new SlashCommandBuilder().setName('resume').setDescription('Lanjutkan lagu'),
    new SlashCommandBuilder().setName('loop').setDescription('Loop lagu').addStringOption(option =>
        option.setName('mode').setDescription('Mode loop').setRequired(true).addChoices(
            { name: 'off', value: 'off' },
            { name: 'single', value: 'single' },
            { name: 'all', value: 'all' }
        )),
    new SlashCommandBuilder().setName('queue').setDescription('Lihat daftar lagu'),
    new SlashCommandBuilder().setName('help').setDescription('Lihat daftar perintah')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        console.log('📡 Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Slash commands registered.');
    } catch (err) {
        console.error('❌ Gagal register commands:', err);
    }
})();

client.on('ready', () => {
    console.log(`🎵 Bot login sebagai ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guild.id;
    const voiceChannel = interaction.member.voice.channel;

    if (!queue.has(guildId)) {
        queue.set(guildId, {
            songs: [],
            loopMode: 'off',
            connection: null,
            player: null,
            voteSkips: new Set(),
            currentRequester: null,
            disconnectTimeout: null
        });
    }

    const serverQueue = queue.get(guildId);

    async function playNext() {
        const song = serverQueue.songs[0];

        if (!song) {
            if (serverQueue.loopMode === 'all' && serverQueue.loopBackup && serverQueue.loopBackup.length > 0) {
                serverQueue.songs = [...serverQueue.loopBackup];
            } else {
                serverQueue.disconnectTimeout = setTimeout(() => {
                    serverQueue.connection?.destroy();
                    queue.delete(guildId);
                    console.log(`⏳ Bot disconnected from guild ${guildId} karena idle.`);
                }, 300000);
                return;
            }
        }

        if (serverQueue.disconnectTimeout) {
            clearTimeout(serverQueue.disconnectTimeout);
            serverQueue.disconnectTimeout = null;
        }

        const current = serverQueue.songs[0];
        if (!current) return;

        serverQueue.currentRequester = current.requester;
        serverQueue.voteSkips.clear();

        try {
            const stream = ytdlp.exec(current.url, {
                output: '-',
                format: 'bestaudio',
                quiet: true
            });

            const resource = createAudioResource(stream.stdout);
            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });

            player.play(resource);
            serverQueue.player = player;
            serverQueue.connection.subscribe(player);

            player.on(AudioPlayerStatus.Idle, () => {
                if (serverQueue.loopMode === 'single') {
                    playNext().catch(console.error);
                } else {
                    serverQueue.songs.shift();
                    playNext().catch(console.error);
                }
            });

            player.on('error', error => {
                console.error('❌ Error saat memutar:', error);
                serverQueue.songs.shift();
                playNext().catch(console.error);
            });

            try {
                await interaction.followUp(`🎶 Memutar **${current.title}**`);
            } catch {}
        } catch (err) {
            console.error('❌ Gagal memutar lagu:', err);
            serverQueue.songs.shift();
            playNext().catch(console.error);
        }
    }

    if (interaction.commandName === 'play') {
        const query = interaction.options.getString('query');
        if (!voiceChannel) return interaction.reply({ content: '🔇 Kamu harus join voice channel dulu!', ephemeral: true });

        await interaction.deferReply();
        const info = await ytdlp(query, { dumpSingleJson: true, defaultSearch: 'ytsearch', noWarnings: true });

        const url = info.webpage_url;
        const title = info.title;
        serverQueue.songs.push({ url, title, requester: interaction.user.id });
        serverQueue.loopBackup = [...serverQueue.songs];

        if (!serverQueue.connection) {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator
            });
            serverQueue.connection = connection;
            playNext();
        } else {
            interaction.followUp(`✅ Ditambahkan ke queue: **${title}**`);
        }
    } else if (interaction.commandName === 'skip') {
        if (!serverQueue.songs.length) return interaction.reply('❌ Tidak ada lagu yang diputar.');

        const isOwner = serverQueue.currentRequester === interaction.user.id;

        if (isOwner) {
            serverQueue.player?.stop();
            return interaction.reply('⏭️ Lagu dilewati oleh pemilik request.');
        } else {
            serverQueue.voteSkips.add(interaction.user.id);
            const memberCount = voiceChannel.members.filter(m => !m.user.bot).size;
            const votes = serverQueue.voteSkips.size;

            if (votes >= Math.ceil(memberCount / 2)) {
                serverQueue.player?.stop();
                return interaction.reply('⏭️ Lagu dilewati melalui vote.');
            } else {
                return interaction.reply(`🗳️ Vote skip: ${votes}/${Math.ceil(memberCount / 2)} (dibutuhkan)`);
            }
        }
    } else if (interaction.commandName === 'pause') {
        if (serverQueue.player) {
            serverQueue.player.pause();
            return interaction.reply('⏸️ Lagu dijeda.');
        }
    } else if (interaction.commandName === 'resume') {
        if (serverQueue.player) {
            serverQueue.player.unpause();
            return interaction.reply('▶️ Lanjut diputar.');
        }
    } else if (interaction.commandName === 'loop') {
        const mode = interaction.options.getString('mode');
        serverQueue.loopMode = mode;
        return interaction.reply(`🔁 Mode loop diatur ke **${mode}**`);
    } else if (interaction.commandName === 'queue') {
        if (!serverQueue.songs.length) return interaction.reply('📭 Queue kosong.');
        const list = serverQueue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
        return interaction.reply(`📜 Queue saat ini:\n${list}`);
    } else if (interaction.commandName === 'help') {
        return interaction.reply({
            content:
                `📖 **Daftar Perintah**\n` +
                `• /play <judul/url> - Putar lagu\n` +
                `• /skip - Lewati lagu\n` +
                `• /pause - Jeda lagu\n` +
                `• /resume - Lanjutkan\n` +
                `• /loop [off/single/all] - Mode ulang\n` +
                `• /queue - Lihat antrian\n` +
                `• /help - Bantuan\n` +
                `\n⏳ Hanya yang request lagu yang bisa skip langsung, user lain harus voting.`
        });
    }
});

client.login(TOKEN);
