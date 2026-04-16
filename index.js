// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

const auth = require('./auth');
const configStore = require('./config');
const log = require('./utils/logger');
const responses = require('./utils/responses');
const torrentClientFactory = require('./services/torrentclient');

const PASSWORD_MIN_LENGTH = 8;
const BCRYPT_ROUNDS = 12;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24;
const STATIC_CACHE_SECONDS = 300;
const PUBLIC_UI_PATH = path.join(__dirname, 'public', 'ui');
const SETUP_PAGE = path.join(PUBLIC_UI_PATH, 'setup.html');
const LOGIN_PAGE = path.join(PUBLIC_UI_PATH, 'login.html');
const DASHBOARD_PAGE = path.join(PUBLIC_UI_PATH, 'index.html');
const SETTINGS_PAGE = path.join(PUBLIC_UI_PATH, 'settings.html');
const KEYS_PAGE = path.join(PUBLIC_UI_PATH, 'keys.html');

const app = express();

app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: configStore.getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS
  }
}));

app.use('/api/v1/search', require('./routes/search'));
app.use('/api/v1/torrents/createtorrent', require('./routes/createtorrent'));
app.use('/api/v1/torrents/addhash', require('./routes/addhash'));
app.use('/api/v1/torrents/mylist', require('./routes/mylist'));
app.use('/api/v1/torrents/requestdl', require('./routes/requestdl'));
app.use('/api/v1/torrents/servedl', require('./routes/servedl'));
app.use('/api/v1/health', require('./routes/health'));
app.use('/api/v1/config', require('./routes/config'));
app.use('/api/v1/keys', require('./routes/keys'));

/**
 * Send a UI HTML file.
 * @param {import('express').Response} res - Express response.
 * @param {string} filePath - Absolute HTML file path.
 * @returns {void}
 */
function sendUiFile(res, filePath) {
  const html = fs.readFileSync(filePath, 'utf8').replace(/%BASE_HREF%/g, configStore.getBaseHref());
  res.type('html').send(html);
}

/**
 * Build a browser-facing path using the configured bridge base path.
 * @param {string} pathname - Root-relative application path.
 * @returns {string}
 */
function externalPath(pathname) {
  return `${configStore.getBridgeBasePath()}${pathname}`;
}

/**
 * Render static UI assets shared by authenticated and setup pages.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function sendUiAsset(req, res) {
  res.sendFile(path.join(PUBLIC_UI_PATH, req.params.asset), {
    maxAge: STATIC_CACHE_SECONDS * 1000
  });
}

/**
 * Render the setup page or redirect authenticated installations.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function getSetupPage(req, res) {
  const config = configStore.getConfig();
  if (config.uiPasswordHash) {
    res.redirect(externalPath('/ui'));
    return;
  }

  sendUiFile(res, SETUP_PAGE);
}

/**
 * Persist the initial UI password and start a session.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function postSetup(req, res) {
  const config = configStore.getConfig();
  if (config.uiPasswordHash) {
    res.redirect(externalPath('/ui'));
    return;
  }

  const password = String(req.body.password || '');
  if (password.length < PASSWORD_MIN_LENGTH) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please choose a password with at least 8 characters.');
    return;
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  configStore.setUiPasswordHash(hash);
  req.session.uiAuthenticated = true;
  res.redirect(externalPath('/ui'));
}

/**
 * Render the login page.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function getLoginPage(req, res) {
  const config = configStore.getConfig();
  if (!config.uiPasswordHash) {
    res.redirect(externalPath('/ui/setup'));
    return;
  }

  if (req.session && req.session.uiAuthenticated) {
    res.redirect(externalPath('/ui'));
    return;
  }

  sendUiFile(res, LOGIN_PAGE);
}

/**
 * Verify UI login credentials.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function postLogin(req, res) {
  const config = configStore.getConfig();
  if (!config.uiPasswordHash) {
    res.redirect(externalPath('/ui/setup'));
    return;
  }

  const password = String(req.body.password || '');
  const passwordMatches = await bcrypt.compare(password, config.uiPasswordHash);
  if (!passwordMatches) {
    responses.sendError(res, responses.HTTP_UNAUTHORIZED, 'The password you entered was not correct.');
    return;
  }

  req.session.uiAuthenticated = true;
  res.redirect(externalPath('/ui'));
}

/**
 * End the current UI session.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function postLogout(req, res) {
  req.session.destroy(() => {
    res.redirect(externalPath('/ui/login'));
  });
}

/**
 * Render the dashboard.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function getDashboardPage(req, res) {
  sendUiFile(res, DASHBOARD_PAGE);
}

/**
 * Render the settings page.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function getSettingsPage(req, res) {
  sendUiFile(res, SETTINGS_PAGE);
}

/**
 * Render the API keys page.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function getKeysPage(req, res) {
  sendUiFile(res, KEYS_PAGE);
}

/**
 * Return a JSON envelope for unknown API routes.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function apiNotFound(req, res) {
  responses.sendError(res, responses.HTTP_NOT_FOUND, 'That API endpoint could not be found.');
}

/**
 * Handle unexpected application errors.
 * @param {Error} error - Unhandled error.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Function} next - Express next callback.
 * @returns {void}
 */
function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  log.error(error.message || 'Unexpected server error.');
  responses.sendError(res, responses.HTTP_SERVER_ERROR, 'Something went wrong. Please try again later.');
}

/**
 * Authenticate the selected torrent client once during startup.
 * @returns {Promise<void>}
 */
async function authenticateTorrentClientOnStartup() {
  try {
    await torrentClientFactory.getTorrentClient(configStore.getConfig()).authenticate();
    log.info('Torrent client authenticated successfully.');
  } catch (error) {
    log.warn(`Torrent client authentication could not be completed: ${error.message}`);
  }
}

/**
 * Start the Turnstile HTTP server.
 * @returns {Promise<void>}
 */
async function startServer() {
  const config = configStore.getConfig();
  await authenticateTorrentClientOnStartup();

  app.listen(config.port, () => {
    if (!config.uiPasswordHash) {
      log.banner(`========================================
  Turnstile is running
  Complete setup at: http://localhost:${config.port}/ui
========================================`);
      return;
    }

    log.info(`Turnstile is running at http://localhost:${config.port}/ui`);
  });
}

app.get('/ui/:asset(style.css|app.js)', sendUiAsset);
app.get('/ui/setup', getSetupPage);
app.post('/ui/setup', responses.asyncHandler(postSetup));
app.get('/ui/login', getLoginPage);
app.post('/ui/login', responses.asyncHandler(postLogin));
app.post('/ui/logout', postLogout);
app.get('/ui', auth.requireUiPage, getDashboardPage);
app.get('/ui/settings', auth.requireUiPage, getSettingsPage);
app.get('/ui/keys', auth.requireUiPage, getKeysPage);
app.use('/api', apiNotFound);
app.use(errorHandler);

if (require.main === module) {
  startServer();
}

module.exports = app;
