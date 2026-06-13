// JAT v11 — logging.
// electron-log writes to userData/logs with rotation; falls back to console
// when electron-log is unavailable (plain-node test runs).

let log;
try {
  log = require('electron-log');
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';
} catch {
  log = console;
  log.transports = null;
}

function scope(tag) {
  const p = `[${tag}]`;
  return {
    info: (...a) => log.info(p, ...a),
    warn: (...a) => log.warn(p, ...a),
    error: (...a) => log.error(p, ...a),
    debug: (...a) => (log.debug ? log.debug(p, ...a) : log.info(p, ...a)),
  };
}

module.exports = { log, scope };
