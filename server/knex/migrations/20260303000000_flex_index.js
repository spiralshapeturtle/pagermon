exports.up = function(knex) {
  if (knex.client.config.client === 'sqlite3') {
    return knex.schema.raw('CREATE INDEX IF NOT EXISTS msg_flex ON messages (address, timestamp)');
  }
  return Promise.resolve();
};
exports.down = function(knex) {
  if (knex.client.config.client === 'sqlite3') {
    return knex.schema.raw('DROP INDEX IF EXISTS msg_flex');
  }
  return Promise.resolve();
};
