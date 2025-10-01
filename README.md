# Bot de Música para Discord

Um bot simples para Discord que reproduz música do YouTube usando Node.js, discord.js e yt-dlp.

## Configuração

1. Crie um bot no Discord em https://discord.com/developers/applications e obtenha o token.
2. Nas configurações do bot, habilite as seguintes intents:
   - Server Members Intent
   - Message Content Intent
3. Em OAuth2 > URL Generator, selecione escopos: bot, applications.commands; e permissões: Send Messages, Use Slash Commands, Connect, Speak.
4. Use a URL gerada para convidar o bot para o seu servidor.
5. Substitua `YOUR_BOT_TOKEN` em `config.js` pelo seu token do bot.
6. Instale as dependências: `npm install`
7. Execute o bot: `node index.js`

## Comandos

Use comandos de barra no Discord:

- `/play query:<URL ou termo de busca>`: Reproduz música de uma URL ou busca no YouTube por um termo.
- `/stop`: Para a música atual e desconecta.
- `/skip quantidade:<número>`: Pula a música atual (ou múltiplas músicas se especificado, padrão: 1).
- `/queue`: Mostra a fila de reprodução atual.

## Notas

- O bot faz streaming de áudio diretamente da URL obtida pelo yt-dlp para início rápido.
- Requer Node.js 16+.