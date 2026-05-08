var nconf = require('nconf');
var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();
var dbtype = nconf.get('database:type');

exports.up = function(db) {
  if (dbtype !== 'mysql' && dbtype !== 'mysql2') return Promise.resolve('Not Required');
  return Promise.all([
    // FLEX lookup: WHERE address LIKE '002029%' AND timestamp BETWEEN x AND y
    db.raw('CREATE INDEX IF NOT EXISTS msg_flex ON messages (address, timestamp)'),
    // Dedup query: WHERE address=? AND message=? AND timestamp > ?
    db.raw('CREATE INDEX IF NOT EXISTS msg_dedup ON messages (address, message(64), timestamp)'),
  ]);
};

exports.down = function(db) {
  if (dbtype !== 'mysql' && dbtype !== 'mysql2') return Promise.resolve('Not Required');
  return Promise.all([
    db.raw('DROP INDEX IF EXISTS msg_flex ON messages'),
    db.raw('DROP INDEX IF EXISTS msg_dedup ON messages'),
  ]);
};
