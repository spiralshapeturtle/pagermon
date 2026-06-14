const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const util = require('util');
const { pickBy, pick } = require('lodash');
const pluginHandler = require('../plugins/pluginHandler');
const logger = require('../log');
const db = require('../knex/knex.js');
const converter = require('json-2-csv');

const nconf = require('nconf');
const axios = require('axios');

const confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

router.use(express.json({ limit: '10mb' }));       // to support JSON-encoded bodies
router.use(express.urlencoded({     // to support URL-encoded bodies
  extended: true
}));

const passport = require('../auth/local');
const authHelper = require('../middleware/authhelper')

router.use(function (req, res, next) {
  res.locals.login = req.isAuthenticated();
  res.locals.user = req.user || false;
  next();
});

// ── Web Push ──────────────────────────────────────────────────────────────────
// Laadt web-push alleen als het geïnstalleerd is; server start anders gewoon
// zonder push-functionaliteit (geen harde dependency).
let _webpush   = null;
let _pushReady = false;

(function initWebPush() {
  try {
    _webpush = require('web-push');
  } catch(e) {
    logger.main.warn('web-push niet geïnstalleerd — push-notificaties uitgeschakeld');
    return;
  }

  // Auto-genereer VAPID-sleutels als ze nog niet bestaan
  let pubKey  = nconf.get('push:vapidPublicKey');
  let privKey = nconf.get('push:vapidPrivateKey');
  if (!pubKey || !privKey) {
    const keys = _webpush.generateVAPIDKeys();
    pubKey  = keys.publicKey;
    privKey = keys.privateKey;
    nconf.set('push:vapidPublicKey',  pubKey);
    nconf.set('push:vapidPrivateKey', privKey);
    nconf.save();
    logger.main.info('VAPID-sleutels gegenereerd en opgeslagen in config');
  }

  var vapidSubject = nconf.get('push:vapidSubject') || nconf.get('global:siteUrl') || 'https://flex.robdehoog.nl';
  _webpush.setVapidDetails(vapidSubject, pubKey, privKey);
  _pushReady = true;
  logger.main.info('Web push geïnitialiseerd');
})();

// Maak push_subscriptions tabel aan als die nog niet bestaat
// (loopt naast de Knex-migraties, zodat er geen server-restart nodig is)
db.schema.hasTable('push_subscriptions').then(function(exists) {
  if (!exists) {
    return db.schema.createTable('push_subscriptions', function(t) {
      t.string('endpoint', 500).primary();
      t.text('p256dh').notNullable();
      t.text('auth').notNullable();
      t.integer('created_at').defaultTo(Math.floor(Date.now() / 1000));
    }).then(function() {
      logger.main.info('push_subscriptions tabel aangemaakt');
    });
  }
}).catch(function(err) {
  logger.main.error('Fout bij aanmaken push_subscriptions tabel: ' + err);
});

// Stuurt push-notificatie naar alle actieve subscriptions
// Verwijdert automatisch verlopen subscriptions (HTTP 410/404 van push-service)
const _sentPushCache = new Map();
const PUSH_DUPE_TTL  = 5000; // 5 seconden venster voor ontdubbeling

async function sendPushNotifications(row) {
  if (!_pushReady) return;

  // Ontdubbeling op alarm-identiteit (timestamp|message): dit onderdrukt de fan-out
  // van hetzelfde alarm naar meerdere capcodes, maar laat twee losse incidenten met
  // toevallig dezelfde tekst (ander timestamp) wel allebei een push sturen.
  const now = Date.now();
  const msgKey = (row.timestamp || '') + '|' + (row.message || '');
  const lastSent = _sentPushCache.get(msgKey);
  if (lastSent && (now - lastSent) < PUSH_DUPE_TTL) {
    return;
  }
  _sentPushCache.set(msgKey, now);

  // Af en toe de cache opschonen
  if (_sentPushCache.size > 100) {
    for (let [k, v] of _sentPushCache) {
      if (now - v > PUSH_DUPE_TTL) _sentPushCache.delete(k);
    }
  }

  try {
    const subs = await db('push_subscriptions').select('*');
    if (!subs.length) return;

    // STRIPPING LOGICA:
    // Soms plakt de decoder het alias of agency label aan het begin van het bericht.
    // We proberen dit hier te herkennen en te verwijderen.
    let cleanMessage = row.message || '';
    if (row.alias && cleanMessage.startsWith(row.alias)) {
        cleanMessage = cleanMessage.substring(row.alias.length).trim();
    }
    if (row.agency && cleanMessage.startsWith(row.agency)) {
        cleanMessage = cleanMessage.substring(row.agency.length).trim();
    }
    // Als er na het strippen nog een ":" of "-" aan het begin staat, ook die weghalen
    cleanMessage = cleanMessage.replace(/^[:\-\s]+/, '');

    const payloadObj = {
      title: 'P2000-melding',
      body:  cleanMessage || 'Nieuw bericht',
      icon:  '/apple-touch-icon.png',
      badge: '/favicon-32x32.png',
      tag:   'pagermon-alert',
      url:   '/'
    };
    logger.main.debug('Push Payload versturen: ' + JSON.stringify(payloadObj));
    const payload = JSON.stringify(payloadObj);

    const stale = [];
    await Promise.all(subs.map(async function(sub) {
      try {
        await _webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 }   // vervalt na 60 s — geen verouderde meldingen bezorgen
        );
      } catch(err) {
        // 410 Gone / 404 Not Found = subscription niet langer geldig
        if (err.statusCode === 410 || err.statusCode === 404) {
          stale.push(sub.endpoint);
        } else {
          logger.main.warn('Push send fout (' + err.statusCode + '): ' + err.message);
        }
      }
    }));

    if (stale.length) {
      await db('push_subscriptions').whereIn('endpoint', stale).delete();
      logger.main.info('Verwijderd: ' + stale.length + ' verlopen push-subscription(s)');
    }
  } catch(err) {
    logger.main.error('sendPushNotifications fout: ' + err);
  }
}
// ── Einde Web Push init ───────────────────────────────────────────────────────

// Pre-warm count cache bij module-load zodat de eerste sneakpeek-request
// niet de koude query hoeft te wachten. Alleen de snelle alarm_groups queries
// worden gewarmd — complexe 1.7s anon-queries worden NIET gewarmd omdat ze
// de enige DB-connectie (pool max=1) blokkeren en P2000-inserts verhinderen.
// Queries worden sequentieel uitgevoerd om contention te vermijden.
if (process.env.NODE_ENV !== 'test') {
  setImmediate(function() {
    [
      { key: 'count_true_sneak',  fn: () => db('alarm_groups').where('pdw_count', '>', 0).count('* as msgcount') },
      { key: 'count_false_sneak', fn: () => db('alarm_groups').count('* as msgcount') },
    ].reduce(function(chain, item) {
      return chain.then(function() {
        return getCachedCount(item.key, item.fn)
          .then(function() { logger.main.info('Count cache pre-warmed: ' + item.key); })
          .catch(function() {});
      });
    }, Promise.resolve());
  });
}

// initData is created per-request inside the GET /messages handler (request-local to avoid race conditions)

// auth variables
const HideCapcode = nconf.get('messages:HideCapcode');
const apiSecurity = nconf.get('messages:apiSecurity');
const dbtype = nconf.get('database:type');

// dupe init
const msgBuffer = [];

// Count cache — voorkomt COUNT full table scan op elke pagina-load.
// Slaat het in-flight Promise op zodat gelijktijdige cache-misses dezelfde
// DB query delen in plaats van elk een eigen zware query te vuren.
// TTL 120s normaal, 300s voor sneak/stats (COUNT DISTINCT kost 200ms+ bij grote feed).
// Bij message-inserts wordt de cache NIET direct geleegd — de TTL doet dat werk.
// Alleen capcode-wijzigingen legen de cache direct (invalidateCountCache).
const _countCache = {};
const COUNT_TTL      = 120000;
const COUNT_TTL_LONG = 300000;
function getCachedCount(key, buildFn) {
  const now = Date.now();
  const ttl = (key === 'stats_total' || key.includes('sneak')) ? COUNT_TTL_LONG : COUNT_TTL;
  const entry = _countCache[key];
  if (entry && (now - entry.ts) < ttl) {
    return entry.promise;
  }
  const promise = buildFn().catch(err => {
    delete _countCache[key];
    throw err;
  });
  _countCache[key] = { promise, ts: now };
  return promise;
}
function invalidateCountCache() { Object.keys(_countCache).forEach(k => delete _countCache[k]); }

// Cached config snapshot for POST /messages hot path — avoids fs.readFileSync + JSON.parse per message.
// Refreshes at most once every 5 seconds so admin config changes still take effect quickly.
let _msgCfg = null;
let _msgCfgTime = 0;
function getMsgConfig() {
  const now = Date.now();
  if (_msgCfg && now - _msgCfgTime < 5000) return _msgCfg;
  nconf.load();
  _msgCfg = {
    filterDupes: nconf.get('messages:duplicateFiltering'),
    dupeLimit:   nconf.get('messages:duplicateLimit') || 0,
    dupeTime:    nconf.get('messages:duplicateTime') || 0,
    pdwMode:     nconf.get('messages:pdwMode'),
    adminShow:   nconf.get('messages:adminShow'),
  };
  _msgCfgTime = now;
  return _msgCfg;
}

// Cached config snapshot for GET /messages — avoids fs.readFileSync + JSON.parse per request.
// Refreshes at most once every 5 seconds so admin config changes still take effect quickly.
let _getCfg = null;
let _getCfgTime = 0;
function getGetConfig() {
  const now = Date.now();
  if (_getCfg && now - _getCfgTime < 5000) return _getCfg;
  nconf.load();
  _getCfg = {
    pdwMode:      nconf.get('messages:pdwMode'),
    adminShow:    nconf.get('messages:adminShow'),
    maxLimit:     nconf.get('messages:maxLimit'),
    defaultLimit: nconf.get('messages:defaultLimit'),
    HideCapcode:  nconf.get('messages:HideCapcode'),
    replaceText:  nconf.get('messages:replaceText'),
  };
  _getCfgTime = now;
  return _getCfg;
}

// In-process capcode pattern cache (avoids full table scan per message)
let _capPatterns = null; // null=unloaded, []=loaded (empty or with patterns)

function _loadCapPatterns() {
  return db('capcodes').select('id', 'address', 'ignore').then(function(rows) {
    rows.sort(function(a, b) {
      const ra = a.address.replace(/_/g, '%');
      const rb = b.address.replace(/_/g, '%');
      return ra < rb ? 1 : ra > rb ? -1 : 0;
    });
    _capPatterns = rows.map(function(cap) {
      return {
        id: cap.id,
        ignore: cap.ignore,
        regex: new RegExp('^' +
          cap.address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')
      };
    });
    logger.main.debug('Capcode cache loaded: ' + _capPatterns.length + ' patterns');
    return _capPatterns;
  });
}

function invalidateCapcodeCache() {
  _capPatterns = null;
  invalidateCountCache();
  logger.main.debug('Capcode cache invalidated');
}

function lookupCapcode(address) {
  // FLEX fragmentation can produce space-separated multi-address strings; try each part in order
  const parts = address.split(' ').filter(Boolean);
  const load = _capPatterns !== null ? Promise.resolve(_capPatterns) : _loadCapPatterns();
  return load.then(function(patterns) {
    for (const part of parts) {
      for (let i = 0; i < patterns.length; i++) {
        if (patterns[i].regex.test(part)) return { id: patterns[i].id, ignore: patterns[i].ignore };
      }
    }
    return null;
  });
}


router.route('/messages')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    const cfg = getGetConfig();
    let pdwMode = cfg.pdwMode;
    if (req.query.pdwMode === '1') pdwMode = true;
    else if (req.query.pdwMode === '0') pdwMode = false;
    const adminShow = cfg.adminShow;
    const maxLimit = cfg.maxLimit;
    const defaultLimit = cfg.defaultLimit;
    const HideCapcode = cfg.HideCapcode;
    const initData = {
      limit: parseInt(defaultLimit, 10),
      replaceText: cfg.replaceText,
      currentPage: 0,
      pageCount: 0,
      msgCount: 0,
      offset: 0,
    };
    if (typeof req.query.page !== 'undefined') {
      const page = parseInt(req.query.page, 10);
      if (page > 0) {
        initData.currentPage = page - 1;
      } else {
        initData.currentPage = 0;
      }
    }
    const reqLimit = parseInt(req.query.limit, 10);
    if (reqLimit >= 1 && reqLimit <= maxLimit) {
      initData.limit = reqLimit;
    }
    let subquery;
    if (pdwMode) {
      if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
        subquery = db.from('capcodes').where('ignore', '=', 1).select('id')
      } else {
        subquery = db.from('capcodes').where('ignore', '=', 0).whereNotNull('alias').whereNot('alias', '').select('id')
      }
    } else {
      subquery = db.from('capcodes').where('ignore', '=', 1).select('id')
    }
    // Count unique alarms (distinct timestamp+message pairs) for correct pagination
    // For MySQL/MariaDB use anti-join (LEFT JOIN IS NULL) to allow index usage.
    // NOT IN ... OR IS NULL prevents index use and causes full table scans.
    const isMysqlCount = (dbtype === 'mysql' || dbtype === 'mysql2');
    const isAuth = req.isAuthenticated();
    const isSneakpeek = req.query.sneakpeek === '1';

    const role = isAuth ? (req.user && req.user.role === 'admin' ? 'admin' : 'user') : (isSneakpeek ? 'sneak' : 'anon');
    const cacheKey = `count_${pdwMode}_${role}`;
    let countQuery;
    if (isMysqlCount) {
      if (pdwMode && !(adminShow && isAuth && req.user.role == 'admin')) {
        // PDW non-admin: only show ignored=0 capcodes with alias
        countQuery = getCachedCount(cacheKey, () => db.raw(
          `SELECT COUNT(DISTINCT CONCAT(m.timestamp,'|',m.message)) AS msgcount
           FROM messages m
           INNER JOIN capcodes cc ON cc.id = m.alias_id AND cc.\`ignore\` = 0
             AND cc.alias IS NOT NULL AND cc.alias != ''`,
          []
        ).then(r => [{ msgcount: r[0][0].msgcount }]));
      } else if (!isAuth && !isSneakpeek) {
        // Unauthenticated: exclude ignored + onlyShowLoggedIn
        countQuery = getCachedCount(cacheKey, () => db.raw(
          `SELECT COUNT(DISTINCT CONCAT(m.timestamp,'|',m.message)) AS msgcount
           FROM messages m
           LEFT JOIN capcodes cc_ign  ON cc_ign.id  = m.alias_id AND cc_ign.\`ignore\` = 1
           LEFT JOIN capcodes cc_priv ON cc_priv.id = m.alias_id AND cc_priv.onlyShowLoggedIn = 1
           WHERE cc_ign.id IS NULL AND cc_priv.id IS NULL`,
          []
        ).then(r => [{ msgcount: r[0][0].msgcount }]));
      } else {
        // Authenticated or PDW admin: exclude ignored only
        countQuery = getCachedCount(cacheKey, () => db.raw(
          `SELECT COUNT(DISTINCT CONCAT(m.timestamp,'|',m.message)) AS msgcount
           FROM messages m
           LEFT JOIN capcodes cc_ign ON cc_ign.id = m.alias_id AND cc_ign.\`ignore\` = 1
           WHERE cc_ign.id IS NULL`,
          []
        ).then(r => [{ msgcount: r[0][0].msgcount }]));
      }
    } else {
      // SQLite: gebruik alarm_groups voor snelle COUNT zonder DISTINCT full-scan.
      // PDW non-admin (sneak/user): tel alleen alarmen met ≥1 geldig PDW-adres.
      // Anon zonder sneakpeek: onlyShowLoggedIn-filter vereist de complexe query.
      // Admin / non-PDW: alle alarmen.
      if (!isAuth && !isSneakpeek) {
        // Anon: bestaande query — filtert ook onlyShowLoggedIn correct.
        countQuery = getCachedCount(cacheKey, () => db.count('* as msgcount').from(function () {
          this.from('messages')
            .where(function () {
              this.where(function() {
                this.whereNull('alias_id').orWhereNotIn('alias_id', function() {
                  this.select('id').from('capcodes').where('onlyShowLoggedIn', 1);
                });
              });
              if (pdwMode) {
                this.from('messages').where('alias_id', 'in', subquery);
              } else {
                this.from('messages').where('alias_id', 'not in', subquery).orWhereNull('alias_id');
              }
            })
            .distinct(db.raw("messages.timestamp || '|' || messages.message"))
            .as('sub');
        }));
      } else if (pdwMode && !(adminShow && isAuth && req.user.role == 'admin')) {
        // PDW sneak / normale gebruiker: alarm_groups.pdw_count > 0
        countQuery = getCachedCount(cacheKey, () =>
          db('alarm_groups').where('pdw_count', '>', 0).count('* as msgcount')
        );
      } else {
        // Admin of non-PDW: alle alarm_groups
        countQuery = getCachedCount(cacheKey, () =>
          db('alarm_groups').count('* as msgcount')
        );
      }
    }
    countQuery
      .then(function (initcount) {
        initData.msgCount = initcount[0].msgcount;
        initData.pageCount = Math.ceil(initData.msgCount / initData.limit);
        if (initData.currentPage >= initData.pageCount) {
          initData.currentPage = 0;
        }
        initData.offset = initData.limit * initData.currentPage;
        if (initData.offset < 0) {
          initData.offset = 0;
        }
        initData.offsetEnd = initData.offset + initData.limit;

        // Step 1: get the N unique alarm groups (timestamp+message) for this page
        return db.from('messages')
          .distinct('messages.timestamp', 'messages.message')
          .modify(function (queryBuilder) {
            if (!req.isAuthenticated() && req.query.sneakpeek !== '1') queryBuilder.where('capcodes.onlyShowLoggedIn', false);
            if (pdwMode) {
              if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
                queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).orWhereNull('capcodes.ignore')
              } else {
                queryBuilder.innerJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).whereNotNull('capcodes.alias').whereNot('capcodes.alias', '')
              }
            } else {
              queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).orWhereNull('capcodes.ignore')
            }
          })
          .orderBy('messages.timestamp', 'desc')
          .limit(initData.limit)
          .offset(initData.offset);
      })
      .then(function (groups) {
        if (!groups || groups.length === 0) {
          return res.status(200).json({ 'init': {}, 'messages': [] });
        }

        const groupTimestamps = groups.map(g => g.timestamp);
        const minTs = Math.min(...groupTimestamps);
        const maxTs = Math.max(...groupTimestamps);

        // Build a Set of 'timestamp|message' keys for fast JS filtering
        const groupKeys = new Set(groups.map(g => g.timestamp + '|' + g.message));

        // Step 2: For MySQL use BETWEEN on the timestamp index — avoids 20 OR TEXT comparisons.
        // For SQLite keep the OR approach (local file, no performance issue).
        const isMysqlQuery = (dbtype === 'mysql' || dbtype === 'mysql2');
        const step2 = isMysqlQuery
          ? db.from('messages')
              .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
              .modify(function (queryBuilder) {
                if (!req.isAuthenticated() && req.query.sneakpeek !== '1') queryBuilder.where('capcodes.onlyShowLoggedIn', false);
                if (pdwMode) {
                  if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
                    queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where(function() { this.where('capcodes.ignore', 0).orWhereNull('capcodes.ignore'); })
                  } else {
                    queryBuilder.innerJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).whereNotNull('capcodes.alias').whereNot('capcodes.alias', '')
                  }
                } else {
                  queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where(function() { this.where('capcodes.ignore', 0).orWhereNull('capcodes.ignore'); })
                }
              })
              .whereBetween('messages.timestamp', [minTs, maxTs])
              .orderBy('messages.timestamp', 'desc')
          : db.from('messages')
              .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
              .modify(function (queryBuilder) {
                if (!req.isAuthenticated() && req.query.sneakpeek !== '1') queryBuilder.where('capcodes.onlyShowLoggedIn', false);
                if (pdwMode) {
                  if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
                    queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where(function() { this.where('capcodes.ignore', 0).orWhereNull('capcodes.ignore'); })
                  } else {
                    queryBuilder.innerJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where('capcodes.ignore', 0).whereNotNull('capcodes.alias').whereNot('capcodes.alias', '')
                  }
                } else {
                  queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id').where(function() { this.where('capcodes.ignore', 0).orWhereNull('capcodes.ignore'); })
                }
              })
              .where(function () {
                const self = this;
                groups.forEach(function (g) {
                  self.orWhere(function () { this.where('messages.timestamp', g.timestamp).where('messages.message', g.message); });
                });
              })
              .orderBy('messages.timestamp', 'desc');

        // FLEX lookup runs parallel with step 2
        // Range scan (>= / <) gebruikt de msg_index op address — 2× sneller dan LIKE
        const flexQuery = db.from('messages')
          .distinct('timestamp', 'message')
          .whereBetween('timestamp', [minTs, maxTs])
          .where('address', 'like', '002029%');

        return Promise.all([step2, flexQuery, Promise.resolve(groupKeys), Promise.resolve(isMysqlQuery)]);
      })
      .then(function ([rows, flexRows, groupKeys, isMysqlQuery]) {
        const result = [];
        const rowCount = rows ? rows.length : 0;
        if (rowCount === 0) {
          return res.status(200).json({ 'init': {}, 'messages': [] });
        }
        const flexKeys = new Set(flexRows.map(r => r.timestamp + '|' + r.message));
        for (let row of rows) {
          // MySQL BETWEEN returns extra rows — filter to only the 20 page groups
          if (isMysqlQuery && groupKeys && !groupKeys.has(row.timestamp + '|' + row.message)) continue;
          row.datetime = row.timestamp; // Copy timestamp to datetime for backwards compatibility
          row.isFlexGroup = flexKeys.has(row.timestamp + '|' + row.message);
          if (HideCapcode) {
            if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role == 'user')) {
              row = {
                "id": row.id,
                "message": row.message,
                "source": row.source,
                "timestamp": row.timestamp,
                "datetime": row.datetime,
                "alias_id": row.alias_id,
                "alias": row.alias,
                "agency": row.agency,
                "icon": row.icon,
                "color": row.color,
                "ignore": row.ignore
              };
            }
          }
          if (row) result.push(row);
        }
        res.status(200).json({ 'init': initData, 'messages': result });
      })
      .catch(function (err) {
        logger.main.error(err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      });
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    if (req.body.address && req.body.message) {
      const cfg = getMsgConfig();
      const filterDupes = cfg.filterDupes;
      const dupeLimit = cfg.dupeLimit;
      const dupeTime = cfg.dupeTime;
      const pdwMode = cfg.pdwMode;
      const adminShow = cfg.adminShow;
      let data = req.body;
      data.pluginData = {};
      let timestamp;

      if (filterDupes) {
        // this is a bad solution and tech debt that will bite us in the ass if we ever go HA, but that's a problem for future me and that guy's a dick

        timestamp = data.timestamp || data.datetime || 1;

        const timeDiff = timestamp - dupeTime;
        // if duplicate filtering is enabled, we want to populate the message buffer and check for duplicates within the limits
        const matches = msgBuffer.filter(function(m) { return m.message === data.message && m.address === data.address; });
        if (matches.length > 0) {
          if (dupeTime != 0) {
            // search the matching messages and see if any match the time constrain
            const timeFind = matches.find(function (msg) { return msg.timestamp > timeDiff; });
            if (timeFind) {
              logger.main.info(util.format('Ignoring duplicate: %o', data.message));
              return res.status(200).send('Ignoring duplicate');
            }
          } else {
            // if no dupeTime then just end the search now, we have matches
            logger.main.info(util.format('Ignoring duplicate: %o', data.message));
            return res.status(200).send('Ignoring duplicate');
          }
        }
        // no matches, maintain the array
        let dupeArrayLimit = dupeLimit;
        if (dupeArrayLimit == 0) {
          dupeArrayLimit = 25; // should provide sufficient buffer, consider increasing if duplicates appear when users have no dupeLimit
        }
        if (msgBuffer.length > dupeArrayLimit) {
          msgBuffer.shift();
        }
        msgBuffer.push(pick(data,['message', 'timestamp', 'address']));
      }

        if (data.timestamp)
          timestamp = data.timestamp;
        else if (data.datetime) {
          logger.main.warn(`An incoming message from ${data.source || 'an unknown source' } contains the timestamp as field 'datetime'. Update the message source to use the variable 'timestamp' instead!`);
          timestamp = data.datetime;
        } else
          timestamp = 1;

        // Ensure timestamp is always stored as an integer (Unix seconds)
        timestamp = parseInt(timestamp, 10);
        if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = Math.floor(Date.now() / 1000);

      // send data to pluginHandler before proceeding
      logger.main.debug('beforeMessage start');
      pluginHandler.handle('message', 'before', data, function (response) {
        logger.main.debug(util.format('%o', response));
        logger.main.debug('beforeMessage done');
        if (response && response.pluginData) {
          // only set data to the response if it's non-empty and still contains the pluginData object
          data = response;
        }
        if (data.pluginData.ignore) {
          // stop processing
          return res.status(200).send('Ignoring filtered');
        }
        const address = data.address || '0000000';
        const message = data.message || 'null';
        const timeDiff = timestamp - dupeTime;
        const source = data.source || 'UNK';
        db.from('messages')
          .select('id')
          .modify(function (queryBuilder) {
            queryBuilder.where('address', '=', address)
              .andWhere('message', '=', message);
            if (dupeTime != 0) {
              queryBuilder.andWhere('timestamp', '>', timeDiff);
            }
            if (dupeLimit != 0) {
              queryBuilder.orderBy('id', 'desc').limit(dupeLimit);
            }
          })
          .then((row) => {
            if (row.length > 0 && filterDupes) {
              logger.main.info(util.format('Ignoring duplicate: %o', message));
              res.status(200).send('Ignoring duplicate');
            } else {
              (dbtype === 'oracledb'
                ? db.from('capcodes').select('id', 'ignore')
                    .whereRaw('? LIKE "address"', [address])
                    .orderByRaw(`REPLACE("address", '_', '%') DESC`)
                    .then(function(rows) { return rows.length > 0 ? rows[0] : null; })
                : lookupCapcode(address)
              ).then((capResult) => {
                  let insert;
                  let alias_id = null;
                  if (capResult !== null) {
                    if (capResult.ignore == 1) {
                      insert = false;
                      logger.main.info('Ignoring filtered address: ' + address + ' alias: ' + capResult.id);
                    } else {
                      insert = true;
                      alias_id = capResult.id;
                    }
                  } else {
                    insert = true;
                  }

                  // overwrite alias_id if set from plugin
                  if (data.pluginData.aliasId) {
                    alias_id = data.pluginData.aliasId;
                  }

                  if (insert === true) {
                    const insertmsg = { address, message, timestamp, source, alias_id }
                    db('messages').insert(insertmsg)
                      .then((result) => {
                        // emit the full message
                        const msgId = Object.keys(result[0]).includes('id') ? result[0].id : result[0];

                        if (dbtype == 'oracledb') {
                          // oracle requires update of search index after insert, can't be trigger for some reason
                          db.raw(`BEGIN CTX_DDL.SYNC_INDEX('search_idx'); END;`)
                            .then((resp) => {
                              logger.main.debug('search_idx sync complete');
                              logger.main.debug(resp);
                            }).catch((err) => {
                              logger.main.error('search_idx sync failed');
                              logger.main.error(err)
                            });
                        }

                        db.from('messages')
                          .select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', 'capcodes.pluginconf', 'capcodes.onlyShowLoggedIn')
                          .modify(function (queryBuilder) {
                            queryBuilder.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
                          })
                          .where('messages.id', '=', msgId)
                          .then((row) => {
                            if (row.length > 0) {
                              row = row[0]
                              // send data to pluginHandler after processing
                              row.pluginData = data.pluginData;

                              // Copy timestamp to datetime for backwards compatibility.
                              row.datetime = row.timestamp;

                              if (row.pluginconf) {
                                row.pluginconf = parseJSON(row.pluginconf);
                              } else {
                                row.pluginconf = {};
                              }
                              // Check if this message is part of a FLEX group (routing capcode 002029xxx present)
                              db.from('messages')
                                .count('* as cnt')
                                .where('timestamp', '=', row.timestamp)
                                .where('message', '=', row.message)
                                .where('address', 'like', '002029%')
                                .then(([{ cnt }]) => { row.isFlexGroup = cnt > 0; })
                                .catch(() => { row.isFlexGroup = false; })
                                .finally(() => {
                              logger.main.debug('afterMessage start');
                              pluginHandler.handle('message', 'after', row, function (response) {
                                logger.main.debug(util.format('%o', response));
                                logger.main.debug('afterMessage done');
                                // remove the pluginconf object before firing socket message
                                delete row.pluginconf;
                                const fields = ['id','message','source','timestamp','datetime','alias_id','alias','agency','icon','color','ignore','isFlexGroup','onlyShowLoggedIn']
                                if (!HideCapcode) fields.push('address') // Show address, when hideCapcode is off.
                                const rowUser = pick(row, fields)

                                req.io.to('admin').emit('messagePost',row);
                                req.io.to('user').emit('messagePost',rowUser);
                                if(!row.onlyShowLoggedIn) req.io.to('anonymous').emit('messagePost',rowUser);
                                // Sneakpeek users see all messages (same as API with sneakpeek=1)
                                req.io.to('sneakpeek').emit('messagePost',rowUser);

                                // Stuur push-notificatie naar geabonneerde browsers
                                // We sturen bericht, timestamp en labels mee zodat we labels uit de tekst kunnen filteren
                                var _addr = parseInt(row.address, 10);
                                var _isGroupCapcode = _addr >= 2029568 && _addr <= 2029583;
                                if (!row.onlyShowLoggedIn && !_isGroupCapcode) {
                                  sendPushNotifications({
                                    message: row.message,
                                    timestamp: row.timestamp,
                                    alias: row.alias,
                                    agency: row.agency
                                  });
                                }

                              });
                                }); // end isFlexGroup finally
                            }
                            res.status(200).send('' + msgId);
                          })
                          .catch((err) => {
                            res.status(500).json({ error: 'Internal server error' });
                            logger.main.error(err)
                          })
                      })
                      .catch((err) => {
                        res.status(500).json({ error: 'Internal server error' });
                        logger.main.error(err)
                      })
                  } else {
                    res.status(200).send('Ignoring filtered');
                  }
                })
                .catch((err) => {
                  res.status(500).json({ error: 'Internal server error' });
                  logger.main.error(err)
                })
            }
          })
          .catch((err) => {
            res.status(500).json({ error: 'Internal server error' });
            logger.main.error(err)
          })
      })
    } else {
      res.status(400).json({ message: 'Error - address or message missing' });
    }
  });


  router.route('/messages/:id')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    const pdwMode = nconf.get('messages:pdwMode');
    const HideCapcode = nconf.get('messages:HideCapcode');
    const apiSecurity = nconf.get('messages:apiSecurity');
    const id = req.params.id;

    db.from('messages')
      .select(
        'messages.*',
        'capcodes.alias',
        'capcodes.agency',
        'capcodes.icon',
        'capcodes.color',
        'capcodes.ignore',
        db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard')
      )
      .leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
      .where('messages.id', id)
      .modify((qb) => {
        if (!req.isAuthenticated()) qb.where('capcodes.onlyShowLoggedIn', false);
      })
      .then((row) => {
        if (row.length === 0) {
          return res.status(200).json({});
        }

        let responseData;
        if (HideCapcode) {
          if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role === 'user')) {
            responseData = {
              id: row[0].id,
              message: row[0].message,
              source: row[0].source,
              datetime: row[0].timestamp,
              timestamp: row[0].timestamp,
              alias_id: row[0].alias_id,
              alias: row[0].alias,
              agency: row[0].agency,
              icon: row[0].icon,
              color: row[0].color,
              ignore: row[0].ignore
            };
          } else {
            responseData = row[0]; // Default behavior if HideCapcode is false
          }
        } else {
          responseData = row[0];
        }
        // Apply additional conditions for the final response
        if (responseData.ignore === 1) {
          res.status(200).json({});
        } else if (pdwMode && !responseData.alias) {
          res.status(200).json({});
        } else {
          res.status(200).json(responseData); // Use responseData instead of row
        }
      })
      .catch((err) => {
        logger.main.error(err);
        res.status(500).json({ error: 'Internal server error' });
      });
  });

router.route('/messageSearch')
  .get(authHelper.isLoggedInMessages, function (req, res, next) {
    nconf.load();
    const dbtype = nconf.get('database:type');
    let pdwMode = nconf.get('messages:pdwMode');
    if (req.query.pdwMode === '1') pdwMode = true;
    else if (req.query.pdwMode === '0') pdwMode = false;
    const adminShow = nconf.get('messages:adminShow');
    const maxLimit = nconf.get('messages:maxLimit');
    const HideCapcode = nconf.get('messages:HideCapcode');
    const apiSecurity = nconf.get('messages:apiSecurity');
    const defaultLimit = nconf.get('messages:defaultLimit');
    const initData = {
      limit: parseInt(defaultLimit, 10),
      replaceText: nconf.get('messages:replaceText'),
      currentPage: 0,
      pageCount: 0,
      msgCount: 0,
      offset: 0,
    };

    if (typeof req.query.page !== 'undefined') {
      const page = parseInt(req.query.page, 10);
      if (page > 0) {
        initData.currentPage = page - 1;
      } else {
        initData.currentPage = 0;
      }
    }
    const reqLimit = parseInt(req.query.limit, 10);
    if (reqLimit >= 1 && reqLimit <= maxLimit) {
      initData.limit = reqLimit;
    } else {
      initData.limit = parseInt(defaultLimit, 10);
    }

    let rowCount;
    let query;
    let agency;
    let address;
    let alias;
    // dodgy handling for unexpected results
    if (typeof req.query.q !== 'undefined') {
      query = req.query.q;
    } else { query = ''; }
    if (typeof req.query.agency !== 'undefined') {
      agency = req.query.agency;
    } else { agency = ''; }
    if (typeof req.query.address !== 'undefined') {
      address = req.query.address;
    } else { address = ''; }
    if (typeof req.query.alias !== 'undefined') {
      alias = req.query.alias;
    } else { alias = ''; }

    // set select commands based on query type

    const data = []
    db.select('messages.*', 'capcodes.alias', 'capcodes.agency', 'capcodes.icon', 'capcodes.color', 'capcodes.ignore', db.raw('CASE WHEN NOT capcodes.address = messages.address THEN 1 ELSE 0 END as wildcard'))
      .modify(function (qb) {
        // Purely numeric terms are capcodes (9-digit address) or vehicle numbers
        // (in the message text). The SQLite FTS index only covers message/alias/
        // agency, so numeric searches use LIKE on the base table instead of FTS.
        const numericQuery = query != '' && /^[0-9]+$/.test(query);
        if (dbtype == 'sqlite3' && query != '' && !numericQuery) {
          qb.from('messages_search_index')
            .leftJoin('messages', 'messages.id', '=', 'messages_search_index.rowid')
        } else {
          qb.from('messages');
        }
        if (pdwMode) {
          if (adminShow && req.isAuthenticated() && req.user.role == 'admin') {
            qb.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id');
          } else {
            qb.innerJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id')
              .whereNotNull('capcodes.alias').whereNot('capcodes.alias', '');
          }
        } else {
          qb.leftJoin('capcodes', 'capcodes.id', '=', 'messages.alias_id');
        }
        if (!req.isAuthenticated() && req.query.sneakpeek !== '1') {
          qb.where(function() {
            this.whereNull('capcodes.onlyShowLoggedIn').orWhere('capcodes.onlyShowLoggedIn', false);
          });
        }
        if (dbtype == 'sqlite3' && numericQuery) {
          // Capcode / vehicle search: match the number anywhere in message,
          // address or source (address is zero-padded, so use a contains match).
          qb.where(function() {
            this.where('messages.message', 'like', '%' + query + '%')
                .orWhere('messages.address', 'like', '%' + query + '%')
                .orWhere('messages.source', 'like', '%' + query + '%');
          });
        } else if (dbtype == 'sqlite3' && query != '') {
          qb.whereRaw('messages_search_index MATCH ?', query)
        } else if ((dbtype == 'mysql' || dbtype == 'mysql2') && query != '') {
          //This wraps the search query in quotes so MySQL searches for the complete term rather than individual words.
          query = '"' + query + '"'
          qb.whereRaw(`MATCH(messages.message, messages.address, messages.source) AGAINST (? IN BOOLEAN MODE)`, query)
        } else if (dbtype == 'oracledb' && query != '') {
          qb.whereRaw(`CONTAINS("messages"."message", ?, 1) > 0`, query)
        } else {
          if (address != '')
            qb.where('messages.address', 'LIKE', address).orWhere('messages.source', address);
          if (agency != '')
            qb.whereIn('messages.alias_id', function (qb2) {
              qb2.select('id').from('capcodes').where('agency', agency).where('ignore', 0);
          })
          if (alias != '') {
            if (alias === '-1') 
              qb.whereNull('messages.alias_id');
            else
              qb.where('messages.alias_id',alias);
          }
        }
      }).orderBy('messages.timestamp', 'desc')
      .limit(10001)   // cap: 10000 DB rows (~2000–5000 alarms). Row 10001 signals truncation.
      .then((rows) => {
        const truncated = rows && rows.length > 10000;
        if (truncated) rows = rows.slice(0, 10000);
        if (rows) {
          for (let row of rows) {
            row.datetime = row.timestamp // Copy timestamp to datetime for backwards compatibility
            if (HideCapcode) {
              if (!req.isAuthenticated() || (req.isAuthenticated() && req.user.role == 'user')) {
                row = {
                  "id": row.id,
                  "message": row.message,
                  "source": row.source,
                  "datetime": row.datetime,
                  "timestamp": row.timestamp,
                  "alias_id": row.alias_id,
                  "alias": row.alias,
                  "agency": row.agency,
                  "icon": row.icon,
                  "color": row.color,
                  "ignore": row.ignore
                };
              }
            }
            if (pdwMode) {
              if (adminShow && req.isAuthenticated() && req.user.role == 'admin' && (!row.ignore || row.ignore == 0)) {
                data.push(row);
              } else {
                if (row.ignore == 0 && row.alias)
                  data.push(row);
              }
            } else {
              if (!row.ignore || row.ignore == 0)
                data.push(row);
            }
          }
        } else {
          logger.main.info('empty results');
        }
        // Group rows by unique alarm (timestamp+message) so pagination counts alarms, not capcode rows
        const groupOrder = [];
        const groupRows = {};
        data.forEach(function(row) {
          const key = row.timestamp + '|' + row.message;
          if (!groupRows[key]) { groupRows[key] = []; groupOrder.push(key); }
          groupRows[key].push(row);
        });
        rowCount = groupOrder.length;
        if (rowCount === 0) {
          return res.status(200).json({ 'init': {}, 'messages': [] });
        }
        initData.msgCount = rowCount;
        initData.pageCount = Math.ceil(initData.msgCount / initData.limit);
        if (initData.currentPage >= initData.pageCount) {
          initData.currentPage = 0;
        }
        initData.offset = initData.limit * initData.currentPage;
        if (initData.offset < 0) {
          initData.offset = 0;
        }
        initData.offsetEnd = initData.offset + initData.limit;
        const pageGroupKeys = groupOrder.slice(initData.offset, initData.offsetEnd);
        const limitResults = [];
        pageGroupKeys.forEach(function(key) { groupRows[key].forEach(function(row) { limitResults.push(row); }); });
        // Look up FLEX group routing capcodes for the timestamps in these results
        const timestamps = [...new Set(limitResults.map(r => r.timestamp))];
        return db.from('messages')
          .distinct('timestamp', 'message')
          .whereIn('timestamp', timestamps)
          .where('address', 'like', '002029%')
          .then(flexRows => {
            const flexKeys = new Set(flexRows.map(r => r.timestamp + '|' + r.message));
            limitResults.forEach(row => { row.isFlexGroup = flexKeys.has(row.timestamp + '|' + row.message); });
            if (truncated) initData.truncated = true;
            res.json({ 'init': initData, 'messages': limitResults });
          });
      })
      .catch((err) => {
        logger.main.error(err);
        res.status(500).json({ error: 'Internal server error' });
      })
  });

router.route('/capcodes')
  .get(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    const dbtype = nconf.get('database:type');
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const limitRaw = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 50;
    const showAll  = limitRaw < 0;
    const limit    = showAll ? 99999 : Math.min(99999, Math.max(1, limitRaw || 50));
    const search   = (req.query.q || '').trim();
    const offset   = showAll ? 0 : (page - 1) * limit;

    const baseQuery = db.from('capcodes').modify(function (qb) {
      if (search) {
        qb.where(function () {
          this.where('address', 'like', '%' + search + '%')
              .orWhere('alias',   'like', '%' + search + '%')
              .orWhere('agency',  'like', '%' + search + '%');
        });
      }
    });

    Promise.all([
      baseQuery.clone().count('* as total').first(),
      baseQuery.clone().select('*')
        .modify(function (qb) {
          if (dbtype == 'oracledb')
            qb.orderByRaw(`REPLACE("address", '_', '%')`);
          else
            qb.orderByRaw(`REPLACE(address, '_', '%')`);
        })
        .limit(limit).offset(offset)
    ]).then(([countRow, rows]) => {
      res.json({ data: rows, total: parseInt(countRow.total), page, limit });
    }).catch((err) => {
      logger.main.error(err);
      return next(err);
    });
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    const updateRequired = nconf.get('database:aliasRefreshRequired');
    if (req.body.address && req.body.alias) {
      const id = req.body.id || null;
      const address = req.body.address || 0;
      const alias = req.body.alias || 'null';
      const agency = req.body.agency || 'null';
      const color = req.body.color || 'black';
      const icon = req.body.icon || 'question';
      const ignore = req.body.ignore || 0;
      const pluginconf = JSON.stringify(vaccumPluginConf(req.body.pluginconf)) || "{}";
      const onlyShowLoggedIn = req.body.onlyShowLoggedIn || false;
      db.from('capcodes')
        .where('id', '=', id)
        .modify(function (queryBuilder) {
          if (id == null) {
            queryBuilder.insert({
              id,
              address,
              alias,
              agency,
              color,
              icon,
              ignore,
              pluginconf,
              onlyShowLoggedIn,
            })
          } else {
            queryBuilder.update({
              id,
              address,
              alias,
              agency,
              color,
              icon,
              ignore,
              pluginconf,
              onlyShowLoggedIn,
            })
          }
        })
        .returning('id')
        .then((result) => {
          invalidateCapcodeCache();
          res.status(200).send('' + result);
          if (!updateRequired || updateRequired == 0) {
            nconf.set('database:aliasRefreshRequired', 1);
            nconf.save();
          }
        })
        .catch((err) => {
          logger.main.error(err);
          res.status(500).json({ error: 'Internal server error' });
        })
      logger.main.debug(util.format('%o', req.body || 'no request body'));
    } else {
      res.status(400).json({ message: 'Error - address or alias missing' });
    }
  });

router.route('/capcodes/agency')
  .get(authHelper.isAdmin, function (req, res, next) {
    db.from('capcodes')
      .distinct('agency')
      .then((rows) => {
        res.status(200);
        res.json(rows);
      })
      .catch((err) => {
        res.status(500).json({ error: 'Internal server error' });
      })
  });

router.route('/capcodes/agency/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    const id = req.params.id;
    db.from('capcodes')
      .select('*')
      .where('agency', 'like', id)
      .then((rows) => {
        res.status(200);
        res.json(rows);
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/capcodes/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    const id = req.params.id;
    const defaults = {
      "id": "",
      "address": "",
      "alias": "",
      "agency": "",
      "icon": "question",
      "color": "black",
      "ignore": 0,
      "pluginconf": {},
      "onlyShowLoggedIn": false,
    };
    if (id == 'new') {
      res.status(200);
      res.json(defaults);
    } else {
      db.from('capcodes')
        .select('*')
        .where('id', id)
        .then(function (row) {
          if (row.length > 0) {
            row = row[0]
            row.pluginconf = parseJSON(row.pluginconf);
            res.status(200);
            res.json(row);
          } else {
            res.status(200);
            res.json(defaults);
          }
        })
        .catch((err) => {
          logger.main.error(err);
          return next(err);
        })
    }
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    const dbtype = nconf.get('database:type');
    let id = req.params.id || req.body.id || null;
    nconf.load();
    const updateRequired = nconf.get('database:aliasRefreshRequired');
    if (id == 'deleteMultiple') {
      // do delete multiple
      const idList = req.body.deleteList || [0, 0];
      if (Array.isArray(idList) && !idList.some(isNaN)) {
        logger.main.info('Deleting: ' + idList);
        db.from('capcodes')
          .del()
          .where('id', 'in', idList)
          .then((result) => {
            invalidateCapcodeCache();
            res.status(200).send({ 'status': 'ok' });
            if (!updateRequired || updateRequired == 0) {
              nconf.set('database:aliasRefreshRequired', 1);
              nconf.save();
            }
          }).catch((err) => {
            res.status(500).json({ error: 'Internal server error' });
          })
      } else {
        res.status(500).send({ 'status': 'id list contained non-numbers' });
      }
    } else if (id == 'bulkUpdate') {
      const idList = req.body.idList || [];
      const fields = req.body.fields || {};
      const allowedFields = ['ignore', 'onlyShowLoggedIn'];
      const updateData = {};
      allowedFields.forEach(f => { if (f in fields) updateData[f] = fields[f]; });
      if (!Array.isArray(idList) || idList.some(isNaN) || idList.length === 0) {
        return res.status(400).send({ status: 'id list invalid or empty' });
      }
      if (Object.keys(updateData).length === 0) {
        return res.status(400).send({ status: 'no valid fields to update' });
      }
      logger.main.info('Bulk updating ' + idList.length + ' capcodes: ' + JSON.stringify(updateData));
      db.from('capcodes')
        .whereIn('id', idList)
        .update(updateData)
        .then(() => {
          invalidateCapcodeCache();
          res.status(200).send({ status: 'ok' });
          if (!updateRequired || updateRequired == 0) {
            nconf.set('database:aliasRefreshRequired', 1);
            nconf.save();
          }
        }).catch((err) => {
          res.status(500).json({ error: 'Internal server error' });
        });
    } else {
      if (req.body.address && req.body.alias) {
        if (id == 'new') {
          id = null;
        }
        const address = req.body.address || 0;
        const alias = req.body.alias || 'null';
        const agency = req.body.agency || 'null';
        const color = req.body.color || 'black';
        const icon = req.body.icon || 'question';
        const ignore = req.body.ignore || 0;
        const pluginconf = JSON.stringify(vaccumPluginConf(req.body.pluginconf)) || "{}";
        const updateAlias = req.body.updateAlias || 0;
        const onlyShowLoggedIn = req.body.onlyShowLoggedIn || 0;

        db.from('capcodes')
          .returning('id')
          .where('id', '=', id)
          .modify(function (queryBuilder) {
            if (id == null) {
              queryBuilder.insert({
                id,
                address,
                alias,
                agency,
                color,
                icon,
                ignore,
                pluginconf,
                onlyShowLoggedIn
              })
            } else {
              queryBuilder.update({
                id,
                address,
                alias,
                agency,
                color,
                icon,
                ignore,
                pluginconf,
                onlyShowLoggedIn
              })
            }
          })
          .then((result) => {
            invalidateCapcodeCache();
            if (updateAlias == 1) {
              db('messages')
                .update('alias_id', function () {
                  this.select('id')
                    .from('capcodes')
                    .whereRaw('messages.address LIKE capcodes.address')
                    .modify(function (queryBuilder) {
                      if (dbtype == 'oracledb')
                        queryBuilder.orderByRaw(`REPLACE("address", '_', '%') DESC`);
                      else
                        queryBuilder.orderByRaw(`REPLACE(address, '_', '%') DESC`)
                    })
                    .limit(1)
                })
                .catch((err) => {
                  logger.main.error(err);
                })
            } else {
              //Check if we can refresh just this specific alias
              const specificRefresh = nconf.get('global:SpecificAliasRefresh');
              if (specificRefresh && /^\d+$/.test(req.body.address)) {
                //Refresh this specific Alias
                db('messages').update('alias_id', function () {
                  this.select('id')
                    .from('capcodes')
                    .where(db.ref('messages.address'), 'like', db.ref('capcodes.address'))
                    .modify(function (queryBuilder) {
                      if (dbtype == 'oracledb')
                        queryBuilder.orderByRaw(`REPLACE("address", '_', '%') DESC`);
                      else
                        queryBuilder.orderByRaw(`REPLACE(address, '_', '%') DESC`)
                  })
                  .limit(1)
                })
                .where(db.ref('messages.address'), '=', req.body.address)
                .catch((err) => {
                  logger.main.error(err);
                })
              } else {
                //We cannot update this specific Alias, so inform of required Alias Refresh
                if (!updateRequired || updateRequired == 0) {
                  nconf.set('database:aliasRefreshRequired', 1);
                  nconf.save();
                }
              }
            }
            res.status(200).send({ 'status': 'ok', 'id': result })
          })
          .catch((err) => {
            logger.main.error(err)
            res.status(500).json({ error: 'Internal server error' });
          })
        logger.main.debug(util.format('%o', req.body || 'request body empty'));
      } else {
        res.status(400).json({ message: 'Error - address or alias missing' });
      }
    }
  })
  .delete(authHelper.isAdmin, function (req, res, next) {
    // delete single alias
    const id = parseInt(req.params.id, 10);
    nconf.load();
    const updateRequired = nconf.get('database:aliasRefreshRequired');
    logger.main.info('Deleting ' + id);
    db.from('capcodes')
      .del()
      .where('id', id)
      .then((result) => {
        invalidateCapcodeCache();
        res.status(200).send({ 'status': 'ok' });
        if (!updateRequired || updateRequired == 0) {
          nconf.set('database:aliasRefreshRequired', 1);
          nconf.save();
        }
      })
      .catch((err) => {
        res.status(500).json({ error: 'Internal server error' });
      })
    logger.main.debug(util.format('%o', req.body || 'request body empty'));
  });

router.route('/capcodeCheck/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    const id = req.params.id;
    db.from('capcodes')
      .select('*')
      .where('address', id)
      .then((row) => {
        if (row.length > 0) {
          row = row[0]
          row.pluginconf = parseJSON(row.pluginconf);
          res.status(200);
          res.json(row);
        } else {
          row = {
            "id": "",
            "address": "",
            "alias": "",
            "agency": "",
            "icon": "question",
            "color": "black",
            "ignore": 0,
            "pluginconf": {},
            "onlyShowLoggedIn": 0
          };
          res.status(200);
          res.json(row);
        }
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/capcodeRefresh')
  .post(authHelper.isAdmin, async function (req, res, next) {
    nconf.load();
    try {
      // 1. Laad alle capcodes in geheugen, sorteer most-specific-first
      //    (zelfde logica als SQL: DESC REPLACE(address,'_','%'))
      const capcodes = await db('capcodes').select('id', 'address');
      capcodes.sort((a, b) => {
        const ra = a.address.replace(/_/g, '%');
        const rb = b.address.replace(/_/g, '%');
        return ra < rb ? 1 : ra > rb ? -1 : 0;
      });
      const capPatterns = capcodes.map(cap => ({
        id: cap.id,
        regex: new RegExp('^' +
          cap.address
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex
            .replace(/%/g, '.*')                      // % = willekeurig veel
            .replace(/_/g, '.')                       // _ = één char
          + '$', 'i')
      }));

      // 2. Haal unieke adressen op (4.313 vs 84.147 rijen)
      const addresses = await db('messages').distinct('address').pluck('address');

      // 3. Koppel elk uniek adres aan de best-passende capcode
      const addrMap = new Map();
      for (const address of addresses) {
        let aliasId = null;
        for (const cap of capPatterns) {
          if (cap.regex.test(address)) {
            aliasId = cap.id;
            break;
          }
        }
        addrMap.set(address, aliasId);
      }

      // 4. Batch-update in één transactie
      await db.transaction(async trx => {
        for (const [address, aliasId] of addrMap) {
          await trx('messages').where('address', address).update({ alias_id: aliasId });
        }
      });

      nconf.set('database:aliasRefreshRequired', 0);
      nconf.save();
      res.status(200).send({ status: 'ok' });
    } catch (err) {
      logger.main.error(err);
      next(err);
    }
  });

router.route('/capcodeExport')
  .post(authHelper.isAdmin, function (req, res, next) {
    nconf.load();
    const dbtype = nconf.get('database:type');
    const filename = 'export.csv'
    db.from('capcodes')
      .select('*')
      .modify(function (queryBuilder) {
        if (dbtype == 'oracledb')
          queryBuilder.orderByRaw(`REPLACE("address", '_', '%')`);
        else
          queryBuilder.orderByRaw(`REPLACE(address, '_', '%')`)
      })
      .then((rows) => {
        converter.json2csv(rows, function (err, data) {
          if (err) {
            res.status(500).json({ error: 'Internal server error' });
          } else {
            res.status(200).send({ 'status': 'ok', 'data': data })
          }
        })
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/capcodeImport')
  .post(authHelper.isAdmin, function (req, res, next) {
    // Body can be { rows: [...], deleteAll: bool } (new) or a plain array (legacy).
    const rawRows = Array.isArray(req.body) ? req.body : (req.body.rows || []);
    const deleteAll = !Array.isArray(req.body) && !!req.body.deleteAll;
    for (const key in rawRows) {
      //remove newline chars from dataset - yes i realise we are adding them in admin.main.js, it doesn't submit without them.
      rawRows[key] = rawRows[key].replace(/[\r\n]/g, '');
    }
    // join data but remove the last newline to prevent the last one being malformed.
    const importdata = rawRows.join('\n').slice(0, -1);
    const importresults = [];
    converter.csv2jsonAsync(importdata)
      .then(async (data) => {
        const header = data[0]
        if (('address' in header) && ('alias' in header)) {
          //this checks if the csv has the required headings, should replace this with some form of proper validation
          await db.transaction(async (trx) => {
            if (deleteAll) {
              await trx('capcodes').delete();
              logger.main.info('Import: alle bestaande capcodes verwijderd voor import.');
            }
            for (const capcode of data) {
              const address = capcode.address || 0;
              const alias = capcode.alias || 'null';
              const agency = capcode.agency || 'null';
              const color = capcode.color || 'black';
              const icon = capcode.icon || 'question';
              const ignore = capcode.ignore || 0;
              const pluginconf = JSON.stringify(vaccumPluginConf(capcode.pluginconf)) || "{}";
              const onlyShowLoggedIn = capcode.onlyShowLoggedIn || false;
              await trx('capcodes')
                .where('address', '=', address)
                .first()
                .then((rows) => {
                  if (rows) {
                    //Update the existing alias if one is found.
                    return trx('capcodes')
                      .where('id', '=', rows.id)
                      .update({
                        address,
                        alias,
                        agency,
                        color,
                        icon,
                        ignore,
                        pluginconf,
                        onlyShowLoggedIn,
                      })
                      .then((result) => {
                        importresults.push({
                          address: address,
                          alias: alias,
                          result: 'updated'
                        })
                      })
                      .catch((err) => {
                        importresults.push({
                          address: address,
                          alias: alias,
                          result: 'failed ' + err
                        })
                      })
                  } else {
                    //Create new alias if one didn't get returned.
                    return trx('capcodes').insert({
                      id: null,
                      address,
                      alias,
                      agency,
                      color,
                      icon,
                      ignore,
                      pluginconf,
                      onlyShowLoggedIn,
                    })
                      .then((result) => {
                        importresults.push({
                          address: address,
                          alias: alias,
                          result: 'created'
                        })
                      })
                      .catch((err) => {
                        importresults.push({
                          address: address,
                          alias: alias,
                          result: 'failed' + err
                        })
                      })
                  }
                })
                .catch((err) => {
                  importresults.push({
                    'address': address,
                    'alias': alias,
                    'result': 'failed' + err
                  })
                });
            }
          });
          //Gather all the results, format for the frontend and send it back.
          let results = { "results": importresults }
          logger.main.debug('Import:' + JSON.stringify(importresults))
          invalidateCapcodeCache();
          nconf.set('database:aliasRefreshRequired', 1);
          nconf.save();
          res.status(200).json(results);
        } else {
          throw 'Error parasing CSV header'
        }
      })
      .catch((err) => {
        logger.main.error(err);
        res.status(500).json({ error: 'Import failed' });
      })
  });

router.route('/user')
  .get(authHelper.isAdmin, function (req, res, next) {
    db.from('users')
      .select('id','givenname','surname','username','email','role','status','lastlogondate')
      .then((rows) => {
        res.json(rows);
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  }) 
  .post(authHelper.isAdmin, function (req, res, next) {
    if (req.body.username && req.body.email && req.body.givenname && req.body.password && req.body.status && req.body.role) {
      const username = req.body.username
      const email = req.body.email
      db.table('users')
        .where('username', '=', username)
        .orWhere('email', '=', email)
        .first()
        .then((row) => {
          if (row) {
            //add logging
            res.status(400).send({ 'status': 'error', 'error': 'Username or Email exists' });
          } else {
            const salt = bcrypt.genSaltSync();
            const hash = bcrypt.hashSync(req.body.password, salt);

            return db('users')
              .insert({
                username: req.body.username,
                password: hash,
                givenname: req.body.givenname,
                surname: req.body.surname,
                email: req.body.email,
                role: req.body.role,
                status: req.body.status,
                lastlogondate: null
              })
              .returning('id')
              .then((response) => {
                //add logging
                logger.main.debug('created user id: ' + response)
                res.status(200).send({ 'status': 'ok', 'id': response[0].id });
              })
              .catch((err) => {
                logger.main.error(err)
                res.status(500).send({ 'status': 'error' });
              });
          }
        })
    } else {
      res.status(400).send({ 'status': 'error', 'error': 'Invalid request body' });
    }
  });

router.route('/userCheck/username/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    const id = req.params.id;
    db.from('users')
      .select('id','givenname','surname','username','email','role','status','lastlogondate')
      .where('username', id)
      .then((row) => {
        if (row.length > 0) {
          row = row[0]
          res.status(200);
          res.json(row);
        } else {
          row = {
            "username": "",
            "password": "",
            "givenname": "",
            "surname": "",
            "email": "",
            "role": "user",
            "status": "active"
          };
          res.status(200);
          res.json(row);
        }
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

  router.route('/userCheck/email/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    const id = req.params.id;
    db.from('users')
      .select('id','givenname','surname','username','email','role','status','lastlogondate')
      .where('email', id)
      .then((row) => {
        if (row.length > 0) {
          row = row[0]
          res.status(200);
          res.json(row);
        } else {
          row = {
            "username": "",
            "password": "",
            "givenname": "",
            "surname": "",
            "email": "",
            "role": "user",
            "status": "active"
          };
          res.status(200);
          res.json(row);
        }
      })
      .catch((err) => {
        logger.main.error(err);
        return next(err);
      })
  });

router.route('/user/:id')
  .get(authHelper.isAdmin, function (req, res, next) {
    const id = req.params.id;
    const defaults = {
      "username": "",
      "password": "",
      "givenname": "",
      "surname": "",
      "email": "",
      "role": "user",
      "status": "active"
    };
    if (id == 'new') {
      res.status(200);
      res.json(defaults);
    } else {
      db.from('users')
        .select('id','givenname','surname','username','email','role','status','lastlogondate')
        .where('id', id)
        .then(function (row) {
          if (row.length > 0) {
            row = row[0]
            res.status(200);
            res.json(row);
          } else {
            res.status(200);
            res.json(defaults);
          }
        })
        .catch((err) => {
          logger.main.error(err);
          return next(err);
        })
    }
  })
  .post(authHelper.isAdmin, function (req, res, next) {
    let id = req.params.id || req.body.id || null;
    if (id == 'deleteMultiple') {
      // do delete multiple
      const idList = req.body.deleteList || [0, 0];
      if (Array.isArray(idList) && !idList.some(isNaN)) {
        if (idList.includes(1) || idList.includes('1')) {
          return res.status(400).json({ 'error': 'User ID 1 is protected' });
        }
        logger.main.info('Deleting: ' + idList);
        db.from('users')
          .del()
          .where('id', 'in', idList)
          .then((result) => {
            res.status(200).send({ 'status': 'ok' });

          }).catch((err) => {
            res.status(500).json({ error: 'Internal server error' });
          })
      } else {
        res.status(400).send({ 'status': 'error', 'error': 'id list contained non-numbers' });
      }
    } else {
      if (req.body.username && req.body.email && req.body.givenname) {
        const password = req.body.newpassword || req.body.password||  null;
        if (id == 'new') {
          // Password is a required field if this is a new account check for that
          if (!req.body.password) {
            return res.status(400).send({'status': 'error', 'error': 'Error - required field missing' });
          } else {
            id = null;
          }
        }
        db.from('users')
          .returning('id')
          .where('id', '=', id)
          .modify(function (queryBuilder) {
            const userobj ={
              id: id,
              username: req.body.username,
              givenname: req.body.givenname,
              surname: req.body.surname || '',
              email: req.body.email,
              role: req.body.role || 'user',
              status: req.body.status || 'disabled',
            }
            if (password != null) {
              const salt = bcrypt.genSaltSync();
              const hash = bcrypt.hashSync(password, salt);
              userobj.password = hash
              if (id == null) {
                userobj.lastlogondate = null
                queryBuilder.insert(userobj)
              } else {
                queryBuilder.update(userobj)
              }
            } else {
              queryBuilder.update(userobj)
            }
          })
          .returning('id')
          .then((result) => {
            res.status(200).send({ 'status': 'ok', 'id': result[0].id })
          })
          .catch((err) => {
            logger.main.error(err)
            res.status(500).json({ error: 'Internal server error' });
          })
      } else {
        res.status(400).send({'status': 'error', 'error': 'Error - required field missing' });
      }
    }
  })
  .delete(authHelper.isAdmin, function (req, res, next) {
    const id = parseInt(req.params.id, 10);
    if (id != 1) {
      logger.main.info('Deleting User ' + id);
      db.from('users')
        .del()
        .where('id', id)
        .then((result) => {
          res.status(200).send({ 'status': 'ok' });
        })
        .catch((err) => {
          res.status(500).json({ error: 'Internal server error' });
          logger.main.error(err)
        })
    } else {
      res.status(400).json({ 'error': 'User ID 1 is protected' });
      logger.main.error('Unable to delete user ID 1')
    }
  });

// Stats cache — 5 minuten TTL, alle 8 zware queries samen opgeslagen.
let _statsCache = null;
let _statsCacheTs = 0;
const STATS_TTL = 300000;

// Stats endpoint (publiek toegankelijk)
router.route('/stats')
  .get(authHelper.isLoggedInMessages, function (req, res) {
    const now = Date.now();
    if (_statsCache && (now - _statsCacheTs) < STATS_TTL) {
      return res.json(_statsCache);
    }

    const dbtype   = nconf.get('database:type');
    const isSqlite = dbtype === 'sqlite3';
    const isMysql  = dbtype === 'mysql' || dbtype === 'mysql2';
    const nowSec   = Math.floor(now / 1000);
    const since24h = nowSec - 86400;
    const since7d  = nowSec - 7  * 86400;
    const since31d = nowSec - 31 * 86400;

    Promise.all([
      // 0: total messages — cached via getCachedCount (120s)
      getCachedCount('stats_total', () => db('messages').countDistinct('message as msgcount'))
        .then(r => +r[0].msgcount),
      // 1: messages last 24h
      db('messages').countDistinct('message as c').where('timestamp', '>', since24h).then(r => +r[0].c),
      // 2: messages last 7 days
      db('messages').countDistinct('message as c').where('timestamp', '>', since7d).then(r => +r[0].c),
      // 3: total active capcodes
      db('capcodes').count('* as c').where('ignore', 0).then(r => +r[0].c),
      // 4: messages per day last 31 days
      isSqlite ? db.raw(
        "SELECT strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch', 'localtime')) as day, COUNT(DISTINCT message) as count FROM messages WHERE timestamp > ? GROUP BY day ORDER BY day",
        [since31d]
      ) : isMysql ? db.raw(
        "SELECT DATE(CONVERT_TZ(FROM_UNIXTIME(timestamp), 'UTC', 'Europe/Amsterdam')) as day, COUNT(DISTINCT message) as count FROM messages WHERE timestamp > ? GROUP BY day ORDER BY day",
        [since31d]
      ) : Promise.resolve([]),
      // 5: messages per hour last 24h
      isSqlite ? db.raw(
        "SELECT CAST(strftime('%H', datetime(timestamp, 'unixepoch', 'localtime')) AS INTEGER) as hour, COUNT(DISTINCT message) as count FROM messages WHERE timestamp > ? GROUP BY hour ORDER BY hour",
        [since24h]
      ) : isMysql ? db.raw(
        "SELECT HOUR(CONVERT_TZ(FROM_UNIXTIME(timestamp), 'UTC', 'Europe/Amsterdam')) as hour, COUNT(DISTINCT message) as count FROM messages WHERE timestamp > ? GROUP BY hour ORDER BY hour",
        [since24h]
      ) : Promise.resolve([]),
      // 6: messages last 31 days
      db('messages').countDistinct('message as c').where('timestamp', '>', since31d).then(r => +r[0].c),
      // 7: berichten per dag van de week (0=zo t/m 6=za) — laatste 31 dagen
      isSqlite ? db.raw(
        "SELECT CAST(strftime('%w', datetime(timestamp, 'unixepoch', 'localtime')) AS INTEGER) as dow, COUNT(DISTINCT message) as count FROM messages WHERE timestamp > ? GROUP BY dow ORDER BY dow",
        [since31d]
      ) : isMysql ? db.raw(
        "SELECT (DAYOFWEEK(CONVERT_TZ(FROM_UNIXTIME(timestamp), 'UTC', 'Europe/Amsterdam')) - 1) as dow, COUNT(DISTINCT message) as count FROM messages WHERE timestamp > ? GROUP BY dow ORDER BY dow",
        [since31d]
      ) : Promise.resolve([]),
      // 8: top 5 meest actieve aliased capcodes — laatste 31 dagen
      isSqlite ? db.raw(
        "SELECT m.address, c.alias, c.agency, c.icon, c.color, COUNT(*) as count FROM messages m JOIN capcodes c ON c.address = m.address WHERE m.timestamp > ? AND c.ignore = 0 AND c.alias IS NOT NULL AND c.alias != '' GROUP BY m.address ORDER BY count DESC LIMIT 5",
        [since31d]
      ) : isMysql ? db.raw(
        "SELECT m.address, c.alias, c.agency, c.icon, c.color, COUNT(*) as count FROM messages m JOIN capcodes c ON c.address = m.address WHERE m.timestamp > ? AND c.ignore = 0 AND c.alias IS NOT NULL AND c.alias != '' GROUP BY m.address, c.alias, c.agency, c.icon, c.color ORDER BY count DESC LIMIT 5",
        [since31d]
      ) : Promise.resolve([]),
    ])
    .then(function(results) {
      const payload = {
        total_messages: results[0],
        messages_24h:   results[1],
        messages_7d:    results[2],
        total_capcodes: results[3],
        daily:          results[4],
        hourly:         results[5],
        messages_31d:   results[6],
        dow:            results[7],
        top_capcodes:   results[8],
      };
      _statsCache = payload;
      _statsCacheTs = Date.now();
      res.json(payload);
    })
    .catch(function(err) {
      logger.main.error('Stats error: ' + err);
      res.status(500).json({ error: err.message });
    });
  });

// System status endpoint (admin only)
router.route('/systemstatus')
  .get(authHelper.isAdmin, function (req, res) {
    const fs = require('fs');
    const dbFile = nconf.get('database:file') || './messages.db';
    let dbSize = 0;
    try { dbSize = fs.statSync(dbFile).size; } catch(e) {}

    Promise.all([
      db('messages').countDistinct('message as c').then(r => r[0].c),
      db('capcodes').count('* as c').then(r => r[0].c),
    ]).then(function(counts) {
      res.json({
        uptime:          Math.floor(process.uptime()),
        node_version:    process.version,
        db_size_bytes:   dbSize,
        total_messages:  counts[0],
        total_capcodes:  counts[1],
        server_time:     new Date().toISOString(),
        version:         require('../package.json').version,
      });
    }).catch(function(err) {
      res.status(500).json({ error: err.message });
    });
  });

// Geocode endpoint: proxies Google Maps Geocoding API so the API key stays server-side
const _geocodeCache = new Map(); // q -> { result, expires }
const _GEOCODE_TTL = 5 * 60 * 1000; // 5 minuten
const _GEOCODE_MAX = 500;          // max cache entries — voorkomt memory exhaustion

router.route('/geocode')
  .get(function (req, res) {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing_query' });

    const apiKey = process.env.GOOGLE_API_KEY || nconf.get('global:googleApiKey');
    if (!apiKey) return res.status(503).json({ error: 'no_api_key' });

    const cached = _geocodeCache.get(q);
    if (cached && cached.expires > Date.now()) {
      return res.json(cached.result);
    }

    axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: q, region: 'nl', key: apiKey }
    })
      .then(function (response) {
        const data = response.data;
        let result;
        if (data.status === 'OK' && data.results && data.results.length > 0) {
          const loc = data.results[0].geometry.location;
          result = { lat: loc.lat, lon: loc.lng };
        } else {
          result = { error: 'not_found' };
        }
        if (_geocodeCache.size >= _GEOCODE_MAX) {
          // Verwijder oudste entry (Map behoudt invoeging-volgorde)
          _geocodeCache.delete(_geocodeCache.keys().next().value);
        }
        _geocodeCache.set(q, { result, expires: Date.now() + _GEOCODE_TTL });
        return res.json(result);
      })
      .catch(function (err) {
        logger.main.error('Geocode API error: ' + err.message);
        return res.json({ error: 'not_found' });
      });
  });

// ── Push endpoints ────────────────────────────────────────────────────────────

// GET /api/push/vapid-public-key
// Geeft de VAPID public key terug zodat de client PushManager.subscribe() kan aanroepen.
// Publiek toegankelijk (client heeft de public key nodig vóór inloggen).
router.route('/push/vapid-public-key')
  .get(function(req, res) {
    if (!_pushReady) {
      return res.status(503).json({ error: 'Push niet geconfigureerd — installeer web-push pakket' });
    }
    res.json({ publicKey: nconf.get('push:vapidPublicKey') });
  });

// POST /api/push/subscribe
// Slaat een push-subscription op in de database.
// Body: { endpoint, keys: { p256dh, auth } }
router.route('/push/subscribe')
  .post(function(req, res) {
    if (!_pushReady) return res.status(503).json({ error: 'Push niet geconfigureerd' });

    const sub = req.body;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Ongeldig subscription object' });
    }

    const record = {
      endpoint:   sub.endpoint,
      p256dh:     sub.keys.p256dh,
      auth:       sub.keys.auth,
      created_at: Math.floor(Date.now() / 1000)
    };

    // Upsert: update sleutels als het endpoint al bestaat (bijv. na browser-herstart)
    db('push_subscriptions')
      .insert(record)
      .catch(function() {
        // Primaire sleutel conflict — update de bestaande rij
        return db('push_subscriptions')
          .where({ endpoint: record.endpoint })
          .update({ p256dh: record.p256dh, auth: record.auth, created_at: record.created_at });
      })
      .then(function() { res.json({ status: 'ok' }); })
      .catch(function(err) {
        logger.main.error('Push subscribe fout: ' + err);
        res.status(500).json({ error: err.message });
      });
  });

// POST /api/push/unsubscribe
// Verwijdert een push-subscription uit de database.
// Body: { endpoint }
router.route('/push/unsubscribe')
  .post(function(req, res) {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'endpoint ontbreekt' });

    db('push_subscriptions')
      .where({ endpoint })
      .delete()
      .then(function() { res.json({ status: 'ok' }); })
      .catch(function(err) {
        logger.main.error('Push unsubscribe fout: ' + err);
        res.status(500).json({ error: err.message });
      });
  });

// ── Einde Push endpoints ──────────────────────────────────────────────────────

router.use([handleError]);

module.exports = router;

function handleError(err, req, res, next) {
  const output = {
    error: {
      name: err.name,
      message: err.message,
      text: err.toString()
    }
  };
  const statusCode = err.status || 500;
  res.status(statusCode).json(output);
}

function parseJSON(json) {
  let parsed;
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    // ignore errors
  }
  return parsed;
}

/**
 * Removes all empty objects from a plugin configuration
 * @param {Object} pconf An object containing a key for each Plugin, holding it's configuration
 * @returns A sanitized version of the plugin configuration object holding only plugins with values set
 */
function vaccumPluginConf(pconf) {
  const cleaned = pickBy(pconf, p => {
      return Object.keys(p).length > 0
  })
  return cleaned;
}
