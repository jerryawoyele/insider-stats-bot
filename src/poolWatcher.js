import { config } from "./config.js";
import { logInfo } from "./logger.js";
import { getGmgnHolderCount } from "./gmgn.js";
import { analyzePoolTransaction } from "./parsers.js";

function shortWallet(wallet) {
  return wallet ? `${wallet.slice(0, 8)}...` : "unknown";
}

export class PoolWatcher {
  constructor({ poolAddress, label, mint, insiderWallets }) {
    this.poolAddress = poolAddress;
    this.label = label;
    this.mint = mint;
    this.insiderWalletSet = new Set(insiderWallets);
    this.seenSignatures = new Set();
    this.processedCount = 0;
    this.completed = false;
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
      insiderWalletSet: this.insiderWalletSet
    });

    if (activity) {
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
      this.completed = true;
      const insiderPercent =
        this.processedCount === 0 ? 0 : (this.stats.insiderTxCount / this.processedCount) * 100;
      const insiderHolderPercent =
        this.lastHolderCount && this.lastHolderCount > 0
          ? (this.insiderWalletSet.size / this.lastHolderCount) * 100
          : null;

      const rugDetected = false;
      const accept = !rugDetected && insiderPercent >= 90;

      logInfo(`[${this.label}] Pool analysis complete`, {
        poolAddress: this.poolAddress,
        mint: this.mint,
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
        rugDetected,
        decision: accept ? "accept" : "reject"
      });
    }
  }

  async refreshHolderCount({ force = false } = {}) {
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
      txNumber: this.processedCount,
      holderCount
    };
    this.holderSnapshots.push(snapshot);

    logInfo(`[${this.label}] Holder count snapshot`, {
      mint: this.mint,
      poolAddress: this.poolAddress,
      txNumber: this.processedCount,
      holderCount
    });
  }
}
