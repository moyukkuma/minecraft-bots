const logger = require('./utils/logger');

const JOBS = {
  lumberjack: './bots/lumberjack',
  // 将来の職業を追加予定
  // miner:      './bots/miner',
  // farmer:     './bots/farmer',
  // combat:     './bots/combat',
};

const jobArg   = process.argv[2] || 'lumberjack';
const countArg = parseInt(process.argv[3]) || 1;
const jobPath  = JOBS[jobArg];

if (!jobPath) {
  logger.error('index', `不明な職業: "${jobArg}"`);
  logger.info('index', `使用可能な職業: ${Object.keys(JOBS).join(', ')}`);
  process.exit(1);
}

if (countArg < 1 || countArg > 20) {
  logger.error('index', `人数は 1〜20 の範囲で指定してください`);
  process.exit(1);
}

logger.info('index', `職業 "${jobArg}" で ${countArg}人 起動します...`);

const BotClass = require(jobPath);
const config   = require('./config');

for (let i = 0; i < countArg; i++) {
  const username = countArg === 1
    ? config.username
    : `${config.username}_${i + 1}`;

  // 同時接続によるキックを防ぐため、1秒ずつずらして接続
  setTimeout(() => {
    logger.info('index', `Bot 起動: ${username}`);
    const bot = new BotClass();
    bot.connect({ username });
  }, i * 1000);
}
