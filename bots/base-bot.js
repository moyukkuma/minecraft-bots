const mineflayer = require('mineflayer');
const config = require('../config');
const logger = require('../utils/logger');

const RECONNECT_DELAY_MS = 5000;

class BaseBot {
  constructor(jobName) {
    this.jobName = jobName;
    this.bot = null;
    this.running = false;
    this._reconnecting = false;
  }

  // サブクラスでオーバーライドして職業固有の初期化を行う
  onSpawn() {}

  // サブクラスでオーバーライドして職業固有の作業を開始する
  startJob() {}

  // サブクラスでオーバーライドして職業固有の作業を停止する
  stopJob() {}

  // サブクラスでオーバーライドしてステータス文字列を返す
  getStatus() {
    return `職業: ${this.jobName} | 状態: ${this.running ? '作業中' : '停止中'}`;
  }

  connect(overrides = {}) {
    const opts = { ...config, ...overrides };
    logger.info(this.jobName, `${opts.host}:${opts.port} に接続中... (username: ${opts.username})`);

    this.bot = mineflayer.createBot(opts);

    this.bot.once('spawn', () => {
      logger.info(this.jobName, 'スポーン完了');
      this._reconnecting = false;
      this._registerChatCommands();
      this.onSpawn();
    });

    this.bot.on('kicked', (reason) => {
      logger.warn(this.jobName, `キックされました: ${reason}`);
      this._scheduleReconnect(opts, overrides);
    });

    this.bot.on('error', (err) => {
      logger.error(this.jobName, `エラー: ${err.message}`);
    });

    this.bot.on('end', (reason) => {
      logger.warn(this.jobName, `接続終了: ${reason}`);
      if (!this._reconnecting) {
        this._scheduleReconnect(opts, overrides);
      }
    });
  }

  _scheduleReconnect(opts, overrides) {
    if (this._reconnecting) return;
    this._reconnecting = true;
    this.running = false;
    this.stopJob();
    logger.info(this.jobName, `${RECONNECT_DELAY_MS / 1000}秒後に再接続します...`);
    setTimeout(() => this.connect(overrides), RECONNECT_DELAY_MS);
  }

  _registerChatCommands() {
    this.bot.on('chat', (username, message) => {
      if (username === this.bot.username) return;

      switch (message.trim()) {
        case '!start':
          if (this.running) {
            this.bot.chat('すでに作業中です。');
          } else {
            this.bot.chat('作業を開始します！');
            this.startJob();
          }
          break;

        case '!stop':
          if (!this.running) {
            this.bot.chat('すでに停止中です。');
          } else {
            this.stopJob();
            this.bot.chat('作業を停止しました。');
          }
          break;

        case '!status':
          this.bot.chat(this.getStatus());
          break;
      }
    });
  }
}

module.exports = BaseBot;
