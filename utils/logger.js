const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };

function log(level, prefix, message) {
  const time = new Date().toTimeString().slice(0, 8);
  const tag = LEVELS[level] || 'INFO';
  console.log(`[${time}] [${tag}] [${prefix}] ${message}`);
}

module.exports = {
  info:  (prefix, msg) => log('info',  prefix, msg),
  warn:  (prefix, msg) => log('warn',  prefix, msg),
  error: (prefix, msg) => log('error', prefix, msg),
  debug: (prefix, msg) => log('debug', prefix, msg),
};
