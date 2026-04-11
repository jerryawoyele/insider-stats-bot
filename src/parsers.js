function isEmptyTokenBalanceChanges(value) {
  return Array.isArray(value) && value.length === 0;
}

function isNativeTransferLike(value) {
  return Boolean(value?.fromUserAccount && value?.toUserAccount);
}

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function isTokenCreateTx(tx) {
  return tx?.type === "UNKNOWN" && tx?.source === "UNKNOWN" && tx?.fee === 10000;
}

export function parseTokenCreateTx(tx) {
  const firstTransfer = tx?.nativeTransfers?.find(isNativeTransferLike);
  if (!firstTransfer) {
    return null;
  }

  return {
    signature: tx.signature,
    slot: tx.slot,
    timestamp: tx.timestamp,
    devWallet: firstTransfer.fromUserAccount,
    mint: firstTransfer.toUserAccount,
    rawTx: tx
  };
}

export function isInitialPoolTx(tx) {
  return tx?.type === "TRANSFER" && tx?.source === "SYSTEM_PROGRAM";
}

export function parseInitialPoolFromTx(tx) {
  const zeroBalanceAccounts = (tx?.accountData || []).filter((entry) => {
    return entry?.nativeBalanceChange === 0 && isEmptyTokenBalanceChanges(entry?.tokenBalanceChanges);
  });

  if (zeroBalanceAccounts.length < 2) {
    return null;
  }

  return zeroBalanceAccounts[1]?.account || null;
}

export function isMigrationTx(tx) {
  return tx?.type === "UNKNOWN" && tx?.source === "METEORA_DAMM_V2" && tx?.transactionError == null;
}

export function parseMigrationPoolFromTx(tx) {
  const match = (tx?.nativeTransfers || []).find((transfer) => transfer?.amount === 8630400);
  return match?.toUserAccount || null;
}

export function isMigrationLiquidityRemovalTx(tx, mint) {
  if (tx?.type !== "INITIALIZE_ACCOUNT" || tx?.source !== "ASSOCIATED_TOKEN_PROGRAM") {
    return false;
  }

  return (tx?.tokenTransfers || []).some((transfer) => transfer?.mint === mint);
}

export function extractInsidersFromDevTransactions(devWallet, txs) {
  const insiders = new Set();

  for (const tx of txs) {
    for (const transfer of tx?.nativeTransfers || []) {
      if (transfer?.fromUserAccount === devWallet && transfer?.toUserAccount) {
        insiders.add(transfer.toUserAccount);
      }
    }
  }

  return [...insiders];
}

export function sortTransactionsOldestFirst(txs) {
  return [...txs].sort((a, b) => {
    const aTs = a?.timestamp ?? 0;
    const bTs = b?.timestamp ?? 0;
    return aTs - bTs;
  });
}

function lamportsToSol(amount) {
  return Number(amount || 0) / 1_000_000_000;
}

function findSolTokenTransfer(tx, wallet) {
  return (tx?.tokenTransfers || []).find((transfer) => {
    if (transfer?.mint !== WSOL_MINT) {
      return false;
    }

    return transfer?.fromUserAccount === wallet || transfer?.toUserAccount === wallet;
  });
}

function findMatchingWsolTransfer(tx, wallet, side) {
  return (tx?.tokenTransfers || []).find((transfer) => {
    if (transfer?.mint !== WSOL_MINT) {
      return false;
    }

    if (side === "buy") {
      return transfer?.fromUserAccount === wallet;
    }

    if (side === "sell") {
      return transfer?.toUserAccount === wallet;
    }

    return false;
  });
}

function inferSideFromTokenTransfer(tx, mint) {
  const tokenTransfers = (tx?.tokenTransfers || []).filter((transfer) => transfer?.mint === mint);
  const wsolTransfers = (tx?.tokenTransfers || []).filter((transfer) => transfer?.mint === WSOL_MINT);

  for (const tokenTransfer of tokenTransfers) {
    for (const wsolTransfer of wsolTransfers) {
      const buyMatches =
        tokenTransfer?.toUserAccount &&
        tokenTransfer?.fromUserAccount &&
        tokenTransfer.toUserAccount === wsolTransfer?.fromUserAccount &&
        tokenTransfer.fromUserAccount === wsolTransfer?.toUserAccount;

      if (buyMatches) {
        return {
          wallet: tokenTransfer.toUserAccount,
          side: "buy",
          solAmount: Number(wsolTransfer?.tokenAmount || 0),
          source: "swap-paired-transfer"
        };
      }

      const sellMatches =
        tokenTransfer?.fromUserAccount &&
        tokenTransfer?.toUserAccount &&
        tokenTransfer.fromUserAccount === wsolTransfer?.toUserAccount &&
        tokenTransfer.toUserAccount === wsolTransfer?.fromUserAccount;

      if (sellMatches) {
        return {
          wallet: tokenTransfer.fromUserAccount,
          side: "sell",
          solAmount: Number(wsolTransfer?.tokenAmount || 0),
          source: "swap-paired-transfer"
        };
      }
    }
  }

  for (const transfer of tokenTransfers) {
    const receivedWallet = transfer?.toUserAccount;
    if (receivedWallet) {
      const wsolOut = findMatchingWsolTransfer(tx, receivedWallet, "buy");
      if (wsolOut && wsolOut?.toUserAccount !== receivedWallet) {
        return {
          wallet: receivedWallet,
          side: "buy",
          solAmount: Number(wsolOut.tokenAmount || 0),
          source: "swap-paired-transfer-fallback"
        };
      }
    }

    const sentWallet = transfer?.fromUserAccount;
    if (sentWallet) {
      const wsolIn = findMatchingWsolTransfer(tx, sentWallet, "sell");
      if (wsolIn && wsolIn?.fromUserAccount !== sentWallet) {
        return {
          wallet: sentWallet,
          side: "sell",
          solAmount: Number(wsolIn.tokenAmount || 0),
          source: "swap-paired-transfer-fallback"
        };
      }
    }
  }

  return null;
}

function inferPoolAuthorityFromTokenTransfer(tx, mint) {
  for (const transfer of tx?.tokenTransfers || []) {
    if (transfer?.mint !== mint) {
      continue;
    }

    const buyCounterparty = (tx?.tokenTransfers || []).find((candidate) => {
      return (
        candidate?.mint === WSOL_MINT &&
        candidate?.fromUserAccount === transfer?.toUserAccount &&
        candidate?.toUserAccount === transfer?.fromUserAccount
      );
    });

    if (buyCounterparty) {
      return transfer?.fromUserAccount || null;
    }

    const sellCounterparty = (tx?.tokenTransfers || []).find((candidate) => {
      return (
        candidate?.mint === WSOL_MINT &&
        candidate?.toUserAccount === transfer?.fromUserAccount &&
        candidate?.fromUserAccount === transfer?.toUserAccount
      );
    });

    if (sellCounterparty) {
      return transfer?.toUserAccount || null;
    }
  }

  return null;
}

function findNativePoolTransfer(tx, poolAddress, wallet) {
  return (tx?.nativeTransfers || []).find((transfer) => {
    const fromMatches =
      transfer?.fromUserAccount === wallet && transfer?.toUserAccount === poolAddress;
    const toMatches =
      transfer?.fromUserAccount === poolAddress && transfer?.toUserAccount === wallet;
    return fromMatches || toMatches;
  });
}

export function analyzePoolTransaction({ tx, poolAddress, mint, insiderWalletSet }) {
  const inferredSwap = inferSideFromTokenTransfer(tx, mint);
  if (inferredSwap) {
    return {
      ...inferredSwap,
      isInsider: insiderWalletSet.has(inferredSwap.wallet)
    };
  }

  const inferredPoolAuthority = inferPoolAuthorityFromTokenTransfer(tx, mint);

  for (const transfer of tx?.tokenTransfers || []) {
    if (transfer?.mint === WSOL_MINT || transfer?.mint !== mint) {
      continue;
    }

    if (inferredPoolAuthority && transfer?.fromUserAccount === inferredPoolAuthority) {
      const wallet = transfer?.toUserAccount;
      if (!wallet) {
        continue;
      }

      const solTransfer = findSolTokenTransfer(tx, wallet);
      return {
        wallet,
        side: "buy",
        solAmount: Number(solTransfer?.tokenAmount || 0),
        isInsider: insiderWalletSet.has(wallet),
        source: "token-transfer"
      };
    }

    if (inferredPoolAuthority && transfer?.toUserAccount === inferredPoolAuthority) {
      const wallet = transfer?.fromUserAccount;
      if (!wallet) {
        continue;
      }

      const solTransfer = findSolTokenTransfer(tx, wallet);
      return {
        wallet,
        side: "sell",
        solAmount: Number(solTransfer?.tokenAmount || 0),
        isInsider: insiderWalletSet.has(wallet),
        source: "token-transfer"
      };
    }
  }

  for (const transfer of tx?.nativeTransfers || []) {
    if (transfer?.toUserAccount === poolAddress) {
      const wallet = transfer?.fromUserAccount;
      if (!wallet) {
        continue;
      }

      return {
        wallet,
        side: "buy",
        solAmount: lamportsToSol(transfer.amount),
        isInsider: insiderWalletSet.has(wallet),
        source: "native-transfer"
      };
    }

    if (transfer?.fromUserAccount === poolAddress) {
      const wallet = transfer?.toUserAccount;
      if (!wallet) {
        continue;
      }

      return {
        wallet,
        side: "sell",
        solAmount: lamportsToSol(transfer.amount),
        isInsider: insiderWalletSet.has(wallet),
        source: "native-transfer"
      };
    }
  }

  const fallbackTransfer = (tx?.nativeTransfers || []).find((transfer) => {
    const wallet = transfer?.fromUserAccount || transfer?.toUserAccount;
    return wallet && (insiderWalletSet.has(transfer?.fromUserAccount) || insiderWalletSet.has(transfer?.toUserAccount));
  });

  if (fallbackTransfer) {
    const wallet = insiderWalletSet.has(fallbackTransfer.fromUserAccount)
      ? fallbackTransfer.fromUserAccount
      : fallbackTransfer.toUserAccount;
    const matchedTransfer = findNativePoolTransfer(tx, poolAddress, wallet);

    if (matchedTransfer) {
      return {
        wallet,
        side: matchedTransfer.toUserAccount === poolAddress ? "buy" : "sell",
        solAmount: lamportsToSol(matchedTransfer.amount),
        isInsider: true,
        source: "native-fallback"
      };
    }
  }

  return null;
}
