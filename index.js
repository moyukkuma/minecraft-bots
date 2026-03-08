const logger = require('./utils/logger');

const JOBS = {
  lumberjack: './bots/lumberjack',
  // 将来の職業を追加予定
  // miner:      './bots/miner',
  // farmer:     './bots/farmer',
  // combat:     './bots/combat',
};

const jobArg = process.argv[2] || 'lumberjack';
const jobPath = JOBS[jobArg];

if (!jobPath) {
  logger.error('index', `不明な職業: "${jobArg}"`);
  logger.info('index', `使用可能な職業: ${Object.keys(JOBS).join(', ')}`);
  process.exit(1);
}

logger.info('index', `職業 "${jobArg}" で起動します...`);

const BotClass = require(jobPath);
const bot = new BotClass();
bot.connect();
