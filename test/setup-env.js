// Imported first by test files: ESM evaluates imports in order, so this runs
// before logger.js and db.js, keeping test output out of the real logs/ and meridian.db.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MERIDIAN_LOG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "meridian-test-logs-"));
process.env.MERIDIAN_DB ||= path.join(fs.mkdtempSync(path.join(os.tmpdir(), "meridian-test-db-")), "meridian.db");
