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

// 足場として使えるブロック（原木を優先 → フォールバックで土・石など）
const SCAFFOLD_NAMES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'dirt', 'cobblestone', 'stone', 'gravel',
  'oak_planks', 'spruce_planks', 'birch_planks',
  'jungle_planks', 'acacia_planks', 'dark_oak_planks',
];

// チェストに預けるアイテム（原木・苗・りんご）
const STORE_ITEM_NAMES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling',
  'apple',
];

// 同プロセス内の全Botで共有するクレーム済み木セット（X,Z で識別）
const claimedTrees = new Set();

class LumberjackBot extends BaseBot {
  constructor() {
    super('LumberjackBot');
    this.chopCount = 0;
    this._loopTimer = null;
    this._placedScaffold = []; // _pillarUp で設置した足場ブロックの座標
  }

  onSpawn() {
    this.bot.loadPlugin(pathfinder);
    this.mcData = require('minecraft-data')(this.bot.version);
    this._movements = new Movements(this.bot);
    this._movements.canDig = true; // 土など軟らかいブロックを掘って登れるようにする
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

    // インベントリ満杯チェック → チェストに預けて空きを作る
    const usedSlots = this.bot.inventory.items().length;
    if (usedSlots >= INVENTORY_FULL_THRESHOLD) {
      logger.warn(this.jobName, 'インベントリが満杯です。チェストに預けます。');
      await this._depositToChest();
      // 預けても満杯なら停止
      if (this.bot.inventory.items().length >= INVENTORY_FULL_THRESHOLD) {
        this.bot.chat('インベントリが満杯です！アイテムを整理してから !start で再開してください。');
        this.running = false;
        return;
      }
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
      await this._depositToChest();
    } catch (err) {
      logger.error(this.jobName, `伐採中にエラーが発生しました: ${err.message}`);
      // エラー時も予約を解放する
      const pos = tree.position;
      claimedTrees.delete(`${pos.x},${pos.z}`);
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
        // 他のBotがすでに担当している木はスキップ
        if (claimedTrees.has(`${pos.x},${pos.z}`)) continue;

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

    // この木を予約（他のBotに取られないよう）
    const treeKey = `${x},${z}`;
    if (claimedTrees.has(treeKey)) return; // 予約済みならスキップ
    claimedTrees.add(treeKey);

    logger.info(this.jobName, `木を発見 (${logsToChop.length}ブロック) → 伐採開始`);

    // 伐採前に斧を装備
    await this._equipAxe();

    // まず根元に近づく
    await this._moveTo(x, rootY, z);
    this.bot.pathfinder.setGoal(null);
    await this._equipAxe(); // 移動中に土等を掘った場合に備えて再装備

    for (const log of logsToChop) {
      if (!this.running) break;

      // 最新のブロック状態を確認（すでに壊れていたらスキップ）
      const current = this.bot.blockAt(log.position);
      if (!current || !LOG_TYPES.includes(current.name)) continue;

      // 眼の位置からブロック中心までの距離でリーチ判定（4.5ブロック）
      const eyePos = this.bot.entity.position.offset(0, 1.62, 0);
      const reachDist = eyePos.distanceTo(log.position.offset(0.5, 0.5, 0.5));
      if (reachDist > 4.5) {
        // まず pathfinder で近づく
        await this._moveTo(log.position.x, log.position.y, log.position.z);
        this.bot.pathfinder.setGoal(null);

        // まだリーチ外なら足場を積んで登る
        const eyePos2 = this.bot.entity.position.offset(0, 1.62, 0);
        const reachDist2 = eyePos2.distanceTo(log.position.offset(0.5, 0.5, 0.5));
        if (reachDist2 > 4.5) {
          await this._pillarUp(log.position.y);
        }

        await this._equipAxe();
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

    // 積み上げた足場を撤去してから予約を解放
    await this._removePillar();
    claimedTrees.delete(treeKey); // 予約を解放
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

  async _moveTo(x, y, z, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const goal = new GoalNear(x, y, z, 2); // ブロックから2マス以内に近づく
      this.bot.pathfinder.setGoal(goal);

      // タイムアウト：経路探索が詰まってもkeepaliveタイムアウト(30s)より前に解放
      // 切断・再接続中にタイマーが発火した場合も安全に処理する
      const timer = setTimeout(() => {
        cleanup();
        if (this.bot && this.bot.pathfinder) {
          this.bot.pathfinder.setGoal(null);
        }
        logger.debug(this.jobName, `移動タイムアウト (${timeoutMs}ms)`);
        resolve();
      }, timeoutMs);

      const onGoalReached = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const onPathUpdate = (result) => {
        if (result.status === 'noPath' || result.status === 'timeout') {
          clearTimeout(timer);
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

  async _pillarUp(targetY) {
    // 足元Y がターゲットのリーチ内に入るまでブロックを積み上げて登る
    while (this.bot.entity.position.y < targetY - 3) {
      const scaffoldItem = SCAFFOLD_NAMES
        .map(n => this.bot.inventory.items().find(i => i.name === n))
        .find(Boolean);

      if (!scaffoldItem) {
        logger.warn(this.jobName, '足場ブロックなし - ピラー登りを中断');
        return;
      }

      await this.bot.equip(scaffoldItem, 'hand');

      // 真下を向く
      await this.bot.look(this.bot.entity.yaw, Math.PI / 2, true);

      // 足元のブロックを取得
      const below = this.bot.blockAt(
        this.bot.entity.position.floored().offset(0, -1, 0)
      );
      if (!below) return;

      // ジャンプしながら足元にブロックを設置
      this.bot.setControlState('jump', true);
      await new Promise(r => setTimeout(r, 250));
      try {
        await this.bot.placeBlock(below, new Vec3(0, 1, 0));
        // 設置した座標を記録（後で _removePillar で撤去する）
        this._placedScaffold.push(below.position.offset(0, 1, 0).clone());
        logger.debug(this.jobName, `足場設置: Y=${Math.floor(this.bot.entity.position.y)}`);
      } catch (_) {}
      this.bot.setControlState('jump', false);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  async _removePillar() {
    if (this._placedScaffold.length === 0) return;
    logger.debug(this.jobName, `足場撤去開始: ${this._placedScaffold.length}ブロック`);

    // 高い順（上から）に掘って落下しながら回収
    const sorted = [...this._placedScaffold].sort((a, b) => b.y - a.y);
    for (const pos of sorted) {
      const block = this.bot.blockAt(pos);
      if (!block || block.name === 'air') continue;
      try {
        await this.bot.lookAt(pos.offset(0.5, 0.5, 0.5));
        await this.bot.dig(block);
        logger.debug(this.jobName, `足場撤去: Y=${pos.y}`);
      } catch (err) {
        logger.debug(this.jobName, `足場撤去失敗（スキップ）: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    this._placedScaffold = [];
  }

  async _equipAxe() {
    let axe = AXE_PRIORITY
      .map(name => this.bot.inventory.items().find(i => i.name === name))
      .find(Boolean);

    if (!axe) {
      // インベントリに斧がない → チェストから取り出す
      logger.info(this.jobName, '斧が見つかりません。チェストから取り出します。');
      await this._retrieveAxeFromChest();
      axe = AXE_PRIORITY
        .map(name => this.bot.inventory.items().find(i => i.name === name))
        .find(Boolean);
      if (!axe) return; // チェストにもなければ諦める
    }

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

  _findNearestChest() {
    const ids = ['chest', 'trapped_chest']
      .map(n => this.mcData.blocksByName[n])
      .filter(Boolean)
      .map(b => b.id);
    if (ids.length === 0) return null;

    const positions = this.bot.findBlocks({ matching: ids, maxDistance: 32, count: 1 });
    if (positions.length === 0) return null;
    return this.bot.blockAt(positions[0]);
  }

  async _depositToChest() {
    const chestBlock = this._findNearestChest();
    if (!chestBlock) {
      logger.warn(this.jobName, 'チェストが見つかりません（預け先なし）');
      return;
    }

    await this._moveTo(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z);

    let chest;
    try {
      chest = await this.bot.openChest(chestBlock);
    } catch (err) {
      logger.warn(this.jobName, `チェストを開けませんでした: ${err.message}`);
      return;
    }

    try {
      for (const itemName of STORE_ITEM_NAMES) {
        const item = this.bot.inventory.items().find(i => i.name === itemName);
        if (!item) continue;
        try {
          await chest.deposit(item.type, null, item.count);
          logger.info(this.jobName, `チェストに預けた: ${item.name} x${item.count}`);
        } catch (err) {
          logger.debug(this.jobName, `預け失敗（スキップ）: ${item.name} - ${err.message}`);
        }
      }
    } finally {
      chest.close();
    }
  }

  async _retrieveAxeFromChest() {
    const chestBlock = this._findNearestChest();
    if (!chestBlock) {
      logger.warn(this.jobName, 'チェストが見つかりません（斧取り出し失敗）');
      return;
    }

    await this._moveTo(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z);

    let chest;
    try {
      chest = await this.bot.openChest(chestBlock);
    } catch (err) {
      logger.warn(this.jobName, `チェストを開けませんでした: ${err.message}`);
      return;
    }

    try {
      for (const axeName of AXE_PRIORITY) {
        const axeInChest = chest.containerItems().find(i => i.name === axeName);
        if (!axeInChest) continue;
        try {
          await chest.withdraw(axeInChest.type, null, 1);
          logger.info(this.jobName, `チェストから斧を取り出した: ${axeName}`);
          break;
        } catch (err) {
          logger.debug(this.jobName, `斧取り出し失敗: ${axeName} - ${err.message}`);
        }
      }
    } finally {
      chest.close();
    }
  }
}

module.exports = LumberjackBot;
