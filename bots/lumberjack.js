const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const BaseBot = require('./base-bot');
const logger = require('../utils/logger');

const LOG_TYPES = [
  'oak_log', 'birch_log', 'spruce_log',
  'jungle_log', 'acacia_log', 'dark_oak_log',
];

const SEARCH_RADIUS = 32;
const RETRY_DELAY_MS = 30000;
const INVENTORY_FULL_THRESHOLD = 36; // インベントリスロット数

class LumberjackBot extends BaseBot {
  constructor() {
    super('LumberjackBot');
    this.chopCount = 0;
    this._loopTimer = null;
  }

  onSpawn() {
    this.bot.loadPlugin(pathfinder);
    this.mcData = require('minecraft-data')(this.bot.version);
    this._movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(this._movements);

    logger.info(this.jobName, '準備完了。自動で作業を開始します。');
    this.bot.chat('木こりBotが起動しました！自動で作業を開始します。');
    this.startJob();
  }

  startJob() {
    this.running = true;
    this._chopLoop();
  }

  stopJob() {
    this.running = false;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = null;
    }
    // 移動中なら停止
    if (this.bot && this.bot.pathfinder) {
      this.bot.pathfinder.stop();
    }
  }

  getStatus() {
    return `職業: 木こり | 状態: ${this.running ? '作業中' : '停止中'} | 伐採数: ${this.chopCount}本`;
  }

  async _chopLoop() {
    if (!this.running) return;

    // インベントリ満杯チェック
    const usedSlots = this.bot.inventory.items().length;
    if (usedSlots >= INVENTORY_FULL_THRESHOLD) {
      logger.warn(this.jobName, 'インベントリが満杯です。作業を一時停止します。');
      this.bot.chat('インベントリが満杯です！アイテムを整理してから !start で再開してください。');
      this.running = false;
      return;
    }

    const tree = this._findNearestLog();
    if (!tree) {
      logger.info(this.jobName, `周囲${SEARCH_RADIUS}ブロック以内に木が見つかりません。${RETRY_DELAY_MS / 1000}秒後に再探索します。`);
      this.bot.chat(`木が見つかりません。${RETRY_DELAY_MS / 1000}秒後に再探索します。`);
      this._loopTimer = setTimeout(() => this._chopLoop(), RETRY_DELAY_MS);
      return;
    }

    try {
      await this._chopTree(tree);
      await this._collectDrops();
    } catch (err) {
      logger.error(this.jobName, `伐採中にエラーが発生しました: ${err.message}`);
    }

    if (this.running) {
      // 少し待機してから次のループへ
      this._loopTimer = setTimeout(() => this._chopLoop(), 500);
    }
  }

  _findNearestLog() {
    const mcData = this.mcData;
    let nearest = null;
    let minDist = Infinity;

    for (const logName of LOG_TYPES) {
      const blockType = mcData.blocksByName[logName];
      if (!blockType) continue;

      const blocks = this.bot.findBlocks({
        matching: blockType.id,
        maxDistance: SEARCH_RADIUS,
        count: 10,
      });

      for (const pos of blocks) {
        const dist = this.bot.entity.position.distanceTo(pos);
        if (dist < minDist) {
          minDist = dist;
          nearest = this.bot.blockAt(pos);
        }
      }
    }

    return nearest;
  }

  async _chopTree(rootBlock) {
    // 木の根元を特定（同じX・Z座標で最も低いY）
    const { x, z } = rootBlock.position;
    let logsToChop = this._getTreeLogs(x, rootBlock.position.y, z, rootBlock.name);

    if (logsToChop.length === 0) {
      logsToChop = [rootBlock];
    }

    logger.info(this.jobName, `木を発見 (${logsToChop.length}ブロック) → 伐採開始`);

    // 根元から上へ順に伐採
    logsToChop.sort((a, b) => a.position.y - b.position.y);

    for (const log of logsToChop) {
      if (!this.running) break;

      // 木に近づく
      await this._moveTo(log.position.x, log.position.y, log.position.z);

      // 最新のブロック状態を取得（すでに壊れていたらスキップ）
      const current = this.bot.blockAt(log.position);
      if (!current || !LOG_TYPES.includes(current.name)) continue;

      await this.bot.dig(current);
      logger.debug(this.jobName, `掘削: ${current.name} @ ${JSON.stringify(log.position)}`);
    }

    this.chopCount++;
    logger.info(this.jobName, `伐採完了 (合計: ${this.chopCount}本)`);
  }

  _getTreeLogs(x, startY, z, logName) {
    const logs = [];
    let y = startY;

    while (y < startY + 20) {
      const block = this.bot.blockAt(new Vec3(x, y, z));
      if (!block || block.name !== logName) break;
      logs.push(block);
      y++;
    }

    return logs;
  }

  async _moveTo(x, y, z) {
    return new Promise((resolve, reject) => {
      const goal = new GoalBlock(x, y, z);
      this.bot.pathfinder.setGoal(goal);

      const onGoalReached = () => {
        cleanup();
        resolve();
      };
      const onPathStopped = () => {
        cleanup();
        resolve(); // 到達できなくても続行
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.bot.pathfinder.removeListener('goal_reached', onGoalReached);
        this.bot.pathfinder.removeListener('path_stopped', onPathStopped);
        this.bot.pathfinder.removeListener('error', onError);
      };

      this.bot.pathfinder.once('goal_reached', onGoalReached);
      this.bot.pathfinder.once('path_stopped', onPathStopped);
      this.bot.pathfinder.once('error', onError);
    });
  }

  async _collectDrops() {
    // 周囲のドロップアイテムを拾う（近づくだけで自動回収）
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

module.exports = LumberjackBot;
