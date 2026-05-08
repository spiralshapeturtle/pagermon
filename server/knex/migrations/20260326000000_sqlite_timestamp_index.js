var nconf = require('nconf');
var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();
var dbtype = nconf.get('database:type');

exports.up = function(db) {
  if (dbtype !== 'sqlite3') return Promise.resolve('Not Required');
  return Promise.all([
    // ORDER BY timestamp DESC — front page step 1, rotation DELETE, stats WHERE timestamp > ?
    db.raw('CREATE INDEX IF NOT EXISTS msg_ts ON messages (timestamp DESC)'),
    // alias_id + timestamp — step 1 JOIN + ORDER BY (covers count subquery too)
    db.raw('CREATE INDEX IF NOT EXISTS msg_alias_ts ON messages (alias_id, timestamp DESC)'),
  ]);
};

exports.down = function(db) {
  if (dbtype !== 'sqlite3') return Promise.resolve('Not Required');
  return Promise.all([
    db.raw('DROP INDEX IF EXISTS msg_ts'),
    db.raw('DROP INDEX IF EXISTS msg_alias_ts'),
  ]);
};
