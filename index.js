const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { spawn } = require('child_process');
const config = require('./config');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG = false; // Enable/disable debug messages

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, -1);
}

function debugLog(message) {
  if (DEBUG) console.log(`[${getTimestamp()}] ${message}`);
}

function log(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Setup yt-dlp-wrap with automatic binary detection
const ytDlpBinaryPath = path.join(__dirname, os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let ytDlpWrap;

async function initializeYtDlp() {
  try {
    // Check if binary exists
    if (!fs.existsSync(ytDlpBinaryPath)) {
      log('Baixando yt-dlp binary...');
      await YTDlpWrap.downloadFromGithub(ytDlpBinaryPath);
      log('yt-dlp binary baixado com sucesso.');
    } else {
      log('yt-dlp binary encontrado.');
    }
    ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
  } catch (error) {
    console.error('Erro ao inicializar yt-dlp:', error);
  }
}

initializeYtDlp();

const players = new Map(); // Map to store audio players per guild
const queues = new Map(); // Map to store queues per guild
const connections = new Map(); // Map to store voice connections per guild
const ytDlpProcesses = new Map(); // Map to store current yt-dlp processes per guild
const currentSongs = new Map(); // Map to store current song per guild

const MAX_RETRIES = 3; // Número máximo de tentativas para tocar uma música

function replyWithLog(interaction, message) {
  log(`Respondendo a ${interaction.user.tag} no servidor ${interaction.guild.name}: ${message}`);
  return interaction.reply(message);
}

function editReplyWithLog(interaction, message) {
  log(`Editando resposta para ${interaction.user.tag} no servidor ${interaction.guild.name}: ${message}`);
  return interaction.editReply(message);
}

function followUpWithLog(interaction, message) {
  log(`FollowUp para ${interaction.user.tag} no servidor ${interaction.guild.name}: ${message}`);
  return interaction.followUp(message);
}

async function playSong(details, player, guildId, interaction, isPlaylist, plTitle = null, retryCount = 0, isNextSong = false) {
  try {
    // Kill any existing yt-dlp process for this guild
    const existingProcess = ytDlpProcesses.get(guildId);
    if (existingProcess) {
      existingProcess.kill('SIGTERM');
      ytDlpProcesses.delete(guildId);
    }

    // Get or create voice connection
    let connection = connections.get(guildId);
    if (!connection) {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) {
        console.error('Usuário não está em canal de voz');
        return;
      }
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });
      connections.set(guildId, connection);
      players.set(guildId, player);
    }
    // Always wait for connection to be ready
    await entersState(connection, VoiceConnectionStatus.Ready, 5000);

    const { title, videoUrl, audioUrl, ext } = details;
    if (!audioUrl.startsWith('http')) {
      console.error('URL de áudio inválida recebida do yt-dlp:', audioUrl);
      return;
    }
  let resource;
  // Use yt-dlp with direct URL for streaming (no re-processing, just pipe the audio)
  const ytDlpProcess = spawn(ytDlpBinaryPath, ['-o', '-', audioUrl], { stdio: ['pipe', 'pipe', 'pipe'] });
  ytDlpProcesses.set(guildId, ytDlpProcess);
  ytDlpProcess.on('error', (error) => debugLog('Erro no yt-dlp:', error.message));
  ytDlpProcess.stderr.on('data', (data) => {
    debugLog(`yt-dlp stderr: ${data.toString().trim()}`);
  });
  ytDlpProcess.on('close', (code) => {
    ytDlpProcesses.delete(guildId);
  });
  resource = createAudioResource(ytDlpProcess.stdout, { inputType: StreamType.Arbitrary });
  ytDlpProcess.stdout.on('end', () => debugLog('yt-dlp stdout ended'));
  ytDlpProcess.stdout.on('error', (err) => debugLog(`yt-dlp stdout error: ${err.message}`));
  resource.playStream.on('end', () => debugLog('AudioResource playStream ended'));
  resource.playStream.on('error', (err) => debugLog(`AudioResource playStream error: ${err.message}`));
  log(`Tocando "${title}" no servidor ${interaction.guild.name} solicitado por ${interaction.user.tag}`);
  currentSongs.set(guildId, details);
  client.user.setActivity(`🎵 ${title}`, { type: 'LISTENING' });
  connection.subscribe(player);
  player.stop(); // Ensure clean state
  player.play(resource);
  if (isNextSong) {
    // Next song after skip or natural end
    await interaction.channel.send(`Tocando: **${title}**`);
  } else if (plTitle) {
    // First song in playlist
    await editReplyWithLog(interaction, `Adicionado playlist **${plTitle}** na fila de reprodução`);
    await followUpWithLog(interaction, `Tocando: **${title}**`);
  } else if (!isPlaylist) {
    // Single song
    await editReplyWithLog(interaction, `Tocando: **${title}**`);
  }
  // For subsequent playlist songs, no messages
  } catch (error) {
    console.error('Erro inesperado em playSong:', error.message);
    player.stop();
  }
}

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Tocar música').addStringOption(option => option.setName('query').setDescription('URL ou termo de busca').setRequired(true)),
  new SlashCommandBuilder().setName('stop').setDescription('Parar de tocar música'),
  new SlashCommandBuilder().setName('skip').setDescription('Pular a música atual').addIntegerOption(option => option.setName('quantidade').setDescription('Número de músicas para pular (padrão: 1)').setMinValue(1)),
  new SlashCommandBuilder().setName('queue').setDescription('Mostrar a fila de reprodução atual'),
].map(command => command.toJSON());

function getAudioDetails(url, onEntry) {
  debugLog(`DEBUG: getAudioDetails called with url: ${url}`);
  try {
    if (!ytDlpWrap) {
      console.error('yt-dlp não inicializado');
      onEntry(null, false, null);
      return;
    }

    debugLog('DEBUG: ytDlpWrap available, executing yt-dlp');
    // Use exec() for incremental processing with direct stream URL extraction
    const ytDlpEmitter = ytDlpWrap.exec([
      '-f', 'bestaudio',
      '--print', 'ENTRY=TITLE->%(title)s|||VIDEO_URL->%(webpage_url)s|||AUDIO_URL->%(url)s|||EXT->%(ext)s|||ACODEC->%(acodec)s|||PLAYLIST->%(playlist_title)s',
      url
    ]);
    ytDlpEmitter.ytDlpProcess.stderr.on('data', (data) => {
      if (DEBUG) debugLog(`yt-dlp stderr: ${data.toString().trim()}`);
    });

    debugLog('DEBUG: ytDlpEmitter created, setting up listeners');
    let buffer = '';
    let playlistTitle = null;
    let entriesProcessed = 0;

    ytDlpEmitter.ytDlpProcess.stdout.on('data', (data) => {
      debugLog(`DEBUG: stdout data received: ${data.length} bytes`);
      buffer += data.toString();

      // Process complete lines
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;
        debugLog(`DEBUG: Processing line: "${line.substring(0, 100)}..."`);
        if (!line.startsWith('ENTRY=')) {
          debugLog('DEBUG: Line does not start with ENTRY=, skipping');
          continue;
        }

        debugLog(`DEBUG: Found ENTRY line`);
        const fields = line.replace('ENTRY=', '').split('|||');
        const entry = {};
        fields.forEach(field => {
          const [key, value] = field.split('->', 2);
          if (key && value !== undefined) entry[key] = value;
        });

        const title = entry.TITLE;
        const videoUrl = entry.VIDEO_URL;
        const audioUrl = entry.AUDIO_URL;
        const ext = entry.EXT || 'webm';
        const acodec = entry.ACODEC || 'opus';
        const plTitle = entry.PLAYLIST;

        debugLog(`DEBUG: Parsed - title: "${title?.substring(0, 30)}...", videoUrl length: ${videoUrl?.length}, audioUrl length: ${audioUrl?.length}, plTitle: "${plTitle}"`);

        if (plTitle && !playlistTitle) {
          playlistTitle = plTitle;
        }

        if (title && audioUrl && audioUrl.startsWith('http') && entriesProcessed < 25) {
          entriesProcessed++;
          const isFirst = entriesProcessed === 1;
          debugLog(`DEBUG: Calling onEntry for entry ${entriesProcessed}, isFirst: ${isFirst}`);
          onEntry({ title, videoUrl, audioUrl, ext, acodec }, isFirst, playlistTitle);
        } else {
          debugLog(`DEBUG: Skipping entry - title: ${!!title}, audioUrl: ${!!audioUrl}, urlValid: ${audioUrl?.startsWith('http')}, entriesProcessed: ${entriesProcessed}`);
        }
      }
    });

    ytDlpEmitter.on('close', (code) => {
      debugLog(`DEBUG: ytDlpEmitter closed with code: ${code}, entriesProcessed: ${entriesProcessed}`);
      if (entriesProcessed === 0) {
        onEntry(null, false, null);
      }
    });

    ytDlpEmitter.on('error', (error) => {
      debugLog(`Erro no yt-dlp: ${error.message}`);
      onEntry(null, false, null);
    });
  } catch (error) {
    console.error(`Erro ao executar yt-dlp: ${error.message}`);
    onEntry(null, false, null);
  }
}

client.on('clientReady', async () => {
  log(`Bot logado como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(config.token);

  try {
    log('Atualizando comandos de aplicação (/).');

    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );

    log('Comandos de aplicação (/) recarregados com sucesso.');
  } catch (error) {
    console.error(error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  let extra = '';
  if (commandName === 'play') {
    extra = ` - "${interaction.options.getString('query')}"`;
  }
  if (commandName === 'skip') {
    const count = interaction.options.getInteger('quantidade') || 1;
    extra = count > 1 ? ` - ${count} músicas` : '';
  }
  log(`Comando recebido: /${commandName}${extra} de ${interaction.user.tag} no servidor ${interaction.guild.name}`);


  if (commandName === 'play') {
    await interaction.deferReply();

    const query = interaction.options.getString('query');
    const url = query.startsWith('http') ? query : `ytsearch:${query}`;

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.editReply('Você precisa estar em um canal de voz!');

    let player = players.get(voiceChannel.guild.id);
    if (!player) {
      player = createAudioPlayer();
      players.set(voiceChannel.guild.id, player);
      player.on('error', (error) => {
        console.error('Erro no player de áudio:', error.message);
        player.stop();
      });
    }
    const queue = queues.get(voiceChannel.guild.id) || [];
    queues.set(voiceChannel.guild.id, queue);

    // Set up player idle handler
    player.on('idle', () => {
      // Kill current yt-dlp process when song ends
      const existingProcess = ytDlpProcesses.get(voiceChannel.guild.id);
      if (existingProcess) {
        existingProcess.kill('SIGTERM');
        ytDlpProcesses.delete(voiceChannel.guild.id);
      }

      const currentQueue = queues.get(voiceChannel.guild.id);
      if (currentQueue && currentQueue.length > 0) {
        const next = currentQueue.shift();
        playSong(next, player, voiceChannel.guild.id, interaction, true, null, 0, true);
      } else {
        // Queue empty, clear activity and disconnect after delay
        client.user.setActivity('');
        setTimeout(() => {
          const finalQueue = queues.get(voiceChannel.guild.id);
          if (finalQueue && finalQueue.length === 0) {
            const conn = connections.get(voiceChannel.guild.id);
            if (conn) {
              conn.destroy();
              connections.delete(voiceChannel.guild.id);
              players.delete(voiceChannel.guild.id);
              queues.delete(voiceChannel.guild.id);
            }
          }
        }, 30000); // 30 second delay before disconnect
      }
    });

    let firstHandled = false;
    // Check if URL indicates a playlist (contains 'list=' for YouTube playlists)
    const isPlaylistUrl = query.startsWith('http') && query.includes('list=');
    debugLog(`DEBUG: URL: ${url}, isPlaylistUrl: ${isPlaylistUrl}`);

    getAudioDetails(url, (details, isFirst, plTitle) => {
      debugLog(`DEBUG: getAudioDetails callback - details: ${!!details}, isFirst: ${isFirst}, plTitle: ${plTitle}`);
      if (details === null) {
        if (!firstHandled) {
          if (!isPlaylistUrl) {
            editReplyWithLog(interaction, 'Não consegui obter informações do áudio.');
          }
        }
        return;
      }
      if (isFirst) {
        firstHandled = true;
        if (isPlaylistUrl) {
          // Start playing the first song (messages will be sent after playing starts)
          playSong(details, player, voiceChannel.guild.id, interaction, true, plTitle);
        } else {
          playSong(details, player, voiceChannel.guild.id, interaction, false);
        }
      } else {
        // Add remaining songs to queue silently
        const q = queues.get(voiceChannel.guild.id);
        if (q) q.push(details);
      }
    });
  }

  if (commandName === 'stop') {
    const player = players.get(interaction.guild.id);
    if (player) {
      player.stop();
      queues.set(interaction.guild.id, []);
      currentSongs.delete(interaction.guild.id);
      client.user.setActivity('');
      // Kill any running yt-dlp process
      const existingProcess = ytDlpProcesses.get(interaction.guild.id);
      if (existingProcess) {
        existingProcess.kill('SIGTERM');
        ytDlpProcesses.delete(interaction.guild.id);
      }
      // Disconnect immediately
      const conn = connections.get(interaction.guild.id);
      if (conn) {
        conn.destroy();
        connections.delete(interaction.guild.id);
        players.delete(interaction.guild.id);
        queues.delete(interaction.guild.id);
      }
      await replyWithLog(interaction, 'Parei de tocar e desconectei.');
    } else {
      await replyWithLog(interaction, 'Não estou tocando nada.');
    }
  }

  if (commandName === 'queue') {
    const current = currentSongs.get(interaction.guild.id);
    const queue = queues.get(interaction.guild.id) || [];
    let message = '';
    if (current) {
      message += `**Tocando agora:** ${current.title}\n\n`;
    } else {
      message += 'Não estou tocando nada no momento.\n\n';
    }
    if (queue.length > 0) {
      message += '**Próximas músicas:**\n';
      queue.slice(0, 10).forEach((song, index) => {
        message += `${index + 1}. ${song.title}\n`;
      });
      if (queue.length > 10) {
        message += `... e mais ${queue.length - 10} música(s)`;
      }
    } else {
      message += '**Fila vazia**';
    }
    await replyWithLog(interaction, message);
  }

  if (commandName === 'skip') {
    const count = interaction.options.getInteger('quantidade') || 1;
    const player = players.get(interaction.guild.id);
    const current = currentSongs.get(interaction.guild.id);
    if (player && current) {
      const queue = queues.get(interaction.guild.id) || [];
      const skippedSongs = [];
      skippedSongs.push(current.title);
      // Remove count-1 from queue
      for (let i = 0; i < count - 1; i++) {
        const next = queue.shift();
        if (next) skippedSongs.push(next.title);
      }
      player.stop();
      const message = count === 1 ? `Pulei a música **${current.title}**` : `Pulei ${count} música(s): ${skippedSongs.map(t => `**${t}**`).join(', ')}`;
      await replyWithLog(interaction, message);
    } else {
      await replyWithLog(interaction, 'Não estou tocando nada.');
    }
  }
});

client.login(config.token);