function timestamp() {
  return new Date().toISOString();
}

export function logInfo(message, details) {
  if (details === undefined) {
    console.log(`[${timestamp()}] INFO  ${message}`);
    return;
  }

  console.log(`[${timestamp()}] INFO  ${message}`, details);
}

export function logWarn(message, details) {
  if (details === undefined) {
    console.warn(`[${timestamp()}] WARN  ${message}`);
    return;
  }

  console.warn(`[${timestamp()}] WARN  ${message}`, details);
}

export function logError(message, details) {
  if (details === undefined) {
    console.error(`[${timestamp()}] ERROR ${message}`);
    return;
  }

  console.error(`[${timestamp()}] ERROR ${message}`, details);
}
