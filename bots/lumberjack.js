const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const BaseBot = require('./base-bot');
const logger = require('../utils/logger');

const LOG_TYPES = [
  'oak_log', 'birch_log', 'spruce_log',
  'jungle_log', 'acacia_log', 'dark_oak_log',
];

const AXE_PRIORITY = [
  'netherite_axe', 'diamond_axe', 'iron_axe',
  'golden_axe', 'stone_axe', 'wooden_axe',
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
    this._movements.canDig = false; // 移動中に葉などを自動掘削してインベントリが切り替わるのを防ぐ
    this.bot.pathfinder.setMovements(this._movements);

    logger.info(this.jobName, '準備完了。自動で作業を開始します。');
    this.bot.chat('木こりBotが起動しました！自動で作業を開始します。');
    this._equipAxe();
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
    const { x, z } = rootBlock.position;
    const logName = rootBlock.name;

    // 同じX・Z列で最も低いYを根元とする
    let rootY = rootBlock.position.y;
    while (rootY > 0) {
      const below = this.bot.blockAt(new Vec3(x, rootY - 1, z));
      if (!below || below.name !== logName) break;
      rootY--;
    }

    let logsToChop = this._getTreeLogs(x, rootY, z, logName);
    if (logsToChop.length === 0) logsToChop = [rootBlock];

    logger.info(this.jobName, `木を発見 (${logsToChop.length}ブロック) → 伐採開始`);

    // 伐採前に斧を装備
    await this._equipAxe();

    // まず根元に近づく
    await this._moveTo(x, rootY, z);
    this.bot.pathfinder.setGoal(null);

    for (const log of logsToChop) {
      if (!this.running) break;

      // 最新のブロック状態を確認（すでに壊れていたらスキップ）
      const current = this.bot.blockAt(log.position);
      if (!current || !LOG_TYPES.includes(current.name)) continue;

      // リーチ外（4ブロック超）なら近づき直す
      // 下のログを掘った後にスペースができているので上へ登れる
      const dist = this.bot.entity.position.distanceTo(log.position);
      if (dist > 4) {
        await this._moveTo(log.position.x, log.position.y, log.position.z);
        this.bot.pathfinder.setGoal(null);
        await this._equipAxe(); // 移動後に斧を再装備
      }

      // ブロックを向いてから掘る
      await this.bot.lookAt(log.position.offset(0.5, 0.5, 0.5));

      // 再取得（移動中に壊れた可能性）
      const fresh = this.bot.blockAt(log.position);
      if (!fresh || !LOG_TYPES.includes(fresh.name)) continue;

      try {
        await this.bot.dig(fresh);
        logger.debug(this.jobName, `掘削: ${fresh.name} @ ${JSON.stringify(log.position)}`);
      } catch (err) {
        logger.debug(this.jobName, `掘削失敗（スキップ）: ${err.message}`);
      }
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
    return new Promise((resolve) => {
      const goal = new GoalNear(x, y, z, 2); // ブロックから2マス以内に近づく
      this.bot.pathfinder.setGoal(goal);

      const onGoalReached = () => {
        cleanup();
        resolve();
      };
      const onPathUpdate = (result) => {
        if (result.status === 'noPath' || result.status === 'timeout') {
          cleanup();
          resolve(); // 到達できなくても続行
        }
      };

      const cleanup = () => {
        this.bot.removeListener('goal_reached', onGoalReached);
        this.bot.removeListener('path_update', onPathUpdate);
      };

      this.bot.once('goal_reached', onGoalReached);
      this.bot.on('path_update', onPathUpdate);
    });
  }

  async _equipAxe() {
    const axe = AXE_PRIORITY
      .map(name => this.bot.inventory.items().find(i => i.name === name))
      .find(Boolean);
    if (!axe) return;
    const held = this.bot.heldItem;
    if (held && held.name === axe.name) return;
    try {
      await this.bot.equip(axe, 'hand');
      logger.info(this.jobName, `斧を装備: ${axe.name}`);
    } catch (err) {
      logger.debug(this.jobName, `斧の装備失敗: ${err.message}`);
    }
  }

  async _collectDrops() {
    // ドロップアイテムが生成されるまで少し待機
    await new Promise(resolve => setTimeout(resolve, 800));

    // 近くのドロップアイテムを順番に回収
    for (let i = 0; i < 20; i++) {
      const drop = this.bot.nearestEntity(
        e => e.name === 'item' &&
             this.bot.entity.position.distanceTo(e.position) < 16
      );
      if (!drop) break;

      await this._moveTo(drop.position.x, drop.position.y, drop.position.z);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

module.exports = LumberjackBot;
