import { config } from "./config.js";
import { getAddressTransactions, getParsedTransactions } from "./helius.js";
import { logError, logInfo, logWarn } from "./logger.js";
import WebSocket from "ws";
import { getGmgnHolderCount, getGmgnTokenPrice } from "./gmgn.js";
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
    this.currentTokens = new Map();
    this.poolWatchers = new Map();
    this.activePoolSubscriptions = new Map();
    this.pendingSignatureGroups = {};
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
      leaderWallets: config.leaderWallets,
      configAddresses: config.configAddresses
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

    for (const address of config.configAddresses) {
      const requestId = this.requestIdCounter++;
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "logsSubscribe",
          params: [
            {
              mentions: [address]
            },
            {
              commitment: "confirmed"
            }
          ]
        })
      );

      this.subscriptionKinds.set(requestId, { kind: "config", address });
    }
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
          configAddress: requestMeta.address
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
      subscriptionMeta?.kind === "pool"
        ? `pool:${subscriptionMeta.address}`
        : `config:${subscriptionMeta?.address}`;

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

    const delay = config.firstTxOnly ? 0 : config.signatureBatchWindowMs;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.flushSignatures();
    }, delay);
  }

  async flushSignatures() {
    const groups = this.pendingSignatureGroups;
    this.pendingSignatureGroups = {};

    for (const [queueKey, signatureSet] of Object.entries(groups)) {
      const signatures = [...signatureSet].filter((signature) => {
        return !this.processedSignatureIndex.has(signature);
      });

      if (signatures.length === 0) {
        continue;
      }

      let signaturesToFetch = signatures;
      if (config.firstTxOnly && signatures.length > 1) {
        signaturesToFetch = signatures.slice(0, 1);
        for (const signature of signatures.slice(1)) {
          if (!this.pendingSignatureGroups[queueKey]) {
            this.pendingSignatureGroups[queueKey] = new Set();
          }
          this.pendingSignatureGroups[queueKey].add(signature);
        }
      }

      for (const signature of signaturesToFetch) {
        this.pendingSignatureIndex.delete(signature);
      }

      try {
        logInfo("Resolving signatures through Helius", {
          queueKey,
          count: signaturesToFetch.length
        });

        const txs = await getParsedTransactions(signaturesToFetch, {
          stage: "flushSignatures",
          queueKey
        });
        const sortedTxs = sortTransactionsOldestFirst(txs);

        for (const tx of sortedTxs) {
          if (tx?.signature) {
            this.processedSignatureIndex.add(tx.signature);
          }
        }

        if (queueKey.startsWith("config:")) {
          const configAddress = queueKey.replace("config:", "");
          for (const tx of sortedTxs) {
            try {
              await this.processConfigTransaction(tx, configAddress);
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
        if (!watcher || watcher.completed) {
          continue;
        }

        for (const tx of sortedTxs) {
          if (watcher.completed) {
            break;
          }
          await watcher.ingestParsedTransaction(tx);
        }
      } catch (error) {
        logError("Failed flushing signature group", {
          queueKey,
          signaturesPreview: signatures.slice(0, 10),
          error: error instanceof Error ? error.stack || error.message : String(error)
        });

        for (const signature of signaturesToFetch) {
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

    if (config.firstTxOnly && Object.keys(this.pendingSignatureGroups).length > 0) {
      this.scheduleSignatureFlush();
    }
  }

  async processConfigTransaction(tx, configAddress) {
    if (!tx?.signature) {
      return;
    }

    if (isTokenCreateTx(tx)) {
      await this.handleTokenCreate(tx, configAddress);
      return;
    }

    const currentToken = this.currentTokens.get(configAddress);
    if (!currentToken) {
      return;
    }

    if (currentToken.initialPool && currentToken.migrationPool) {
      return;
    }

    if (
      !currentToken.migrationPool &&
      isMigrationLiquidityRemovalTx(tx, currentToken.mint)
    ) {
      logInfo("Detected migration liquidity removal for current token", {
        mint: currentToken.mint,
        currentInitialPool: currentToken.initialPool,
        currentMigrationPool: currentToken.migrationPool,
        signature: tx.signature
      });
      if (!config.firstTxOnly) {
        await this.handoffExistingPoolWatchers(configAddress);
      }
    }

    if (!currentToken.initialPool && isInitialPoolTx(tx)) {
      const initialPool = parseInitialPoolFromTx(tx);
      if (initialPool) {
        currentToken.initialPool = initialPool;
        logInfo("Discovered initial pool", {
          mint: currentToken.mint,
          initialPool,
          signature: tx.signature
        });
        if (!currentToken.migrationPool) {
          await this.attachPoolFollower(initialPool, "initial", configAddress);
        }
      }
    }

    if (!currentToken.migrationPool && isMigrationTx(tx)) {
      const migrationPool = parseMigrationPoolFromTx(tx);
      if (migrationPool) {
        if (!config.firstTxOnly) {
          await this.handoffExistingPoolWatchers(configAddress);
        }
        currentToken.migrationPool = migrationPool;
        logInfo("Discovered migration pool", {
          mint: currentToken.mint,
          previousPool: currentToken.initialPool,
          migrationPool,
          signature: tx.signature
        });
        await this.attachPoolFollower(migrationPool, "migration", configAddress);
      }
    }
  }

  async handleTokenCreate(tx, configAddress) {
    const parsed = parseTokenCreateTx(tx);
    if (!parsed) {
      logWarn("Token create tx matched rules but could not be parsed", {
        signature: tx.signature
      });
      return;
    }

    this.currentTokens.set(configAddress, {
      ...parsed,
      initialPool: null,
      migrationPool: null,
      insiders: []
    });
    this.unsubscribePoolLogsForConfig(configAddress);

    logInfo("Discovered token create", {
      mint: parsed.mint,
      devWallet: parsed.devWallet,
      signature: parsed.signature,
      configAddress
    });

    if (!config.firstTxOnly) {
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

      const tokenState = this.currentTokens.get(configAddress);
      if (tokenState) {
        tokenState.insiders = insiders;
      }

      logInfo("Derived insiders from dev history", {
        mint: parsed.mint,
        devWallet: parsed.devWallet,
        insiderCount: insiders.length,
        insiders
      });
    }

    if (config.firstTxOnly) {
      await this.refreshHolderAndPriceForToken(parsed.mint, configAddress);
    }
  }

  async refreshHolderAndPriceForToken(mint, configAddress) {
    const [holderCount, price] = await Promise.all([
      getGmgnHolderCount(mint),
      getGmgnTokenPrice(mint)
    ]);

    if (holderCount == null && price == null) {
      return;
    }

    logInfo("[token-create] Token snapshot", {
      mint,
      configAddress,
      holderCount: holderCount ?? null,
      price: price ?? null
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

  async attachPoolFollower(poolAddress, label, configAddress) {
    if (this.poolWatchers.has(poolAddress)) {
      return;
    }

    const tokenState = this.currentTokens.get(configAddress);
    if (!tokenState) {
      return;
    }

    const watcher = new PoolWatcher({
      poolAddress,
      label,
      mint: tokenState.mint,
      configAddress,
      insiderWallets: tokenState.insiders,
      leaderWallets: config.leaderWallets,
      firstTxOnly: config.firstTxOnly,
      onComplete: async (completedWatcher) => {
        logInfo("Pool watcher reached decision threshold", {
          poolAddress: completedWatcher.poolAddress,
          label: completedWatcher.label,
          completionReason: completedWatcher.completionReason
        });
        if (config.firstTxOnly && completedWatcher.completionReason === "first_pool_tx") {
          await this.stopOtherPoolWatchers(configAddress, completedWatcher.poolAddress);
        }
        this.unsubscribePoolLog(completedWatcher.poolAddress);
        this.poolWatchers.delete(completedWatcher.poolAddress);
      }
    });

    this.poolWatchers.set(poolAddress, watcher);
    await watcher.start();
    this.subscribeToPoolLogs(poolAddress, label);
  }

  async attachInitialPoolIfNeeded(configAddress) {
    if (config.firstTxOnly) {
      return;
    }

    const tokenState = this.currentTokens.get(configAddress);
    if (!tokenState) {
      return;
    }

    if (!tokenState.initialPool || tokenState.migrationPool) {
      return;
    }

    if (this.poolWatchers.has(tokenState.initialPool)) {
      return;
    }

    await this.attachPoolFollower(tokenState.initialPool, "initial", configAddress);
  }

  async handoffExistingPoolWatchers(configAddress) {
    for (const watcher of this.poolWatchers.values()) {
      if (watcher.completed) {
        continue;
      }

      if (watcher.configAddress && watcher.configAddress !== configAddress) {
        continue;
      }

      logInfo("Handing off pool watcher for migration", {
        mint: this.currentTokens.get(configAddress)?.mint,
        poolAddress: watcher.poolAddress,
        label: watcher.label
      });
      await watcher.complete("migration_handoff");
    }
  }

  async stopOtherPoolWatchers(configAddress, winningPoolAddress) {
    for (const [poolAddress, watcher] of this.poolWatchers.entries()) {
      if (poolAddress === winningPoolAddress) {
        continue;
      }
      if (watcher.configAddress && watcher.configAddress !== configAddress) {
        continue;
      }
      if (watcher.completed) {
        continue;
      }

      await watcher.complete("first_pool_tx");
      this.unsubscribePoolLog(poolAddress);
      this.poolWatchers.delete(poolAddress);
    }
  }

  unsubscribePoolLogsForConfig(configAddress) {
    const poolAddresses = [];
    for (const [poolAddress, watcher] of this.poolWatchers.entries()) {
      if (watcher.configAddress === configAddress) {
        watcher.stop();
        poolAddresses.push(poolAddress);
      }
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      for (const poolAddress of poolAddresses) {
        this.activePoolSubscriptions.delete(poolAddress);
        this.poolWatchers.delete(poolAddress);
      }
      return;
    }

    for (const poolAddress of poolAddresses) {
      const subscriptionId = this.activePoolSubscriptions.get(poolAddress);
      if (!subscriptionId) {
        this.poolWatchers.delete(poolAddress);
        continue;
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
      logInfo("Unsubscribed from previous pool logs", {
        poolAddress,
        subscriptionId
      });
      this.activePoolSubscriptions.delete(poolAddress);
      this.poolWatchers.delete(poolAddress);
    }
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
