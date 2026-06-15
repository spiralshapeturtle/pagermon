// Voegt een expliciete group_id toe aan messages, zodat berichten die als één
// FLEX-groepscall binnenkomen (één bericht naar meerdere capcodes) als groep
// herkend kunnen worden zonder de fragiele timestamp+message heuristiek.
// Nullable: losse berichten houden group_id = NULL.
exports.up = function(knex) {
  return knex.schema.hasTable('messages').then(function(exists) {
    if (!exists) return 'Messages table not found';
    return knex.schema.hasColumn('messages', 'group_id').then(function(hasCol) {
      if (hasCol) return 'group_id already present';
      return knex.schema.table('messages', function(table) {
        table.string('group_id', 64).nullable();
        table.index('group_id', 'msg_group_id');
      });
    });
  });
};

exports.down = function(knex) {
  return knex.schema.hasTable('messages').then(function(exists) {
    if (!exists) return 'Messages table not found';
    return knex.schema.hasColumn('messages', 'group_id').then(function(hasCol) {
      if (!hasCol) return 'group_id not present';
      return knex.schema.table('messages', function(table) {
        table.dropIndex('group_id', 'msg_group_id');
        table.dropColumn('group_id');
      });
    });
  });
};
