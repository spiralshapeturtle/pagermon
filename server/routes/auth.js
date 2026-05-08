const express = require('express');

const router = express.Router();
const bcrypt = require('bcryptjs');
const moment = require('moment');
const nconf = require('nconf');

const confFile = './config/config.json';
nconf.file({ file: confFile });
nconf.load();

const rateLimit = require('express-rate-limit');

const db = require('../knex/knex.js');
const logger = require('../log');
const passport = require('../auth/local');
const authHelper = require('../middleware/authhelper')

const rateLimitHandler = function(req, res) {
        logger.auth.info(`Rate limit exceeded: ${req.ip}`);
        res.status(429).send({ status: 'lockedout', error: 'Too many attempts, please try again later' });
};

const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10,
        handler: rateLimitHandler,
        standardHeaders: true,
        legacyHeaders: false,
});

const dupeLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 20,
        handler: rateLimitHandler,
        standardHeaders: true,
        legacyHeaders: false,
});

router.route('/login')
        .get(function(req, res) {
                if (!req.isAuthenticated()) {
                        let user = '';
                        if (typeof req.username !== 'undefined') {
                                user = req.username;
                        }
                        res.render('auth/login', {
                                pageTitle: 'User',
                        });
                } else {
                        res.redirect('/');
                }
        })
        .post(loginLimiter, function(req, res, next) {
                passport.authenticate('login-user', (err, user) => {
                        if (err) {
                                //this is commented out as it seems to fire when a user is disabled?! even tho the below functions still run
                                //res.status(500).send({ status: 'failed', error: 'An Error Occured' });
                                logger.auth.error(err);
                        } else if (!user) {
                                res.status(401).send({ status: 'failed', error: 'Check Details and try again' });
                                logger.auth.debug(`Login Failed: ${req.body.username}`);
                        } else if (user) {
                                if (user.status !== 'disabled') {
                                        req.logIn(user, function(err) {
                                                if (err) {
                                                        res.status(401).send({
                                                                status: 'failed',
                                                                error: 'An error occured',
                                                        });
                                                        logger.auth.debug(
                                                                `Failed login ${JSON.stringify(user)} ${err}`
                                                        );
                                                } else {
                                                        // Update last logon timestamp for user
                                                        const { id } = user;
                                                        // create the datetime, thanks mysql ┌∩┐(◣_◢)┌∩┐
                                                        const currentTimestamp = moment().unix(); // in seconds
                                                        const currentDatetime = moment(currentTimestamp * 1000).format(
                                                                'YYYY-MM-DD HH:mm:ss'
                                                        );
                                                        return db
                                                                .from('users')
                                                                .where('id', '=', id)
                                                                .update({
                                                                        lastlogondate: currentDatetime,
                                                                })
                                                                .then(() => {
                                                                        if (user.role !== 'admin') {
                                                                                res.status(200).send({
                                                                                        status: 'ok',
                                                                                        redirect: '/',
                                                                                });
                                                                        } else {
                                                                                res.status(200).send({
                                                                                        status: 'ok',
                                                                                        redirect: '/admin',
                                                                                });
                                                                        }
                                                                        logger.auth.debug(
                                                                                `Successful login ${JSON.stringify(
                                                                                        user
                                                                                )}`
                                                                        );
                                                                })
                                                                .catch(err => {
                                                                        logger.db.error(err);
                                                                });
                                                }
                                        });
                                } else {
                                        res.status(401).send({ status: 'failed', error: 'User Disabled' });
                                        logger.auth.debug(`User Disabled${req.user.username}`);
                                }
                        }
                })(req, res, next);
        });

// Enhanced logout route - replace the existing logout route in server/routes/auth.js

router.route('/logout')
        .get(authHelper.isLoggedIn, function (req, res, next) {
                // Store username before logout destroys the session
                const username = req.user ? req.user.username : 'unknown';

                req.logout(function (err) {
                        if (err) {
                                logger.auth.error(`Logout error for ${username}: ${err}`);
                                return next(err);
                        }

                        // Destroy the session completely
                        req.session.destroy(function (err) {
                                if (err) {
                                        logger.auth.error(`Session destruction error for ${username}: ${err}`);
                                        return next(err);
                                }

                                // Clear the session cookie
                                res.clearCookie('connect.sid'); // Default session cookie name
                                res.clearCookie('sneakpeek');   // Reset sneakpeek so user lands in normal filtered mode

                                // Log successful logout
                                logger.auth.debug(`Successful Logout: ${username}`);

                                // Redirect to home page
                                res.redirect('/');
                        });
                });
        })
        .post(authHelper.isLoggedIn, function (req, res, next) {
                // Handle AJAX logout requests (for frontend JavaScript)
                const username = req.user ? req.user.username : 'unknown';

                req.logout(function (err) {
                        if (err) {
                                logger.auth.error(`Logout error for ${username}: ${err}`);
                                return res.status(500).json({
                                        status: 'error',
                                        message: 'Logout failed'
                                });
                        }

                        req.session.destroy(function (err) {
                                if (err) {
                                        logger.auth.error(`Session destruction error for ${username}: ${err}`);
                                        return res.status(500).json({
                                                status: 'error',
                                                message: 'Session cleanup failed'
                                        });
                                }

                                res.clearCookie('connect.sid');
                                res.clearCookie('sneakpeek');   // Reset sneakpeek so user lands in normal filtered mode
                                logger.auth.debug(`Successful AJAX Logout: ${username}`);

                                // Return JSON response for AJAX requests
                                res.status(200).json({
                                        status: 'success',
                                        redirect: '/auth/login'
                                });
                        });
                });
        });

router.route('/profile/').get(authHelper.isLoggedIn, function(req, res) {
        res.render('auth/profile', {
                pageTitle: 'User',
        });
});

router.route('/profile/:id')
        .get(authHelper.isLoggedIn, function(req, res, next) {
                const { username } = req.user;
                db.from('users')
                        .select('id', 'givenname', 'surname', 'username', 'email', 'lastlogondate')
                        .where('username', username)
                        .then(function(row) {
                                if (row.length > 0) {
                                        const rowsend = row[0];
                                        res.status(200);
                                        res.json(rowsend);
                                } else {
                                        res.status(500).json({ status: 'failed', error: '' });
                                        logger.auth.error('failed to select user');
                                }
                        })
                        .catch(err => {
                                logger.main.error(err);
                                return next(err);
                        });
        })
        .post(authHelper.isLoggedIn, function(req, res) {
                if (req.body.username === req.user.username) {
                        const { username } = req.body;
                        const { givenname } = req.body;
                        const surname = req.body.surname || '';
                        const { email } = req.body;
                        const lastlogondate = Date.now();
                        db.from('users')
                                .returning('id')
                                .where('username', '=', req.user.username)
                                .update({
                                        username,
                                        givenname,
                                        surname,
                                        email,
                                        lastlogondate,
                                })
                                .then(result => {
                                        res.status(200).send({ status: 'ok', id: result[0].id });
                                })
                                .catch(err => {
                                        logger.main.error(err);
                                        res.status(400).send(err);
                                });
                } else {
                        res.status(401).json({ message: 'Please update your own details only' });
                        logger.auth.error('Possible attempt to compromise security POST:/auth/profile');
                }
        });

router.route('/register')
        .get(function(req, res) {
                const reg = nconf.get('auth:registration');
                if (reg) {
                        res.render('auth/register', {
                                title: 'Registration',
                                message: req.flash('registerMessage'),
                        });
                } else {
                        res.redirect('/');
                }
        })
        .post(function(req, res, next) {
                const reg = nconf.get('auth:registration');
                if (reg) {
                        const salt = bcrypt.genSaltSync();
                        const hash = bcrypt.hashSync(req.body.password, salt);
                        // dupecheck to prevent a non-literal insert being abused to reset passwords
                        return db('users')
                                .where('username', '=', req.body.username)
                                .orWhere('email', '=', req.body.email)
                                .select('id')
                                .then(row => {
                                        if (row.length > 0) {
                                                logger.auth.error(
                                                        `Duplicate registration via API${JSON.stringify(row)}`
                                                );
                                                res.status(401).json({ error: 'access denied' });
                                        } else {
                                                return db('users')
                                                        .insert({
                                                                username: req.body.username,
                                                                password: hash,
                                                                givenname: req.body.givenname,
                                                                surname: req.body.surname,
                                                                email: req.body.email,
                                                                role: 'user',
                                                                status: 'active',
                                                                lastlogondate: Date.now(),
                                                        })
                                                        .then(() => {
                                                                passport.authenticate('login-user', (err, user) => {
                                                                        if (user) {
                                                                                req.logIn(user, function(err) {
                                                                                        if (err) {
                                                                                                res.status(500).json({
                                                                                                        status:
                                                                                                                'failed',
                                                                                                        error: err,
                                                                                                        redirect:
                                                                                                                '/auth/register',
                                                                                                });
                                                                                                logger.auth.error(err);
                                                                                        } else {
                                                                                                res.status(200).json({
                                                                                                        status: 'ok',
                                                                                                        redirect: '/',
                                                                                                });
                                                                                                logger.auth.info(
                                                                                                        `Created Account: ${user}`
                                                                                                );
                                                                                        }
                                                                                });
                                                                        } else {
                                                                                logger.auth.error(err);
                                                                                res.status(500).json({
                                                                                        status: 'failed',
                                                                                        error: err,
                                                                                        redirect: '/auth/register',
                                                                                });
                                                                        }
                                                                })(req, res, next);
                                                        })
                                                        .catch(err => {
                                                                logger.auth.error(err);
                                                                res.status(400).json({
                                                                        status: 'failed',
                                                                        error: 'invalid data',
                                                                });
                                                        });
                                        }
                                });
                }
                logger.auth.error('Registration attempted with registration disabled');
                res.status(400).json({ error: 'registration disabled' });
        });

router.route('/reset')
        .get(function(req, res) {
                let user = '';
                if (typeof req.username !== 'undefined') {
                        user = req.username;
                }
                if (req.user) {
                        return res.render('auth/reset', {
                                title: 'User - Reset Password',
                                message: req.flash('loginMessage'),
                                username: user,
                        });
                } else {
                res.redirect('/auth/login');
                }
        })
        .post(authHelper.isLoggedIn, function(req, res) {
                const { password } = req.body;
                // bcrypt function
                if (password.length && !authHelper.comparePass(password, req.user.password)) {
                        const salt = bcrypt.genSaltSync();
                        const hash = bcrypt.hashSync(req.body.password, salt);
                        const { id } = req.user;
                        //need to update this query to select the user first then update. 
                        db.from('users')
                                .returning('id')
                                .where('id', '=', id)
                                .update({
                                        password: hash,
                                })
                                .then(() => {
                                        res.status(200).send({ status: 'ok', redirect: '/' });
                                        logger.auth.debug(`${req.user.username} Password Reset Successfully`);
                                })
                                .catch(err => {
                                        res.status(500).send({ status: 'failed', error: 'Failed to update password' });
                                        logger.auth.error(`${req.user.username} error resetting password${err}`);
                                });
                } else {
                        res.status(400).send({ status: 'failed', error: 'Password Blank or the Same' });
                }
        });

router.route('/userCheck/username/:id').get(dupeLimiter, function(req, res, next) {
        const { id } = req.params;
        db.from('users')
                .select('username')
                .where('username', id)
                .then(row => {
                        if (row.length > 0) {
                                const rowsend = row[0];
                                res.status(200);
                                res.json(rowsend);
                        } else {
                                const rowsend = {
                                        username: '',
                                        password: '',
                                        givenname: '',
                                        surname: '',
                                        email: '',
                                        role: 'user',
                                        status: 'active',
                                };
                                res.status(200);
                                res.json(rowsend);
                        }
                })
                .catch(err => {
                        logger.main.error(err);
                        return next(err);
                });
});

router.route('/userCheck/email/:id').get(dupeLimiter, function(req, res, next) {
        const { id } = req.params;
        db.from('users')
                .select('email')
                .where('email', id)
                .then(row => {
                        if (row.length > 0) {
                                const rowsend = row[0];
                                res.status(200);
                                res.json(rowsend);
                        } else {
                                const rowsend = {
                                        username: '',
                                        password: '',
                                        givenname: '',
                                        surname: '',
                                        email: '',
                                        role: 'user',
                                        status: 'active',
                                };
                                res.status(200);
                                res.json(rowsend);
                        }
                })
                .catch(err => {
                        logger.main.error(err);
                        return next(err);
                });
});

module.exports = router;

