import 'dotenv/config';
import { startServer } from './server.js';
import { startBot } from './bot.js';

process.on('unhandledRejection', (e) => console.error('[error]', e));

startServer();
startBot();
