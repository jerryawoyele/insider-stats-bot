import { config } from "./config.js";
import { getAddressTransactions, getParsedTransactions } from "./helius.js";
import { logError, logInfo, logWarn } from "./logger.js";
import WebSocket from "ws";
import {
  extractInsidersFromDevTransactions,
  isInitialPoolTx,
  isMigrationLiquidityRemovalTx,
  isMigrationTx,
  isTokenCreateTx,
  parseInitialPoolFromTx,
  parseMigrationPoolFromTx,
  parseTokenCreateTx,
  sortTransactionsOldestFirst
} from "./parsers.js";
import { PoolWatcher } from "./poolWatcher.js";

export class InsiderBot {
  constructor() {
    this.currentToken = null;
    this.poolWatchers = new Map();
    this.activePoolSubscriptions = new Map();
    this.pendingSignatureGroups = {
      config: new Set()
    };
    this.pendingSignatureIndex = new Set();
    this.processedSignatureIndex = new Set();
    this.flushTimer = null;
    this.subscriptionId = null;
    this.subscriptionKinds = new Map();
    this.ws = null;
    this.reconnectTimer = null;
    this.requestIdCounter = 1;
    this.pingInterval = null;
    this.livenessCheckInterval = null;
    this.lastPongTime = 0;
    this.lastActivityTime = 0;
    this.reconnectAttempts = 0;
  }

  async start() {
    logInfo("Starting insider bot", {
      leaderWallet: config.leaderWallet,
      configAddress: config.configAddress
    });

    this.connectWebSocket();
  }

  connectWebSocket() {
    if (this.ws) {
      this.ws.close();
    }

    const ws = new WebSocket(config.heliusWssUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      logInfo("Connected to Helius websocket");
      this.reconnectAttempts = 0;
      this.lastPongTime = Date.now();
      this.lastActivityTime = Date.now();
      this.startPingLoop();
      this.startLivenessCheck();
      this.subscribeToConfigLogs();
      for (const watcher of this.poolWatchers.values()) {
        this.subscribeToPoolLogs(watcher.poolAddress, watcher.label);
      }
    });

    ws.addEventListener("message", async (event) => {
      this.lastActivityTime = Date.now();
      try {
        const rawMessage = event.data.toString();
        const trimmedMessage = rawMessage.trim();

        if (!trimmedMessage.startsWith("{") && !trimmedMessage.startsWith("[")) {
          logWarn("Received non-JSON websocket message", {
            messagePreview: trimmedMessage.slice(0, 300)
          });
          return;
        }

        const payload = JSON.parse(trimmedMessage);
        await this.handleWebSocketMessage(payload);
      } catch (error) {
        logError("Failed to handle websocket payload", error);
      }
    });

    ws.on("pong", () => {
      this.lastPongTime = Date.now();
    });

    ws.addEventListener("close", () => {
      this.stopHeartbeatLoops();
      logWarn("Helius websocket closed, scheduling reconnect");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", (error) => {
      logError("Helius websocket error", error);
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * 2 ** (this.reconnectAttempts - 1));

    logWarn("Scheduling websocket reconnect", {
      reconnectAttempt: this.reconnectAttempts,
      delayMs: delay
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  subscribeToConfigLogs() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const requestId = this.requestIdCounter++;
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "logsSubscribe",
        params: [
          {
            mentions: [config.configAddress]
          },
          {
            commitment: "confirmed"
          }
        ]
      })
    );

    this.subscriptionKinds.set(requestId, { kind: "config", address: config.configAddress });
  }

  subscribeToPoolLogs(poolAddress, label) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const requestId = this.requestIdCounter++;
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "logsSubscribe",
        params: [
          {
            mentions: [poolAddress]
          },
          {
            commitment: "confirmed"
          }
        ]
      })
    );

    this.subscriptionKinds.set(requestId, { kind: "pool", address: poolAddress, label });
  }

  async handleWebSocketMessage(payload) {
    if (payload?.result && typeof payload.result === "number") {
      const requestMeta = this.subscriptionKinds.get(payload.id);
      if (requestMeta) {
        this.subscriptionKinds.set(payload.result, requestMeta);
        this.subscriptionKinds.delete(payload.id);
      }

      if (requestMeta?.kind === "config") {
        this.subscriptionId = payload.result;
        logInfo("Subscribed to config-address logs", {
          subscriptionId: this.subscriptionId,
          configAddress: config.configAddress
        });
      }

      if (requestMeta?.kind === "pool") {
        this.activePoolSubscriptions.set(requestMeta.address, payload.result);
        logInfo("Subscribed to pool logs", {
          subscriptionId: payload.result,
          poolAddress: requestMeta.address,
          label: requestMeta.label
        });
      }
      return;
    }

    const subscriptionId = payload?.params?.subscription;
    const signature = payload?.params?.result?.value?.signature;
    const err = payload?.params?.result?.value?.err;

    if (!signature || err) {
      return;
    }

    const subscriptionMeta = this.subscriptionKinds.get(subscriptionId);
    if (subscriptionMeta?.kind === "pool" && !this.poolWatchers.has(subscriptionMeta.address)) {
      return;
    }

    if (this.pendingSignatureIndex.has(signature) || this.processedSignatureIndex.has(signature)) {
      return;
    }

    const queueKey =
      subscriptionMeta?.kind === "pool" ? `pool:${subscriptionMeta.address}` : "config";

    if (!this.pendingSignatureGroups[queueKey]) {
      this.pendingSignatureGroups[queueKey] = new Set();
    }

    this.pendingSignatureGroups[queueKey].add(signature);
    this.pendingSignatureIndex.add(signature);
    this.scheduleSignatureFlush();
  }

  scheduleSignatureFlush() {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.flushSignatures();
    }, config.signatureBatchWindowMs);
  }

  async flushSignatures() {
    const groups = this.pendingSignatureGroups;
    this.pendingSignatureGroups = { config: new Set() };

    for (const [queueKey, signatureSet] of Object.entries(groups)) {
      const signatures = [...signatureSet].filter((signature) => {
        return !this.processedSignatureIndex.has(signature);
      });

      for (const signature of signatureSet) {
        this.pendingSignatureIndex.delete(signature);
      }

      if (signatures.length === 0) {
        continue;
      }

      try {
        logInfo("Resolving signatures through Helius", {
          queueKey,
          count: signatures.length
        });

        const txs = await getParsedTransactions(signatures, {
          stage: "flushSignatures",
          queueKey
        });
        const sortedTxs = sortTransactionsOldestFirst(txs);

        for (const tx of sortedTxs) {
          if (tx?.signature) {
            this.processedSignatureIndex.add(tx.signature);
          }
        }

        if (queueKey === "config") {
          for (const tx of sortedTxs) {
            try {
              await this.processConfigTransaction(tx);
            } catch (error) {
              logError("Failed processing config transaction", {
                queueKey,
                signature: tx?.signature,
                error: error instanceof Error ? error.stack || error.message : String(error)
              });
            }
          }
          continue;
        }

        const poolAddress = queueKey.replace("pool:", "");
        const watcher = this.poolWatchers.get(poolAddress);
        if (!watcher) {
          continue;
        }

        for (const tx of sortedTxs) {
          await watcher.ingestParsedTransaction(tx);
        }

        if (watcher.completed) {
          logInfo("Pool watcher reached decision threshold", {
            poolAddress,
            label: watcher.label
          });
          this.unsubscribePoolLog(poolAddress);
          this.poolWatchers.delete(poolAddress);
        }
      } catch (error) {
        logError("Failed flushing signature group", {
          queueKey,
          signaturesPreview: signatures.slice(0, 10),
          error: error instanceof Error ? error.stack || error.message : String(error)
        });

        for (const signature of signatures) {
          if (this.processedSignatureIndex.has(signature) || this.pendingSignatureIndex.has(signature)) {
            continue;
          }

          if (!this.pendingSignatureGroups[queueKey]) {
            this.pendingSignatureGroups[queueKey] = new Set();
          }

          this.pendingSignatureGroups[queueKey].add(signature);
          this.pendingSignatureIndex.add(signature);
        }

        this.scheduleSignatureFlush();
      }
    }
  }

  async processConfigTransaction(tx) {
    if (!tx?.signature) {
      return;
    }

    if (isTokenCreateTx(tx)) {
      await this.handleTokenCreate(tx);
      return;
    }

    if (!this.currentToken) {
      return;
    }

    if (this.currentToken.initialPool && this.currentToken.migrationPool) {
      return;
    }

    if (
      !this.currentToken.migrationPool &&
      isMigrationLiquidityRemovalTx(tx, this.currentToken.mint)
    ) {
      logInfo("Detected migration liquidity removal for current token", {
        mint: this.currentToken.mint,
        signature: tx.signature
      });
      await this.handoffExistingPoolWatchers();
    }

    if (!this.currentToken.initialPool && isInitialPoolTx(tx)) {
      const initialPool = parseInitialPoolFromTx(tx);
      if (initialPool) {
        this.currentToken.initialPool = initialPool;
        logInfo("Discovered initial pool", {
          mint: this.currentToken.mint,
          initialPool,
          signature: tx.signature
        });
        await this.attachPoolFollower(initialPool, "initial");
      }
    }

    if (!this.currentToken.migrationPool && isMigrationTx(tx)) {
      const migrationPool = parseMigrationPoolFromTx(tx);
      if (migrationPool) {
        await this.handoffExistingPoolWatchers();
        this.currentToken.migrationPool = migrationPool;
        logInfo("Discovered migration pool", {
          mint: this.currentToken.mint,
          migrationPool,
          signature: tx.signature
        });
        await this.attachPoolFollower(migrationPool, "migration");
      }
    }
  }

  async handleTokenCreate(tx) {
    const parsed = parseTokenCreateTx(tx);
    if (!parsed) {
      logWarn("Token create tx matched rules but could not be parsed", {
        signature: tx.signature
      });
      return;
    }

    this.currentToken = {
      ...parsed,
      initialPool: null,
      migrationPool: null,
      insiders: []
    };
    this.unsubscribeAllPoolLogs();
    this.poolWatchers = new Map();

    logInfo("Discovered token create", {
      mint: parsed.mint,
      devWallet: parsed.devWallet,
      signature: parsed.signature
    });

    logInfo("Starting insider discovery", {
      mint: parsed.mint,
      devWallet: parsed.devWallet,
      beforeSignature: parsed.signature
    });

    let insiders = [];
    try {
      insiders = await this.fetchInsidersForToken(parsed.devWallet, parsed.signature, parsed.mint);
    } catch (error) {
      logError("Insider discovery failed; continuing without insiders", {
        mint: parsed.mint,
        devWallet: parsed.devWallet,
        signature: parsed.signature,
        error: error instanceof Error ? error.stack || error.message : String(error)
      });
    }

    this.currentToken.insiders = insiders;

    logInfo("Derived insiders from dev history", {
      mint: parsed.mint,
      devWallet: parsed.devWallet,
      insiderCount: insiders.length,
      insiders
    });
  }

  async fetchInsidersForToken(devWallet, createSignature, mint) {
    const allTxs = [];
    let beforeSignature = createSignature;

    for (let page = 0; page < config.insiderHistoryMaxPages; page += 1) {
      logInfo("Fetching insider history page", {
        mint,
        devWallet,
        page: page + 1,
        beforeSignature,
        limit: config.insiderHistoryLimit
      });

      const txs = await getAddressTransactions(
        devWallet,
        {
          "token-accounts": "none",
          "sort-order": "desc",
          "before-signature": beforeSignature,
          limit: Math.min(config.insiderHistoryLimit, 100)
        },
        {
          stage: "fetchInsidersForToken",
          mint,
          devWallet,
          page: page + 1,
          beforeSignature
        }
      );

      if (!Array.isArray(txs) || txs.length === 0) {
        logInfo("No more insider history returned", {
          mint,
          devWallet,
          page: page + 1
        });
        break;
      }

      allTxs.push(...txs);
      beforeSignature = txs[txs.length - 1]?.signature;

      logInfo("Fetched insider history page", {
        mint,
        devWallet,
        page: page + 1,
        txCount: txs.length,
        totalAccumulated: allTxs.length,
        nextBeforeSignature: beforeSignature
      });

      if (!beforeSignature) {
        logWarn("Stopping insider history pagination because next cursor is missing", {
          mint,
          devWallet,
          page: page + 1
        });
        break;
      }
    }

    return extractInsidersFromDevTransactions(devWallet, allTxs);
  }

  async attachPoolFollower(poolAddress, label) {
    if (this.poolWatchers.has(poolAddress) || !this.currentToken) {
      return;
    }

    const watcher = new PoolWatcher({
      poolAddress,
      label,
      mint: this.currentToken.mint,
      insiderWallets: this.currentToken.insiders,
      onComplete: async (completedWatcher) => {
        logInfo("Pool watcher reached decision threshold", {
          poolAddress: completedWatcher.poolAddress,
          label: completedWatcher.label,
          completionReason: completedWatcher.completionReason
        });
        this.unsubscribePoolLog(completedWatcher.poolAddress);
        this.poolWatchers.delete(completedWatcher.poolAddress);
      }
    });

    this.poolWatchers.set(poolAddress, watcher);
    await watcher.start();
    this.subscribeToPoolLogs(poolAddress, label);
  }

  async handoffExistingPoolWatchers() {
    for (const watcher of this.poolWatchers.values()) {
      if (watcher.completed) {
        continue;
      }

      await watcher.complete("migration_handoff");
    }
  }

  unsubscribeAllPoolLogs() {
    for (const watcher of this.poolWatchers.values()) {
      watcher.stop();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.activePoolSubscriptions.clear();
      return;
    }

    for (const [poolAddress, subscriptionId] of this.activePoolSubscriptions.entries()) {
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.requestIdCounter++,
          method: "logsUnsubscribe",
          params: [subscriptionId]
        })
      );

      this.subscriptionKinds.delete(subscriptionId);
      logInfo("Unsubscribed from previous pool logs", {
        poolAddress,
        subscriptionId
      });
    }

    this.activePoolSubscriptions.clear();
  }

  unsubscribePoolLog(poolAddress) {
    const watcher = this.poolWatchers.get(poolAddress);
    if (watcher) {
      watcher.stop();
    }

    const subscriptionId = this.activePoolSubscriptions.get(poolAddress);
    if (!subscriptionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.activePoolSubscriptions.delete(poolAddress);
      return;
    }

    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestIdCounter++,
        method: "logsUnsubscribe",
        params: [subscriptionId]
      })
    );

    this.subscriptionKinds.delete(subscriptionId);
    this.activePoolSubscriptions.delete(poolAddress);
    logInfo("Unsubscribed from pool logs", {
      poolAddress,
      subscriptionId
    });
  }

  startPingLoop() {
    this.stopPingLoop();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  stopPingLoop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  startLivenessCheck() {
    this.stopLivenessCheck();
    this.livenessCheckInterval = setInterval(() => {
      const now = Date.now();
      const pongAge = now - this.lastPongTime;
      const activityAge = now - this.lastActivityTime;

      if (pongAge > 90000 || activityAge > 300000) {
        logWarn("Websocket connection looks stale, terminating", {
          pongAgeMs: pongAge,
          activityAgeMs: activityAge
        });

        if (this.ws) {
          this.ws.terminate();
        }
      }
    }, 30000);
  }

  stopLivenessCheck() {
    if (this.livenessCheckInterval) {
      clearInterval(this.livenessCheckInterval);
      this.livenessCheckInterval = null;
    }
  }

  stopHeartbeatLoops() {
    this.stopPingLoop();
    this.stopLivenessCheck();
  }
}
