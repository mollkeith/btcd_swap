/**
 * Per-operation file logging.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createLogger(scriptName, { projectRoot }) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logsDir = join(projectRoot, "logs");
  mkdirSync(logsDir, { recursive: true });

  const logPath = join(logsDir, `${scriptName}-${ts}.log`);
  const summaryPath = join(logsDir, `${scriptName}-${ts}-summary.json`);

  return {
    logPath,
    summaryPath,
    append(entry) {
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        script: scriptName,
        ...entry,
      });
      appendFileSync(logPath, `${line}\n`);
    },
    writeSummary(payload) {
      writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`);
      return summaryPath;
    },
  };
}
