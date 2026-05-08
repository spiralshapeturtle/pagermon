var nconf = require('nconf');
var confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();
var dbtype = nconf.get('database:type');

exports.up = function(db) {
  if (dbtype !== 'sqlite3') return Promise.resolve('Not Required');
  return db.schema.hasTable('messages').then(function(exists) {
    if (!exists) return Promise.resolve('Not Required');
    return Promise.all([
      // Covers: WHERE address=? AND message=? ORDER BY id DESC (dedup query)
      db.raw('CREATE INDEX IF NOT EXISTS msg_dedup ON messages (address, message, id)'),
      // Covers: WHERE ignore=1 or ignore=0 (used in every GET /messages subquery)
      db.raw('CREATE INDEX IF NOT EXISTS cc_ignore ON capcodes (ignore)'),
      // Covers: DISTINCT agency, WHERE agency=? (search + admin)
      db.raw('CREATE INDEX IF NOT EXISTS cc_agency ON capcodes (agency)'),
    ]);
  });
};

exports.down = function(db) {
  if (dbtype !== 'sqlite3') return Promise.resolve('Not Required');
  return Promise.all([
    db.raw('DROP INDEX IF EXISTS msg_dedup'),
    db.raw('DROP INDEX IF EXISTS cc_ignore'),
    db.raw('DROP INDEX IF EXISTS cc_agency'),
  ]);
};
