#!/usr/bin/env node
// Migratiescript: SQLite → MariaDB
// Gebruik: node migrate_to_mysql.js
// Stop PagerMon eerst: pm2 stop pagermon

const nconf = require('nconf');
nconf.file({ file: './config/config.json' });
nconf.load();

const SQLITE_FILE = nconf.get('database:file') || './messages.db';
const BATCH_SIZE  = 1000;

const sqliteKnex = require('knex')({
  client: 'sqlite3',
  connection: { filename: SQLITE_FILE },
  useNullAsDefault: true,
});

const mysqlKnex = require('knex')({
  client: 'mysql2',
  connection: {
    host:     nconf.get('database:server'),
    port:     nconf.get('database:port') || 3306,
    user:     nconf.get('database:username'),
    password: nconf.get('database:password'),
    database: nconf.get('database:database'),
  },
  useNullAsDefault: true,
});

async function migrateTable(name, transform) {
  const total = (await sqliteKnex(name).count('* as c'))[0].c;
  console.log(`\n[${name}] ${total} rijen te migreren...`);
  let offset = 0;
  let migrated = 0;
  while (offset < total) {
    const rows = await sqliteKnex(name).select('*').limit(BATCH_SIZE).offset(offset);
    if (rows.length === 0) break;
    const mapped = transform ? rows.map(transform) : rows;
    await mysqlKnex(name).insert(mapped);
    migrated += rows.length;
    offset   += rows.length;
    process.stdout.write(`\r  ${migrated}/${total} (${Math.round(migrated/total*100)}%)`);
  }
  console.log(`\n[${name}] klaar.`);
}

async function main() {
  console.log('PagerMon SQLite → MariaDB migratie');
  console.log('====================================');
  console.log(`SQLite: ${SQLITE_FILE}`);
  console.log(`MariaDB: ${nconf.get('database:server')}/${nconf.get('database:database')}`);

  // Controleer verbindingen
  await sqliteKnex.raw('SELECT 1').catch(e => { console.error('SQLite verbinding mislukt:', e.message); process.exit(1); });
  await mysqlKnex.raw('SELECT 1').catch(e => { console.error('MariaDB verbinding mislukt:', e.message); process.exit(1); });
  console.log('Beide verbindingen OK.\n');

  // Controleer of MariaDB leeg is
  const msgCount = (await mysqlKnex('messages').count('* as c').catch(() => [{c:0}]))[0].c;
  if (msgCount > 0) {
    console.log(`MariaDB bevat al ${msgCount} berichten. Wil je doorgaan? (Ctrl+C om te stoppen)`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Disable foreign key checks voor de import + leegmaken
  await mysqlKnex.raw('SET FOREIGN_KEY_CHECKS=0');
  console.log('Tabellen leegmaken...');
  await mysqlKnex('messages').truncate();
  await mysqlKnex('capcodes').truncate();
  await mysqlKnex('users').truncate().catch(() => {});

  // 1. Capcodes
  await migrateTable('capcodes');

  // 2. Users
  const usersExists = await sqliteKnex.schema.hasTable('users');
  if (usersExists) await migrateTable('users', row => {
    // lastlogondate kan een ms-timestamp zijn of al een datetime string
    if (row.lastlogondate && /^\d{10,}$/.test(String(row.lastlogondate))) {
      const ms = String(row.lastlogondate).length >= 13 ? +row.lastlogondate : +row.lastlogondate * 1000;
      row.lastlogondate = new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    }
    return row;
  });

  // 3. Messages (groot — in batches)
  await migrateTable('messages');

  await mysqlKnex.raw('SET FOREIGN_KEY_CHECKS=1');

  // Reset auto_increment
  const maxId = (await mysqlKnex('messages').max('id as m'))[0].m || 0;
  await mysqlKnex.raw(`ALTER TABLE messages AUTO_INCREMENT = ${maxId + 1}`);
  const maxCcId = (await mysqlKnex('capcodes').max('id as m'))[0].m || 0;
  await mysqlKnex.raw(`ALTER TABLE capcodes AUTO_INCREMENT = ${maxCcId + 1}`);

  console.log('\nMigratie voltooid!');
  console.log('Start PagerMon: pm2 start pagermon');

  await sqliteKnex.destroy();
  await mysqlKnex.destroy();
}

main().catch(err => {
  console.error('\nFout:', err.message);
  process.exit(1);
});
