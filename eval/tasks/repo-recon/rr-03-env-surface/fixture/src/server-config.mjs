// Liest Konfiguration aus einem uebergebenen env-Objekt (nie direkt aus process.env,
// damit das Modul testbar bleibt).
export function loadConfig(env) {
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  const logLevel = env.LOG_LEVEL ?? "info";

  if (env.DATA_DIR === undefined) {
    throw new Error("DATA_DIR is required");
  }

  const cacheTtl = Number(env.CACHE_TTL_S ?? "60");

  return {
    port,
    logLevel,
    dataDir: env.DATA_DIR,
    cacheTtl
  };
}
