// pass passport for configuration
const bcrypt = require('bcryptjs');
const nconf = require('nconf');

const confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

function isLoggedInMessages(req, res, next) {
    const passport = require('../auth/local');
    const apiSecurity = nconf.get('messages:apiSecurity');
    if (apiSecurity) { //check if Secure mode is on
        if (req.isAuthenticated()) {
            // if user is authenticated in the session, carry on
            return next();
        } else {
            //perform api authentication - all api keys are assumed to be admin
            return passport.authenticate('login-api', { session: false }, function (err, user) {
                if (err || !user) {
                    return res.status(401).json({ error: 'Authentication failed.' });
                }
                return next();
            })(req, res, next);
        }
    } else {
        return next();
    }
}

function isLoggedIn(req, res, next) {
    const passport = require('../auth/local');

    if (req.isAuthenticated()) {
        // if user is authenticated in the session, carry on
        return next();
    } else {
        // Check if this is an AJAX request
        if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
            // For AJAX requests, return JSON error
            return res.status(401).json({
                error: 'Authentication required.',
                redirect: '/auth/login'
            });
        }

        // For regular requests, try API authentication
        return passport.authenticate('login-api', {
            session: false,
            failWithError: true
        })(req, res, function (err) {
            if (err) {
                // API auth failed, redirect to login
                return res.redirect('/auth/login');
            }
            // API auth succeeded
            return next();
        });
    }
}
// Enhanced auth middleware - replace the isLoggedIn function in server/middleware / authhelper.js

// Enhanced isAdminGUI function for better redirect handling
function isAdminGUI(req, res, next) {
    if (req.isAuthenticated() && req.user.role == 'admin') {
        // if the user is authenticated and the user's role is admin carry on
        return next();
    } else if (req.isAuthenticated()) {
        // User is logged in but not admin - redirect to home
        res.redirect('/');
    } else {
        // User is not logged in - redirect to login
        res.redirect('/auth/login');
    }
}

function isAdmin (req, res, next) {
    const passport = require('../auth/local');
    if (req.isAuthenticated() && req.user.role == 'admin') {
      //if the user is authenticated and the user's role is admin carry on
      return next();
    } else {
        //if apikey in header perform api authentication - all api keys are assumed to be admin
      return passport.authenticate('login-api', { session: false }, function (err, user) {
        if (err || !user) {
          return res.status(401).json({ error: 'Authentication failed.' });
        }
        return next();
      })(req, res, next);
    }
  }

  function comparePass(userPassword, databasePassword) {
    return bcrypt.compareSync(userPassword, databasePassword);
}

module.exports = {
    isLoggedIn,
    isLoggedInMessages,
    isAdmin,
    isAdminGUI,
    comparePass
}
  
