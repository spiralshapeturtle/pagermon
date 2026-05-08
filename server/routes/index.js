var confFile = './config/config.json';
var express = require('express');
var router = express.Router();
var nconf = require('nconf');

nconf.file({ file: confFile });
nconf.load();

const passport = require('../auth/local');

// Gecachede config snapshot voor de middleware — max 1× per 10s herladen.
let _idxCfg = null;
let _idxCfgTime = 0;
function getIndexConfig() {
    const now = Date.now();
    if (_idxCfg && now - _idxCfgTime < 10000) return _idxCfg;
    nconf.load();
    _idxCfg = {
        register:          nconf.get('auth:registration'),
        hidecapcode:       nconf.get('messages:HideCapcode'),
        pdwmode:           nconf.get('messages:pdwMode'),
        hidesource:        nconf.get('messages:HideSource'),
        apisecurity:       nconf.get('messages:apiSecurity'),
        iconsize:          nconf.get('messages:iconsize'),
        gaEnable:          nconf.get('monitoring:gaEnable'),
        gaTrackingCode:    nconf.get('monitoring:gaTrackingCode'),
        frontPopupEnable:  nconf.get('global:frontPopupEnable'),
        frontPopupTitle:   nconf.get('global:frontPopupTitle'),
        frontPopupContent: nconf.get('global:frontPopupContent'),
        searchLocation:    nconf.get('global:searchLocation'),
        monitorName:       nconf.get('global:monitorName'),
        faKey:             nconf.get('global:faKey'),
    };
    _idxCfgTime = now;
    return _idxCfg;
}

router.use(function (req, res, next) {
    const cfg = getIndexConfig();
    res.locals.login = req.isAuthenticated();
    res.locals.user = req.user || false;
    res.locals.register          = cfg.register;
    res.locals.hidecapcode       = cfg.hidecapcode;
    res.locals.pdwmode           = cfg.pdwmode;
    res.locals.hidesource        = cfg.hidesource;
    res.locals.apisecurity       = cfg.apisecurity;
    res.locals.iconsize          = cfg.iconsize;
    res.locals.gaEnable          = cfg.gaEnable;
    res.locals.gaTrackingCode    = cfg.gaTrackingCode;
    res.locals.frontPopupEnable  = cfg.frontPopupEnable;
    res.locals.frontPopupTitle   = cfg.frontPopupTitle;
    res.locals.frontPopupContent = cfg.frontPopupContent;
    res.locals.searchLocation    = cfg.searchLocation;
    res.locals.monitorName       = cfg.monitorName;
    res.locals.faKey             = cfg.faKey;
    next();
});

/* GET home page. */
router.get('/', function (req, res, next) {
    if (nconf.get('messages:apiSecurity') && !req.isAuthenticated()) {
        req.flash('loginMessage', 'You need to be logged in to access this page');
        res.status(401).redirect('/auth/login');
        return;
    }

    res.render('index', { pageTitle: 'Home' });
});

module.exports = router;
