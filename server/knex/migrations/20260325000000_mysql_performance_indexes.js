var nconf = require('nconf');
var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();
var dbtype = nconf.get('database:type');

exports.up = function(db) {
  if (dbtype !== 'mysql' && dbtype !== 'mysql2') return Promise.resolve('Not Required');
  return Promise.all([
    // ORDER BY messages.timestamp DESC (front page stap 1 + count query)
    db.raw('CREATE INDEX IF NOT EXISTS msg_ts ON messages (timestamp DESC)'),
    // WHERE timestamp=X AND message(prefix) — stap 2 lookup per alarm-groep
    db.raw('CREATE INDEX IF NOT EXISTS msg_ts_msg ON messages (timestamp, message(64))'),
    // WHERE alias_id NOT IN (...) / JOIN capcodes — count + stap 1
    db.raw('CREATE INDEX IF NOT EXISTS msg_alias_ts ON messages (alias_id, timestamp DESC)'),
    // WHERE capcodes.ignore = 0 (elke front page query)
    db.raw('CREATE INDEX IF NOT EXISTS cc_ignore ON capcodes (`ignore`)'),
    // JOIN capcodes.id + ignore in één index
    db.raw('CREATE INDEX IF NOT EXISTS cc_id_ignore ON capcodes (id, `ignore`)'),
  ]);
};

exports.down = function(db) {
  if (dbtype !== 'mysql' && dbtype !== 'mysql2') return Promise.resolve('Not Required');
  return Promise.all([
    db.raw('DROP INDEX IF EXISTS msg_ts ON messages'),
    db.raw('DROP INDEX IF EXISTS msg_ts_msg ON messages'),
    db.raw('DROP INDEX IF EXISTS msg_alias_ts ON messages'),
    db.raw('DROP INDEX IF EXISTS cc_ignore ON capcodes (`ignore`)'),
    db.raw('DROP INDEX IF EXISTS cc_id_ignore ON capcodes (id, `ignore`)'),
  ]);
};
