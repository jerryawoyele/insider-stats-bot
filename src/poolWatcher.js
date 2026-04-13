import { config } from "./config.js";
import { logInfo } from "./logger.js";
import { getGmgnHolderCount, getGmgnTokenPrice } from "./gmgn.js";
import { analyzePoolTransaction } from "./parsers.js";
import { appendPoolAnalysisReport, shouldPersistPoolAnalysisReport } from "./reports.js";

function shortWallet(wallet) {
  return wallet ? `${wallet.slice(0, 8)}...` : "unknown";
}

export class PoolWatcher {
  constructor({
    poolAddress,
    label,
    mint,
    configAddress,
    insiderWallets,
    leaderWallets,
    firstTxOnly,
    onComplete
  }) {
    this.poolAddress = poolAddress;
    this.label = label;
    this.mint = mint;
    this.configAddress = configAddress;
    this.onComplete = onComplete;
    this.insiderWalletSet = new Set(insiderWallets);
    this.leaderWalletSet = new Set(leaderWallets || []);
    this.firstTxOnly = Boolean(firstTxOnly);
    this.seenSignatures = new Set();
    this.processedCount = 0;
    this.leaderTxCount = 0;
    this.completed = false;
    this.completionReason = null;
    this.stats = {
      interpretedTxCount: 0,
      totalBuyCount: 0,
      totalSellCount: 0,
      totalBuySol: 0,
      totalSellSol: 0,
      insiderTxCount: 0,
      insiderBuyCount: 0,
      insiderSellCount: 0,
      insiderBuySol: 0,
      insiderSellSol: 0
    };
    this.lastHolderCount = null;
    this.holderSnapshots = [];
    this.lastHolderCheckAt = 0;
    this.priceCheckTimer = null;
    this.initialPrice = null;
    this.latestPrice = null;
    this.lastLoggedPrice = null;
    this.rugDetected = false;
  }

  async start() {
    if (!this.firstTxOnly) {
      await this.refreshPrice({ force: true, markInitial: true });
      this.priceCheckTimer = setInterval(() => {
        this.refreshPrice().catch(() => {});
      }, config.priceCheckIntervalMs);
    }
  }

  async ingestParsedTransaction(tx) {
    if (this.completed || !tx?.signature || this.seenSignatures.has(tx.signature)) {
      return;
    }

    this.seenSignatures.add(tx.signature);
    this.processedCount += 1;

    const activity = analyzePoolTransaction({
      tx,
      poolAddress: this.poolAddress,
      mint: this.mint,
      insiderWalletSet: this.firstTxOnly ? this.leaderWalletSet : this.insiderWalletSet
    });

    if (activity) {
      if (this.firstTxOnly) {
        if (this.leaderWalletSet.has(activity.wallet)) {
          this.leaderTxCount += 1;
          logInfo(
            `[EarlyScore] ${activity.isInsider ? "INSIDER " : ""}${activity.side.toUpperCase()} ${activity.solAmount.toFixed(9)} SOL: ${shortWallet(activity.wallet)} (tx #${this.leaderTxCount})`,
            {
              poolAddress: this.poolAddress,
              signature: tx.signature,
              source: activity.source
            }
          );
          await this.refreshHolderCount({
            force: true,
            txNumberOverride: this.leaderTxCount
          });
          await this.complete("first_leader_tx");
        }
        return;
      }

      this.stats.interpretedTxCount += 1;

      if (activity.side === "buy") {
        this.stats.totalBuyCount += 1;
        this.stats.totalBuySol += activity.solAmount;
      } else if (activity.side === "sell") {
        this.stats.totalSellCount += 1;
        this.stats.totalSellSol += activity.solAmount;
      }

      logInfo(
        `[EarlyScore] ${activity.isInsider ? "INSIDER " : ""}${activity.side.toUpperCase()} ${activity.solAmount.toFixed(9)} SOL: ${shortWallet(activity.wallet)} (tx #${this.processedCount})`,
        {
          poolAddress: this.poolAddress,
          signature: tx.signature,
          source: activity.source
        }
      );
    }

    if (activity?.isInsider) {
      this.stats.insiderTxCount += 1;

      if (activity.side === "buy") {
        this.stats.insiderBuyCount += 1;
        this.stats.insiderBuySol += activity.solAmount;
      } else if (activity.side === "sell") {
        this.stats.insiderSellCount += 1;
        this.stats.insiderSellSol += activity.solAmount;
      }

    }

    if (!this.firstTxOnly) {
      if (
        this.processedCount === 1 ||
        this.processedCount % config.holderCheckEveryTxs === 0 ||
        this.processedCount === config.poolTxTarget
      ) {
        await this.refreshHolderCount({
          force: this.processedCount === 1 || this.processedCount === config.poolTxTarget
        });
      }

      if (this.processedCount >= config.poolTxTarget) {
        await this.complete("target_reached");
      }
    }
  }

  async refreshHolderCount({ force = false, txNumberOverride = null } = {}) {
    const now = Date.now();
    if (!force && now - this.lastHolderCheckAt < config.holderCheckMinIntervalMs) {
      return;
    }

    this.lastHolderCheckAt = now;
    const holderCount = await getGmgnHolderCount(this.mint);
    if (holderCount == null) {
      return;
    }

    this.lastHolderCount = holderCount;
    const snapshot = {
      txNumber: txNumberOverride ?? this.processedCount,
      holderCount
    };
    this.holderSnapshots.push(snapshot);

    logInfo(`[${this.label}] Holder count snapshot`, {
      mint: this.mint,
      poolAddress: this.poolAddress,
      txNumber: snapshot.txNumber,
      holderCount
    });
  }

  async refreshPrice({ force = false, markInitial = false } = {}) {
    if (this.completed && !force) {
      return;
    }

    const price = await getGmgnTokenPrice(this.mint);
    if (price == null) {
      return;
    }

    this.latestPrice = price;

    if (this.initialPrice == null || markInitial) {
      this.initialPrice = price;
      this.lastLoggedPrice = price;
      logInfo(`[${this.label}] Initial price snapshot`, {
        mint: this.mint,
        poolAddress: this.poolAddress,
        initialPrice: price
      });
      return;
    }

    const drawdownRatio = this.initialPrice === 0 ? 0 : price / this.initialPrice;
    const drawdownPercent = Math.max(0, (1 - drawdownRatio) * 100);
    const priceChangePercent =
      this.initialPrice === 0 ? 0 : ((price - this.initialPrice) / this.initialPrice) * 100;
    const shouldLogPriceSnapshot =
      force ||
      this.lastLoggedPrice == null ||
      Math.abs(price - this.lastLoggedPrice) > 0;

    if (shouldLogPriceSnapshot) {
      this.lastLoggedPrice = price;
      logInfo(`[${this.label}] Price snapshot`, {
        mint: this.mint,
        poolAddress: this.poolAddress,
        currentPrice: price,
        initialPrice: this.initialPrice,
        priceChangePercent: Number(priceChangePercent.toFixed(2)),
        drawdownPercent: Number(drawdownPercent.toFixed(2))
      });
    }

    if (drawdownRatio <= 0.1 && this.processedCount > 0) {
      this.rugDetected = true;
      await this.complete("rug_detected");
    }
  }

  async complete(reason) {
    if (this.completed) {
      return;
    }

    this.completed = true;
    this.completionReason = reason;
    this.stop();

    const insiderPercent =
      this.processedCount === 0 ? 0 : (this.stats.insiderTxCount / this.processedCount) * 100;
    const insiderHolderPercent =
      this.lastHolderCount && this.lastHolderCount > 0
        ? (this.insiderWalletSet.size / this.lastHolderCount) * 100
        : null;

    const accept = !this.rugDetected && insiderPercent >= 90;
    const decision = reason === "migration_handoff" ? "handoff" : accept ? "accept" : "reject";
    const summary = {
      poolAddress: this.poolAddress,
      mint: this.mint,
      label: this.label,
      completionReason: reason,
      totalPoolTxs: this.processedCount,
      interpretedTxCount: this.stats.interpretedTxCount,
      totalBuyCount: this.stats.totalBuyCount,
      totalSellCount: this.stats.totalSellCount,
      totalBuySol: Number(this.stats.totalBuySol.toFixed(9)),
      totalSellSol: Number(this.stats.totalSellSol.toFixed(9)),
      insiderTxCount: this.stats.insiderTxCount,
      insiderBuyCount: this.stats.insiderBuyCount,
      insiderSellCount: this.stats.insiderSellCount,
      insiderBuySol: Number(this.stats.insiderBuySol.toFixed(9)),
      insiderSellSol: Number(this.stats.insiderSellSol.toFixed(9)),
      insiderWalletCount: this.insiderWalletSet.size,
      totalHolders: this.lastHolderCount,
      insiderHolderPercent:
        insiderHolderPercent == null ? null : Number(insiderHolderPercent.toFixed(2)),
      insiderPercent: Number(insiderPercent.toFixed(2)),
      holderSnapshots: this.holderSnapshots,
      initialPrice: this.initialPrice,
      latestPrice: this.latestPrice,
      rugDetected: this.rugDetected,
      decision
    };

    logInfo(`[${this.label}] Pool analysis complete`, summary);

    if (shouldPersistPoolAnalysisReport(reason)) {
      await appendPoolAnalysisReport({
        recordedAt: new Date().toISOString(),
        ...summary
      });
    }

    if (this.onComplete) {
      await this.onComplete(this);
    }
  }

  stop() {
    if (this.priceCheckTimer) {
      clearInterval(this.priceCheckTimer);
      this.priceCheckTimer = null;
    }
  }
}
