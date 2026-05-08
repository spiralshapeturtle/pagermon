// Materialiseert unieke alarm-groepen (timestamp + bericht) voor snelle COUNT-queries.
// Vervangt de 1.7s PDW COUNT DISTINCT (491K rijen) door een O(n) scan op 196K rijen.
// Alleen SQLite — MySQL gebruikt al efficiënte anti-join queries.
exports.up = async function(knex) {
  const dbtype = knex.client.config.client;
  if (dbtype !== 'sqlite3') return;

  await knex.schema.createTable('alarm_groups', function(t) {
    t.integer('timestamp').notNullable();
    t.text('message').notNullable();
    t.integer('ref_count').notNullable().defaultTo(0);  // totaal adressen dit alarm
    t.integer('pdw_count').notNullable().defaultTo(0);  // adressen met geldige PDW capcode
    t.primary(['timestamp', 'message']);
  });

  // Éénmalige populatie vanuit bestaande berichten (~1-2s bij 491K rijen)
  await knex.raw(`
    INSERT INTO alarm_groups (timestamp, message, ref_count, pdw_count)
    SELECT
      m.timestamp,
      m.message,
      COUNT(*)                                                             AS ref_count,
      SUM(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END)                   AS pdw_count
    FROM messages m
    LEFT JOIN capcodes c
      ON c.id = m.alias_id
     AND c.ignore = 0
     AND c.alias  IS NOT NULL
     AND c.alias  != ''
    GROUP BY m.timestamp, m.message
  `);

  // INSERT trigger: nieuw bericht → maak of verhoog alarm-groep
  await knex.raw(`
    CREATE TRIGGER alarm_groups_insert AFTER INSERT ON messages BEGIN
      INSERT INTO alarm_groups (timestamp, message, ref_count, pdw_count)
      VALUES (
        NEW.timestamp,
        NEW.message,
        1,
        CASE WHEN EXISTS (
          SELECT 1 FROM capcodes
           WHERE id    = NEW.alias_id
             AND ignore = 0
             AND alias  IS NOT NULL
             AND alias  != ''
        ) THEN 1 ELSE 0 END
      )
      ON CONFLICT (timestamp, message) DO UPDATE SET
        ref_count = ref_count + 1,
        pdw_count = pdw_count + CASE WHEN EXISTS (
          SELECT 1 FROM capcodes
           WHERE id    = NEW.alias_id
             AND ignore = 0
             AND alias  IS NOT NULL
             AND alias  != ''
        ) THEN 1 ELSE 0 END;
    END
  `);

  // DELETE trigger: verwijder bericht → verlaag alarm-groep, ruim leeg op
  await knex.raw(`
    CREATE TRIGGER alarm_groups_delete AFTER DELETE ON messages BEGIN
      UPDATE alarm_groups SET
        ref_count = ref_count - 1,
        pdw_count = pdw_count - CASE WHEN EXISTS (
          SELECT 1 FROM capcodes
           WHERE id    = OLD.alias_id
             AND ignore = 0
             AND alias  IS NOT NULL
             AND alias  != ''
        ) THEN 1 ELSE 0 END
      WHERE timestamp = OLD.timestamp AND message = OLD.message;

      DELETE FROM alarm_groups
       WHERE timestamp = OLD.timestamp
         AND message   = OLD.message
         AND ref_count <= 0;
    END
  `);
};

exports.down = async function(knex) {
  const dbtype = knex.client.config.client;
  if (dbtype !== 'sqlite3') return;

  await knex.raw('DROP TRIGGER IF EXISTS alarm_groups_delete');
  await knex.raw('DROP TRIGGER IF EXISTS alarm_groups_insert');
  await knex.schema.dropTableIfExists('alarm_groups');
};
