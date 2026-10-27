// Imported first by test files: ESM evaluates imports in order, so this runs
// before logger.js and keeps test output out of the real logs/ directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MERIDIAN_LOG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "meridian-test-logs-"));
