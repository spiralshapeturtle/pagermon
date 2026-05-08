var nconf = require('nconf');
var confFile = './config/config.json';
var dbtype = nconf.get('database:type')

exports.up = function(db, Promise) {
    return db.schema.hasTable('messages').then(function(exists) {
        if (exists) {
            return db.schema.table('messages', table => {
                // Different handling for different DB types
                if (dbtype == 'sqlite3') {
                    table.text('addresses');
                } else if (dbtype == 'mysql' || dbtype == 'mysql2') {
                    table.text('addresses');
                } else if (dbtype == 'oracledb') {
                    table.string('addresses', [4000]); // Oracle has string length limits
                }
            });
        } else {
            return Promise.resolve('Messages table not found')
        }
    })
};

exports.down = function(db, Promise) {
    return db.schema.hasTable('messages').then(function(exists) {
        if (exists) {
            return db.schema.table('messages', table => {
                table.dropColumn('addresses');
            });
        } else {
            return Promise.resolve('Messages table not found')
        }
    })
};
