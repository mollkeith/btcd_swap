import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (parent of lib/) */
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
