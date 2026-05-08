const debug = require('debug')('pagermon:server');
const http = require('http');
const compression = require('compression');
const express = require('express');
const path = require('path');
const favicon = require('serve-favicon');
const logger = require('./log');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const flash    = require('connect-flash');
const helmet = require('helmet');
const { version } = require('./package.json');


process.on('SIGINT', function() {
    console.log( "\nGracefully shutting down from SIGINT (Ctrl-C)" );
    process.exit(1);
});

// create config file if it does not exist, and set defaults
const conf_defaults = require('./config/default.json');
const confFile = './config/config.json';
if( ! fs.existsSync(confFile) ) {
    fs.writeFileSync( confFile, JSON.stringify(conf_defaults,null, 2) );
}
// load the config file
const nconf = require('nconf');
    nconf.file({file: confFile});
    nconf.load();

//Load current theme
let theme = nconf.get('global:theme')
// set the theme if none found, for backwards compatibility
if (!theme) {
  nconf.set('global:theme', "default");
  nconf.save();
  theme = nconf.get('global:theme')
}

let dbtype = nconf.get('database:type');
// Set the database port if none found, for backwards compatibility
if (dbtype == 'pg' || dbtype == 'mysql' || dbtype == 'mysql2' || dbtype == 'mssql') {
	if (!nconf.get('database:port')){
		nconf.set('database:port', 3306);
		nconf.save();
	}
}

checkForDbDriver(nconf.get('database:type'));

const dbinit = require('./db');
    dbinit.init();
const db = require('./knex/knex.js');

const passport = require('./auth/local');

// routes
const index = require('./routes/index');
const admin = require('./routes/admin');
const api = require('./routes/api');
const auth = require('./routes/auth');

const port = normalizePort(process.env.PORT || '3000');
const app = express();
    app.set('port', port);
    // view engine setup
    app.set('views', path.join(__dirname,'themes',theme, 'views'));
    app.set('view engine', 'ejs');
    app.set('trust proxy', 'loopback, linklocal, uniquelocal');



const server = http.createServer(app);
const io = require('socket.io')(server);
    server.listen(port);

    server.on('error', onError);
    server.on('listening', onListening);
    //Set connection timeout to prevent long running queries failing on large databases - mostly capacode refresh on MySQL
    server.on('connection', function(connection) {
      connection.setTimeout(600 * 1000);
    });
    //Lets set setMaxListeners to a decent number - not to high to allow the memory leak warking to still trigger
    io.sockets.setMaxListeners(20);
    

io.sockets.on('connection', function (socket) {
    const userGroup = socket.request?.user?.role || 'anonymous';
    socket.join(userGroup);
    // Sneakpeek: only for anonymous users — logged-in users already receive all messages via their role room.
    // When sneakpeek is on, leave 'anonymous' to avoid receiving duplicate messagePost events
    // (non-login-only messages are emitted to both 'anonymous' and 'sneakpeek').
    const rawCookies = socket.request.headers.cookie || '';
    const hasSneakpeek = /(?:^|;\s*)sneakpeek=on/.test(rawCookies);
    if (hasSneakpeek && userGroup === 'anonymous') {
        socket.leave('anonymous');
        socket.join('sneakpeek');
    }

    // Allow client to update sneakpeek room membership without reconnecting
    socket.on('setSneakpeek', function (active) {
        if (userGroup !== 'anonymous') return; // logged-in users don't need this
        if (active) {
            socket.leave('anonymous');
            socket.join('sneakpeek');
        } else {
            socket.leave('sneakpeek');
            socket.join('anonymous');
        }
    });
});

app.use(favicon(path.join(__dirname,'themes',theme, 'public', 'favicon.ico')));

// set socket.io to be shared across all modules
app.use(function(req,res,next){
    req.io = io;
    next();
});

// session secret is controlled by config
const secret = nconf.get('global:sessionSecret');
// security headers (CSP disabled: app uses CDN scripts and inline scripts)
app.use(helmet({
    contentSecurityPolicy: false,       // CDN scripts + inline scripts
    crossOriginOpenerPolicy: false,     // requires HTTPS, causes Chrome warning on HTTP
    originAgentCluster: false,          // requires HTTPS, causes Chrome warning on HTTP
}));
// compress all responses
app.use(compression());
app.use(require("morgan")("combined", { "stream": logger.http.stream }));
app.use(express.json({
  limit: '4mb',
}));       // to support JSON-encoded bodies
app.use(express.urlencoded({
  extended: true,
  limit: '4mb',
})); // to support URL-encoded bodies

const sessSet = {
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
        httpOnly: true,   // niet toegankelijk via JavaScript (XSS bescherming)
        sameSite: 'lax'   // CSRF bescherming voor top-level navigatie
    },
    store: new SQLiteStore,
    saveUninitialized: false, // geen lege sessies voor niet-ingelogde bezoekers
    resave: true,
    secret: secret
}

if (process.env.HOSTNAME && process.env.USE_COOKIE_HOST)
    sessSet.cookie.domain = '.'+process.env.HOSTNAME;

app.use(session(sessSet));
app.use(passport.initialize());
app.use(passport.session()); // persistent login sessions
app.use(flash());
app.use(express.static(path.join(__dirname,'themes',theme, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  immutable: false,
}));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules'), {
  maxAge: '7d',
  etag: true,
}));
app.use(function(req, res, next) {
  res.locals.version = version;
  res.locals.loglevel = nconf.get('global:loglevel') || 'info';
  next();
});

const wrapMiddleware = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrapMiddleware(session(sessSet)));
io.use(wrapMiddleware(passport.session()));
io.of('/adminio').use(wrapMiddleware(session(sessSet)));
io.of('/adminio').use(wrapMiddleware(passport.session()));

app.use('/', index);
app.use('/admin', admin);
app.use('/post', api);
app.use('/api', api);
app.use('/auth', auth);


// catch 404 and forward to error handler
app.use(function(req, res, next) {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handler
app.use(function(err, req, res, next) {
  const title = nconf.get('global:monitorName') || 'PagerMon';
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  //these 3 have to be here to stop the error handler shitting up the logs with undefined references when it receives a 500 error ... nfi why
  res.locals.login = req.isAuthenticated();
  res.locals.gaEnable = nconf.get('monitoring:gaEnable');
  res.locals.monitorName = nconf.get("global:monitorName");
  res.locals.register = nconf.get('auth:registration')

  // render the error page
  res.status(err.status || 500);
  res.render(path.join(__dirname,'themes',theme, 'views', 'global', 'error'), { title: title });
});

// Add cronjob to automatically refresh aliases
dbtype = nconf.get('database:type')
if (dbtype == 'mysql' || dbtype == 'mysql2') {
  const cronvalidate = require('cron-validator');
  // Get CRON from config
  let cronartime = nconf.get('database:aliasRefreshInterval');
  //If value is falsy (undefined, empty, null etc), set as default
  if (!cronartime){cronartime = "0 5,35 * * * *";}
  //Check value isn't garbage, if it is set to default
  if (!cronvalidate.isValidCron(cronartime,{ seconds: true })) {
    logger.main.warn('CRON: Invalid CRON configuration in config file. Defaulting to: "0 5,35 * * * *" ')
    cronartime = "0 5,35 * * * *";
  }
  const aliasRefreshJob = require('cron').CronJob;
  new aliasRefreshJob(cronartime, function() {
    const refreshRequired = nconf.get('database:aliasRefreshRequired')
    logger.main.debug('CRON: Running Cronjob AliasRefresh')
    if (refreshRequired == 1) {
      const updateMapStart = Date.now();
      logger.main.info('CRON: Alias Refresh required, running.')
      db('messages').update('alias_id', function() {
        this.select('id')
            .from('capcodes')
            .where(db.ref('messages.address'), 'like', db.ref('capcodes.address') )
            .orderByRaw("REPLACE(address, '_', '%') DESC LIMIT 1")
      })
      .then((result) => {
          logger.main.debug('CRON: updateMap completed in ' + (Date.now() - updateMapStart) + 'ms');
          nconf.set('database:aliasRefreshRequired', 0);
          nconf.save();
          logger.main.info('CRON: Alias Refresh Successful')
      })
      .catch((err) => {
        logger.main.error('CRON: Error refreshing aliases' + err);
        logger.main.debug('CRON: updateMap failed after ' + (Date.now() - updateMapStart) + 'ms');
      })
    } else {
      logger.main.debug('CRON: Alias Refresh not Required, Skipping.')
    }
  }, null, true);
}

// Add cronjob for message rotation/cleanup
const rotationJob = require('cron').CronJob;
new rotationJob('0 0 1 * * *', function() {
  nconf.load();
  const rotationEnabled = nconf.get('messages:rotationEnabled');
  if (!rotationEnabled) {
    logger.main.debug('CRON: Message rotation disabled, skipping.');
    return;
  }
  const rotateDays = parseInt(nconf.get('messages:rotateDays')) || 7;
  const rotateKeep = parseInt(nconf.get('messages:rotateKeep')) || 0;
  const cutoff = Math.floor(Date.now() / 1000) - (rotateDays * 86400);
  logger.main.info('CRON: Running message rotation, deleting messages older than ' + rotateDays + ' days (cutoff timestamp: ' + cutoff + ')');

  let query = db('messages').where('timestamp', '<=', cutoff);
  if (rotateKeep > 0) {
    query = query.whereNotIn('id', db('messages').select('id').orderBy('timestamp', 'desc').limit(rotateKeep));
  }
  query.delete()
    .then(function(count) {
      logger.main.info('CRON: Message rotation complete, deleted ' + count + ' messages.');
      const dbtype = nconf.get('database:type');
      if (dbtype === 'sqlite3') {
        // Herbouw alarm_groups na bulkverwijdering — per-row DELETE triggers hebben
        // ref_counts al bijgewerkt, maar herbouwen is sneller en gegarandeerd correct.
        const rebuildAlarmGroups = db.schema.hasTable('alarm_groups').then(function(exists) {
          if (!exists) return;
          return db.raw('DELETE FROM alarm_groups')
            .then(function() {
              return db.raw(`
                INSERT INTO alarm_groups (timestamp, message, ref_count, pdw_count)
                SELECT
                  m.timestamp,
                  m.message,
                  COUNT(*)                                               AS ref_count,
                  SUM(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END)     AS pdw_count
                FROM messages m
                LEFT JOIN capcodes c
                  ON c.id = m.alias_id
                 AND c.ignore = 0
                 AND c.alias  IS NOT NULL
                 AND c.alias  != ''
                GROUP BY m.timestamp, m.message
              `);
            })
            .then(function() { logger.main.info('CRON: alarm_groups rebuilt after rotation.'); });
        });
        return rebuildAlarmGroups.then(function() {
        const vacuumEnabled = nconf.get('messages:vacuumEnabled');
        const vacuumDays = parseInt(nconf.get('messages:vacuumDays')) || 31;
        const stateFile = path.join(__dirname, 'config/vacuum_state.json');
        let vacuumState = { lastVacuum: 0 };
        try { vacuumState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch(e) {}
        const now = Math.floor(Date.now() / 1000);
        const vacuumDue = vacuumEnabled && (now - vacuumState.lastVacuum) >= vacuumDays * 86400;

        const vacuumStep = vacuumDue
          ? db.raw('VACUUM').then(function() {
              logger.main.info('CRON: SQLite VACUUM complete.');
              fs.writeFileSync(stateFile, JSON.stringify({ lastVacuum: now }));
            })
          : Promise.resolve().then(function() {
              logger.main.info(vacuumEnabled ? 'CRON: VACUUM not due yet, skipping.' : 'CRON: VACUUM disabled, skipping.');
            });

        return vacuumStep.then(function() {
          // WAL autocheckpoint is disabled; flush WAL → main DB once per day here.
          return db.raw('PRAGMA wal_checkpoint(TRUNCATE)');
        }).then(function(result) {
          // result is [{busy, log, checkpointed}] — busy=1 means another connection blocked truncate
          const row = (Array.isArray(result[0]) ? result[0][0] : result[0]) || {};
          const busy = row.busy, log = row.log, done = row.checkpointed;
          if (busy) {
            logger.main.warn('CRON: WAL checkpoint incomplete — blocked by open reader (log=' + log + ', checkpointed=' + done + '). Will retry tomorrow.');
          } else if (log > done) {
            logger.main.warn('CRON: WAL checkpoint partial (log=' + log + ', checkpointed=' + done + ').');
          } else if (log === 0) {
            logger.main.info('CRON: WAL checkpoint — WAL was already empty.');
          } else {
            logger.main.info('CRON: WAL checkpoint complete (' + done + ' frames flushed, WAL truncated).');
          }
        });
        }); // end rebuildAlarmGroups.then
      }
    })
    .catch(function(err) {
      logger.main.error('CRON: Error during message rotation: ' + err);
    });
}, null, true);

//Disable all logging for tests
if(process.env.NODE_ENV === 'test') {
  logger.main.silent = true
  logger.auth.silent = true
  logger.db.silent = true
  logger.http.silent = true
}

module.exports = app;

function normalizePort(val) {
  const port = parseInt(val, 10);

  if (isNaN(port)) {
    // named pipe
    return val;
  }

  if (port >= 0) {
    // port number
    return port;
  }

  return false;
}

function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof port === 'string'
    ? 'Pipe ' + port
    : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

function checkForDbDriver(driver) {
  switch (driver) {
    /* eslint-disable import/no-extraneous-dependencies, global-require */
    case 'sqlite3': {
      try {
        require('sqlite3');
      } catch (e) {
        logger.main.error(`Selected database type is sqlite3, but npm package sqlite3 was not installed.`);
        logger.main.error(
          `Please run npm i sqlite3 to install or refer to https://www.npmjs.com/package/sqlite3 for reference`
        );
        process.exit(1);
      }
      break;
    }
    case 'mysql':
    case 'mysql2': {
      try {
        require('knex');
      } catch (e) {
        logger.main.error(`Selected database type is mysql/mysql2, but npm package knex was not installed.`);
        logger.main.error(
          `Please run npm i knex to install or refer to https://www.npmjs.com/package/knex for reference`
        );
        process.exit(1);
      }
      break;
    }
    case 'oracledb': {
      try {
        require('oracledb');
      } catch (e) {
        logger.main.error(`Selected database type is oracledb, but npm package oracledb was not installed.`);
        logger.main.error(
          `Please run npm i oracledb to install or refer to https://www.npmjs.com/package/oracledb for reference`
        );
        process.exit(1);
      }
      break;
    }
    default: {
      logger.main.error(`No database type was specified.`);
      process.exit(1);
    }
  }
  /* eslint-enable import/no-extraneous-dependencies, global-require */
}


function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string'
    ? 'pipe ' + addr
    : 'port ' + addr.port;
    logger.main.info('Listening on ' + bind);
}