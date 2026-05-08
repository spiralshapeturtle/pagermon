const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const LocalAPIKeyStrategy = require('passport-localapikey-update').Strategy;
const crypto = require('crypto');

const nconf = require('nconf');
const logger = require('../log');

const confFile = './config/config.json';
nconf.file({ file: confFile });

const init = require('./passport');
const db = require('../knex/knex.js');

const authHelper = require('../middleware/authhelper')

const options = {};

init();

passport.use(
        'login-user',
        new LocalStrategy(options, (username, password, done) => {
                // check to see if the username exists
                db('users')
                        .where('username', '=', username)
                        .first()
                        .then(user => {
                                if (!user) {
                                        return done(null, false);
                                }
                                if (!authHelper.comparePass(password, user.password)) {
                                        return done(null, false);
                                }
                                return done(null, user);
                        })
                        .catch(err => done(err));
        })
);

passport.use(
        'login-api',
        new LocalAPIKeyStrategy(function(apikey, done) {
                nconf.load();
                const auth = nconf.get('auth');
                const key = auth.keys.find(x => {
                        try {
                                const a = Buffer.from(x.key);
                                const b = Buffer.from(apikey);
                                if (a.length !== b.length) return false;
                                return crypto.timingSafeEqual(a, b);
                        } catch (e) { return false; }
                });
                if (key) {
                        return done(null, key.name);
                }
                return done(null, false);
        })
);

module.exports = passport;

