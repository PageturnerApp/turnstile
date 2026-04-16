// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const configStore = require('./config');
const responses = require('./utils/responses');

const BEARER_PREFIX = 'Bearer ';

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
 * Find an API key record by raw key value.
 * @param {string} token - Raw API key.
 * @returns {Object|null}
 */
function findApiKey(token) {
  const config = configStore.getConfig();
  return config.apiKeys.find((apiKey) => apiKey.key === token) || null;
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
  if (req.session && req.session.uiAuthenticated) {
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

  if (req.session && req.session.uiAuthenticated) {
    next();
    return;
  }

  res.redirect(`${configStore.getBridgeBasePath()}/ui/login`);
}

module.exports = {
  getRequestToken,
  findApiKey,
  requireApiKey,
  requireUiSession,
  requireUiPage
};
