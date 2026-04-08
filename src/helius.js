import { config } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(path, params = {}) {
  const url = new URL(path, config.heliusRpcUrl.endsWith("/") ? config.heliusRpcUrl : `${config.heliusRpcUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  url.searchParams.set("api-key", config.heliusApiKey);
  return url;
}

function sanitizeUrlForLogs(url) {
  const copy = new URL(url.toString());
  if (copy.searchParams.has("api-key")) {
    copy.searchParams.set("api-key", "***redacted***");
  }

  return copy.toString();
}

function summarizeInit(init = {}) {
  return {
    method: init.method || "GET",
    hasBody: Boolean(init.body),
    bodyPreview:
      typeof init.body === "string"
        ? init.body.slice(0, 500)
        : undefined
  };
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function requestJson(url, init = {}, context = {}) {
  const maxAttempts = context.maxAttempts ?? 4;
  let attempt = 0;

  while (true) {
    const startedAt = Date.now();

    try {
      const response = await fetch(url, init);
      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        const text = await response.text();
        const errorDetails = {
          stage: context.stage || "unknown",
          attempt: attempt + 1,
          status: response.status,
          statusText: response.statusText,
          durationMs,
          url: sanitizeUrlForLogs(url),
          request: summarizeInit(init),
          context,
          responseBodyPreview: text.slice(0, 1000)
        };

        if (isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
          const backoffMs = 400 * 2 ** attempt;
          logWarn("Helius request failed, retrying", {
            ...errorDetails,
            backoffMs
          });
          attempt += 1;
          await sleep(backoffMs);
          continue;
        }

        if (response.status >= 500) {
          logError("Helius request returned server error", errorDetails);
        } else {
          logWarn("Helius request returned non-OK response", errorDetails);
        }

        throw new Error(
          `Helius request failed (${response.status}) during ${context.stage || "unknown stage"}`
        );
      }

      if (attempt > 0) {
        logInfo("Helius request succeeded after retry", {
          stage: context.stage || "unknown",
          attemptsUsed: attempt + 1,
          url: sanitizeUrlForLogs(url)
        });
      }

      return response.json();
    } catch (error) {
      const durationMs = Date.now() - startedAt;

      const retryableNetworkError =
        error instanceof Error &&
        !error.message.startsWith("Helius request failed") &&
        attempt < maxAttempts - 1;

      if (retryableNetworkError) {
        const backoffMs = 400 * 2 ** attempt;
        logWarn("Helius request threw, retrying", {
          stage: context.stage || "unknown",
          attempt: attempt + 1,
          durationMs,
          url: sanitizeUrlForLogs(url),
          request: summarizeInit(init),
          context,
          error: error.stack || error.message,
          backoffMs
        });
        attempt += 1;
        await sleep(backoffMs);
        continue;
      }

      if (error instanceof Error && error.message.startsWith("Helius request failed")) {
        throw error;
      }

      logError("Helius request threw before receiving a usable response", {
        stage: context.stage || "unknown",
        attempt: attempt + 1,
        durationMs,
        url: sanitizeUrlForLogs(url),
        request: summarizeInit(init),
        context,
        error: error instanceof Error ? error.stack || error.message : String(error)
      });

      throw error;
    }
  }
}

export async function getParsedTransactions(signatures, context = {}) {
  if (signatures.length === 0) {
    return [];
  }

  const url = buildUrl("v0/transactions");
  return requestJson(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ transactions: signatures })
    },
    {
      stage: context.stage || "getParsedTransactions",
      signatureCount: signatures.length,
      signaturesPreview: signatures.slice(0, 10),
      ...context
    }
  );
}

export async function getAddressTransactions(address, params = {}, context = {}) {
  const url = buildUrl(`v0/addresses/${address}/transactions`, params);
  return requestJson(
    url,
    undefined,
    {
      stage: context.stage || "getAddressTransactions",
      address,
      params,
      ...context
    }
  );
}
