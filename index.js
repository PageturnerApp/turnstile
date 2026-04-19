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

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const PASSWORD_MIN_LENGTH = 12;
const BCRYPT_ROUNDS = 12;
const SESSION_MAX_AGE_MS = MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;
const STATIC_CACHE_MINUTES = 5;
const STATIC_CACHE_SECONDS = STATIC_CACHE_MINUTES * SECONDS_PER_MINUTE;
const AUTH_RATE_LIMIT_WINDOW_MINUTES = 15;
const AUTH_RATE_LIMIT_CLEANUP_MINUTES = 5;
const AUTH_RATE_LIMIT_WINDOW_MS = AUTH_RATE_LIMIT_WINDOW_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const AUTH_RATE_LIMIT_CLEANUP_MS = AUTH_RATE_LIMIT_CLEANUP_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const LOGIN_MAX_ATTEMPTS = 8;
const SETUP_MAX_ATTEMPTS = 5;
const AUTH_RATE_LIMIT_KEY_DELIMITER = ':';
const LOGIN_RATE_LIMIT_SCOPE = 'login';
const SETUP_RATE_LIMIT_SCOPE = 'setup';
const AUTH_RATE_LIMIT_DETAIL = 'Too many attempts. Please wait a few minutes and try again.';
const UNTRUSTED_ORIGIN_DETAIL = 'That browser request was not accepted. Please refresh Turnstile and try again.';
const SESSION_COOKIE_NAME = 'turnstile.sid';
const UNKNOWN_REMOTE_ADDRESS = 'unknown';
const HEADER_VALUE_SEPARATOR = ',';
const URL_PROTOCOL_SEPARATOR = '://';
const SAFE_HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const FORWARDED_HOST_HEADER = 'x-forwarded-host';
const FORWARDED_PROTO_HEADER = 'x-forwarded-proto';
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'"
].join('; ');
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});
const NO_STORE_API_PREFIXES = ['/api/v1/config', '/api/v1/keys', '/api/v1/update'];
const UI_STATIC_ASSET_PATHS = ['/ui/app.js', '/ui/style.css', '/ui/turnstile-logo.png'];
const PUBLIC_UI_PATH = path.join(__dirname, 'public', 'ui');
const SETUP_PAGE = path.join(PUBLIC_UI_PATH, 'setup.html');
const LOGIN_PAGE = path.join(PUBLIC_UI_PATH, 'login.html');
const DASHBOARD_PAGE = path.join(PUBLIC_UI_PATH, 'index.html');
const SETTINGS_PAGE = path.join(PUBLIC_UI_PATH, 'settings.html');
const KEYS_PAGE = path.join(PUBLIC_UI_PATH, 'keys.html');

const app = express();
const authRateLimits = new Map();
let lastAuthRateLimitCleanupMs = 0;

app.set('trust proxy', true);
app.use(setSecurityHeaders);
app.use(setNoStoreForSensitiveRoutes);
app.use(blockUntrustedUiMutationOrigins);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: SESSION_COOKIE_NAME,
  secret: configStore.getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
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
app.use('/api/v1/update', require('./routes/update'));

/**
 * Apply browser security headers to every response.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Function} next - Express next callback.
 * @returns {void}
 */
function setSecurityHeaders(req, res, next) {
  Object.keys(SECURITY_HEADERS).forEach((header) => {
    res.setHeader(header, SECURITY_HEADERS[header]);
  });

  next();
}

/**
 * Determine whether a request is for a cacheable static UI asset.
 * @param {import('express').Request} req - Express request.
 * @returns {boolean}
 */
function isUiStaticAsset(req) {
  return UI_STATIC_ASSET_PATHS.includes(req.path);
}

/**
 * Prevent browsers and proxies from caching sensitive UI and settings responses.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Function} next - Express next callback.
 * @returns {void}
 */
function setNoStoreForSensitiveRoutes(req, res, next) {
  const isSensitiveApi = NO_STORE_API_PREFIXES.some((prefix) => req.path.startsWith(prefix));
  const isSensitiveUi = req.path.startsWith('/ui') && !isUiStaticAsset(req);

  if (isSensitiveApi || isSensitiveUi) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
}

/**
 * Return the first value from a comma-separated forwarding header.
 * @param {string} value - Raw header value.
 * @returns {string}
 */
function getFirstHeaderValue(value) {
  return String(value || '').split(HEADER_VALUE_SEPARATOR)[0].trim();
}

/**
 * Build a URL origin from a protocol and host.
 * @param {string} protocol - Request protocol.
 * @param {string} host - Request host.
 * @returns {string}
 */
function buildOrigin(protocol, host) {
  if (!host) {
    return '';
  }

  return `${String(protocol || '').replace(/:$/, '')}${URL_PROTOCOL_SEPARATOR}${host}`;
}

/**
 * Add a URL origin to a set when the value can be parsed.
 * @param {Set<string>} origins - Origin set.
 * @param {string} value - URL-like value.
 * @returns {void}
 */
function addParsedOrigin(origins, value) {
  try {
    if (value) {
      origins.add(new URL(value).origin);
    }
  } catch (error) {
    return;
  }
}

/**
 * Build the list of browser origins trusted for UI state changes.
 * @param {import('express').Request} req - Express request.
 * @returns {Set<string>}
 */
function getTrustedBrowserOrigins(req) {
  const origins = new Set();
  const forwardedHost = getFirstHeaderValue(req.get(FORWARDED_HOST_HEADER));
  const forwardedProto = getFirstHeaderValue(req.get(FORWARDED_PROTO_HEADER)) || req.protocol;

  addParsedOrigin(origins, configStore.getConfig().bridgeUrl);
  addParsedOrigin(origins, buildOrigin(forwardedProto, forwardedHost));
  addParsedOrigin(origins, buildOrigin(req.protocol, req.get('host')));

  return origins;
}

/**
 * Determine whether a request can mutate UI-managed state.
 * @param {import('express').Request} req - Express request.
 * @returns {boolean}
 */
function isUiMutationRequest(req) {
  if (SAFE_HTTP_METHODS.includes(req.method)) {
    return false;
  }

  return req.path.startsWith('/ui') || NO_STORE_API_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}

/**
 * Reject cross-origin browser attempts to mutate UI-managed state.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Function} next - Express next callback.
 * @returns {void}
 */
function blockUntrustedUiMutationOrigins(req, res, next) {
  const origin = req.get('origin');
  if (!isUiMutationRequest(req) || !origin) {
    next();
    return;
  }

  if (!getTrustedBrowserOrigins(req).has(origin)) {
    responses.sendError(res, responses.HTTP_FORBIDDEN, UNTRUSTED_ORIGIN_DETAIL);
    return;
  }

  next();
}

/**
 * Get the network address used for login rate limiting.
 * @param {import('express').Request} req - Express request.
 * @returns {string}
 */
function getRateLimitAddress(req) {
  return req.socket.remoteAddress || req.ip || UNKNOWN_REMOTE_ADDRESS;
}

/**
 * Build a stable key for an authentication rate-limit bucket.
 * @param {import('express').Request} req - Express request.
 * @param {string} scope - Rate-limit scope.
 * @returns {string}
 */
function getAuthRateLimitKey(req, scope) {
  return [scope, getRateLimitAddress(req)].join(AUTH_RATE_LIMIT_KEY_DELIMITER);
}

/**
 * Remove expired authentication rate-limit buckets on a bounded cadence.
 * @param {number} nowMs - Current timestamp in milliseconds.
 * @returns {void}
 */
function cleanupExpiredAuthRateLimits(nowMs) {
  if (nowMs - lastAuthRateLimitCleanupMs < AUTH_RATE_LIMIT_CLEANUP_MS) {
    return;
  }

  authRateLimits.forEach((entry, key) => {
    if (entry.resetAtMs <= nowMs) {
      authRateLimits.delete(key);
    }
  });

  lastAuthRateLimitCleanupMs = nowMs;
}

/**
 * Determine whether an authentication bucket is currently blocked.
 * @param {import('express').Request} req - Express request.
 * @param {string} scope - Rate-limit scope.
 * @param {number} maxAttempts - Maximum failed attempts in the window.
 * @returns {boolean}
 */
function isAuthRateLimited(req, scope, maxAttempts) {
  const nowMs = Date.now();
  cleanupExpiredAuthRateLimits(nowMs);

  const key = getAuthRateLimitKey(req, scope);
  const entry = authRateLimits.get(key);
  if (!entry || entry.resetAtMs <= nowMs) {
    authRateLimits.delete(key);
    return false;
  }

  return entry.count >= maxAttempts;
}

/**
 * Record a failed authentication attempt.
 * @param {import('express').Request} req - Express request.
 * @param {string} scope - Rate-limit scope.
 * @returns {void}
 */
function recordAuthFailure(req, scope) {
  const nowMs = Date.now();
  const key = getAuthRateLimitKey(req, scope);
  const existingEntry = authRateLimits.get(key);
  const entry = existingEntry && existingEntry.resetAtMs > nowMs
    ? existingEntry
    : {
      count: 0,
      resetAtMs: nowMs + AUTH_RATE_LIMIT_WINDOW_MS
    };

  entry.count += 1;
  authRateLimits.set(key, entry);
}

/**
 * Clear failed authentication attempts after a successful login or setup.
 * @param {import('express').Request} req - Express request.
 * @param {string} scope - Rate-limit scope.
 * @returns {void}
 */
function clearAuthFailures(req, scope) {
  authRateLimits.delete(getAuthRateLimitKey(req, scope));
}

/**
 * Create middleware that blocks excessive authentication attempts.
 * @param {string} scope - Rate-limit scope.
 * @param {number} maxAttempts - Maximum failed attempts in the window.
 * @returns {Function}
 */
function createAuthRateLimiter(scope, maxAttempts) {
  return function authRateLimiter(req, res, next) {
    if (isAuthRateLimited(req, scope, maxAttempts)) {
      responses.sendError(res, responses.HTTP_UNAUTHORIZED, AUTH_RATE_LIMIT_DETAIL);
      return;
    }

    next();
  };
}

/**
 * Regenerate the session and mark it as UI-authenticated.
 * @param {import('express').Request} req - Express request.
 * @returns {Promise<void>}
 */
function startAuthenticatedUiSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      req.session.uiAuthenticated = true;
      resolve();
    });
  });
}

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
    recordAuthFailure(req, SETUP_RATE_LIMIT_SCOPE);
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please choose a password with at least 12 characters.');
    return;
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  configStore.setUiPasswordHash(hash);
  clearAuthFailures(req, SETUP_RATE_LIMIT_SCOPE);
  await startAuthenticatedUiSession(req);
  auth.setUiSessionCookie(req, res);
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
    recordAuthFailure(req, LOGIN_RATE_LIMIT_SCOPE);
    responses.sendError(res, responses.HTTP_UNAUTHORIZED, 'The password you entered was not correct.');
    return;
  }

  clearAuthFailures(req, LOGIN_RATE_LIMIT_SCOPE);
  await startAuthenticatedUiSession(req);
  auth.setUiSessionCookie(req, res);
  res.redirect(externalPath('/ui'));
}

/**
 * End the current UI session.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function postLogout(req, res) {
  auth.clearUiSessionCookie(req, res);
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

app.get('/ui/:asset(style.css|app.js|turnstile-logo.png)', sendUiAsset);
app.get('/ui/setup', getSetupPage);
app.post('/ui/setup', createAuthRateLimiter(SETUP_RATE_LIMIT_SCOPE, SETUP_MAX_ATTEMPTS), responses.asyncHandler(postSetup));
app.get('/ui/login', getLoginPage);
app.post('/ui/login', createAuthRateLimiter(LOGIN_RATE_LIMIT_SCOPE, LOGIN_MAX_ATTEMPTS), responses.asyncHandler(postLogin));
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
