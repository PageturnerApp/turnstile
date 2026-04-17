// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const crypto = require('crypto');

const configStore = require('./config');
const responses = require('./utils/responses');

const BEARER_PREFIX = 'Bearer ';
const UI_AUTH_COOKIE_NAME = 'turnstile.ui';
const COOKIE_SEPARATOR = ';';
const COOKIE_NAME_VALUE_SEPARATOR = '=';
const SIGNED_VALUE_SEPARATOR = '.';
const HMAC_ALGORITHM = 'sha256';
const HASH_ALGORITHM = 'sha256';
const TOKEN_ENCODING = 'base64url';
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const UI_SESSION_MAX_AGE_MS = MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;
const HTTPS_PROTOCOL = 'https';
const FORWARDED_PROTO_HEADER = 'x-forwarded-proto';
const HEADER_VALUE_SEPARATOR = ',';
const ROOT_PATH = '/';

/**
 * Extract an API token from a query string or Authorization header.
 * @param {import('express').Request} req - Express request.
 * @returns {string}
 */
function getRequestToken(req) {
  if (req.query && req.query.token) {
    return String(req.query.token);
  }

  const authorization = req.get('authorization') || '';
  if (authorization.startsWith(BEARER_PREFIX)) {
    return authorization.slice(BEARER_PREFIX.length).trim();
  }

  return '';
}

/**
 * Compare two secret strings without leaking useful timing information.
 * @param {string} expected - Stored secret value.
 * @param {string} actual - User-supplied secret value.
 * @returns {boolean}
 */
function safeSecretEquals(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ''));
  const actualBuffer = Buffer.from(String(actual || ''));

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Return the first value from a comma-separated header.
 * @param {string} value - Raw header value.
 * @returns {string}
 */
function getFirstHeaderValue(value) {
  return String(value || '').split(HEADER_VALUE_SEPARATOR)[0].trim();
}

/**
 * Determine whether a request arrived through HTTPS.
 * @param {import('express').Request} req - Express request.
 * @returns {boolean}
 */
function isSecureRequest(req) {
  return Boolean(req.secure || getFirstHeaderValue(req.get(FORWARDED_PROTO_HEADER)) === HTTPS_PROTOCOL);
}

/**
 * Return the cookie path for the configured reverse-proxy base path.
 * @returns {string}
 */
function getUiCookiePath() {
  return configStore.getBridgeBasePath() || ROOT_PATH;
}

/**
 * Parse request cookies without adding a dependency.
 * @param {import('express').Request} req - Express request.
 * @returns {Object<string, string>}
 */
function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || '').split(COOKIE_SEPARATOR).forEach((cookie) => {
    const trimmed = cookie.trim();
    if (!trimmed) {
      return;
    }

    const separatorIndex = trimmed.indexOf(COOKIE_NAME_VALUE_SEPARATOR);
    if (separatorIndex === -1) {
      return;
    }

    const name = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (error) {
      cookies[name] = value;
    }
  });

  return cookies;
}

/**
 * Return a fingerprint for the current UI password hash.
 * @returns {string}
 */
function getUiPasswordFingerprint() {
  return crypto
    .createHash(HASH_ALGORITHM)
    .update(configStore.getConfig().uiPasswordHash || '')
    .digest(TOKEN_ENCODING);
}

/**
 * Sign a serialized cookie body.
 * @param {string} body - Serialized cookie body.
 * @returns {string}
 */
function signCookieBody(body) {
  return crypto
    .createHmac(HMAC_ALGORITHM, configStore.getSessionSecret())
    .update(body)
    .digest(TOKEN_ENCODING);
}

/**
 * Create a signed persistent UI session cookie value.
 * @returns {string}
 */
function createUiSessionCookieValue() {
  const payload = {
    uiAuthenticated: true,
    expiresAt: Date.now() + UI_SESSION_MAX_AGE_MS,
    passwordFingerprint: getUiPasswordFingerprint()
  };
  const body = Buffer.from(JSON.stringify(payload)).toString(TOKEN_ENCODING);
  return `${body}${SIGNED_VALUE_SEPARATOR}${signCookieBody(body)}`;
}

/**
 * Verify and decode a signed UI session cookie.
 * @param {string} cookieValue - Raw cookie value.
 * @returns {Object|null}
 */
function verifyUiSessionCookieValue(cookieValue) {
  const parts = String(cookieValue || '').split(SIGNED_VALUE_SEPARATOR);
  if (parts.length !== 2) {
    return null;
  }

  const body = parts[0];
  const signature = parts[1];
  if (!safeSecretEquals(signCookieBody(body), signature)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(body, TOKEN_ENCODING).toString('utf8'));
  } catch (error) {
    return null;
  }
}

/**
 * Check whether a request carries a valid persistent UI auth cookie.
 * @param {import('express').Request} req - Express request.
 * @returns {boolean}
 */
function hasValidUiSessionCookie(req) {
  const cookies = parseCookies(req);
  const payload = verifyUiSessionCookieValue(cookies[UI_AUTH_COOKIE_NAME]);

  return Boolean(
    payload
    && payload.uiAuthenticated
    && payload.expiresAt > Date.now()
    && payload.passwordFingerprint === getUiPasswordFingerprint()
  );
}

/**
 * Check whether a request is authenticated for the UI.
 * @param {import('express').Request} req - Express request.
 * @returns {boolean}
 */
function hasUiSession(req) {
  return Boolean((req.session && req.session.uiAuthenticated) || hasValidUiSessionCookie(req));
}

/**
 * Set the persistent UI auth cookie.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function setUiSessionCookie(req, res) {
  res.cookie(UI_AUTH_COOKIE_NAME, createUiSessionCookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: UI_SESSION_MAX_AGE_MS,
    path: getUiCookiePath()
  });
}

/**
 * Clear the persistent UI auth cookie.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function clearUiSessionCookie(req, res) {
  res.clearCookie(UI_AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: getUiCookiePath()
  });
}

/**
 * Find an API key record by raw key value.
 * @param {string} token - Raw API key.
 * @returns {Object|null}
 */
function findApiKey(token) {
  const normalizedToken = String(token || '');
  if (!normalizedToken) {
    return null;
  }

  const config = configStore.getConfig();
  return config.apiKeys.find((apiKey) => {
    const key = String(apiKey.key || '');
    return Boolean(key) && safeSecretEquals(key, normalizedToken);
  }) || null;
}

/**
 * Express middleware requiring a valid Turnstile API key.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Function} next - Express next callback.
 * @returns {void}
 */
function requireApiKey(req, res, next) {
  const token = getRequestToken(req);
  const apiKey = findApiKey(token);

  if (!apiKey) {
    responses.sendError(res, responses.HTTP_UNAUTHORIZED, 'Please provide a valid API key.');
    return;
  }

  req.apiKey = apiKey;
  req.apiToken = token;
  next();
}

/**
 * Express middleware requiring a logged-in UI session for API routes.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Function} next - Express next callback.
 * @returns {void}
 */
function requireUiSession(req, res, next) {
  if (hasUiSession(req)) {
    next();
    return;
  }

  responses.sendError(res, responses.HTTP_UNAUTHORIZED, 'Please sign in to continue.');
}

/**
 * Express middleware requiring a logged-in UI session for HTML pages.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {Function} next - Express next callback.
 * @returns {void}
 */
function requireUiPage(req, res, next) {
  const config = configStore.getConfig();

  if (!config.uiPasswordHash) {
    res.redirect(`${configStore.getBridgeBasePath()}/ui/setup`);
    return;
  }

  if (hasUiSession(req)) {
    next();
    return;
  }

  res.redirect(`${configStore.getBridgeBasePath()}/ui/login`);
}

module.exports = {
  getRequestToken,
  safeSecretEquals,
  setUiSessionCookie,
  clearUiSessionCookie,
  findApiKey,
  requireApiKey,
  requireUiSession,
  requireUiPage
};
