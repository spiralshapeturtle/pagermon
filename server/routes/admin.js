var express = require('express');
var router = express.Router();
var bcrypt = require('bcryptjs');
var fs = require('fs');
var logger = require('../log');
var util = require('util');
var passport = require('../auth/local'); // pass passport for configuration
const authHelper = require('../middleware/authhelper')

router.use(function (req, res, next) {
    res.locals.login = req.isAuthenticated();
    res.locals.user = req.user;
    res.locals.monitorName = nconf.get("global:monitorName");
    next();
});

var nconf = require('nconf');
var confFile = './config/config.json';
var conf_backup = './config/backup.json';

nconf.file({ file: confFile });
nconf.load();

router.use(express.json());       // to support JSON-encoded bodies
router.use(express.urlencoded({     // to support URL-encoded bodies
  extended: true
}));
router.route('/settingsData')
    .get(authHelper.isAdmin, function (req, res, next) {
        nconf.load();
        let settings = nconf.get();
        let plugins = [];
        fs.readdirSync('./plugins').forEach(file => {
            if (file.endsWith('.json')) {
                let pConf = JSON.parse(fs.readFileSync(`./plugins/${file}`, 'utf8'));
                if (!pConf.disable)
                    plugins.push(pConf);
            }
        });
        let themes = [];
        fs.readdirSync('./themes').forEach(file => {
            themes.push(file)
        });
        let data = { "settings": settings, "plugins": plugins, "themes": themes }
        res.json(data);
    })
    .post(authHelper.isAdmin, function (req, res, next) {
        nconf.load();
        if (req.body) {
            var currentConfig = nconf.get();
            fs.writeFileSync(conf_backup, JSON.stringify(currentConfig, null, 2));
            fs.writeFileSync(confFile, JSON.stringify(req.body, null, 2));
            nconf.load();
            res.status(200).send({ 'status': 'ok' });
        } else {
            res.status(400).send({ error: 'request body empty' });
        }
    });

router.get('/logsData', authHelper.isAdmin, function (req, res) {
    var path = require('path');
    var logFile = path.join(__dirname, '../logs/pagermon.log');
    const TAIL_BYTES = 200000; // read at most ~200 KB from end of file
    fs.stat(logFile, function (statErr, stat) {
        if (statErr) {
            return res.status(500).json({ error: 'Could not read log file: ' + statErr.message });
        }
        const fileSize = stat.size;
        const start = Math.max(0, fileSize - TAIL_BYTES);
        let data = '';
        const stream = fs.createReadStream(logFile, { start, encoding: 'utf8' });
        stream.on('data', chunk => { data += chunk; });
        stream.on('end', () => {
            let lines = data.split('\n').filter(Boolean);
            if (start > 0) lines.shift(); // drop potentially partial first line
            res.json({ lines: lines.slice(-500), total: lines.length });
        });
        stream.on('error', streamErr => {
            res.status(500).json({ error: 'Could not read log file: ' + streamErr.message });
        });
    });
});

// Specific admin sub-page routes (add before the catch-all)
router.get('/', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/index', { pageTitle: 'Admin' });
});
router.get('/aliases', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/aliases', { pageTitle: 'Admin - Aliases' });
});
router.get('/aliases/:id', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/alias-detail', { pageTitle: 'Admin - Alias' });
});
router.get('/users', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/users', { pageTitle: 'Admin - Users' });
});
router.get('/users/:id', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/user-detail', { pageTitle: 'Admin - User' });
});
router.get('/settings', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/settings', { pageTitle: 'Admin - Settings' });
});
router.get('/stats', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/stats', { pageTitle: 'Admin - Statistics' });
});
router.get('/logs', authHelper.isAdminGUI, function(req, res) {
  res.render('admin/logs', { pageTitle: 'Admin - Logs' });
});

router.get('*', authHelper.isAdminGUI, function (req, res, next) {
    res.render('admin/index', { pageTitle: 'Admin' });
});

module.exports = router;
