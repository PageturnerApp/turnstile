// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const express = require('express');
const auth = require('../auth');
const configStore = require('../config');
const responses = require('../utils/responses');
const log = require('../utils/logger');
const prowlarr = require('../services/prowlarr');
const torrentClientFactory = require('../services/torrentclient');

const router = express.Router();
const MASK_PREFIX = '*';

/**
 * Return true when a submitted value is a masked placeholder from the UI.
 * @param {*} value - Submitted value.
 * @returns {boolean}
 */
function isMasked(value) {
  return String(value || '').startsWith(MASK_PREFIX);
}

/**
 * Convert a UI payload into config updates while preserving masked secrets.
 * @param {Object} body - Request body.
 * @returns {Object}
 */
function buildConfigUpdates(body) {
  const current = configStore.getConfig();
  const updates = {};
  const directFields = [
    'prowlarrUrl',
    'torrentClient',
    'torrentClientUrl',
    'torrentClientUser',
    'downloadsPath',
    'bridgeUrl',
    'port'
  ];

  directFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updates[field] = body[field];
    }
  });

  if (Object.prototype.hasOwnProperty.call(body, 'prowlarrApiKey')) {
    updates.prowlarrApiKey = isMasked(body.prowlarrApiKey)
      ? current.prowlarrApiKey
      : body.prowlarrApiKey;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'torrentClientPass')) {
    updates.torrentClientPass = isMasked(body.torrentClientPass)
      ? current.torrentClientPass
      : body.torrentClientPass;
  }

  return updates;
}

/**
 * Return UI-safe Turnstile configuration.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function getConfigRoute(req, res) {
  responses.sendSuccess(res, 'Configuration loaded successfully.', configStore.getMaskedConfig());
}

/**
 * Update Turnstile configuration from the UI.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function postConfigRoute(req, res) {
  const config = configStore.updateConfig(buildConfigUpdates(req.body || {}));
  torrentClientFactory.resetTorrentClient();

  try {
    await torrentClientFactory.getTorrentClient(config).authenticate();
  } catch (error) {
    log.warn(`Updated torrent client settings were saved, but the connection test failed: ${error.message}`);
  }

  responses.sendSuccess(res, 'Settings saved successfully.', configStore.getMaskedConfig());
}

/**
 * Test the configured Prowlarr connection.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function testProwlarrRoute(req, res) {
  const connected = await prowlarr.testConnection();
  responses.sendSuccess(res, connected ? 'Prowlarr connection succeeded.' : 'Prowlarr could not be reached.', {
    connected
  });
}

/**
 * Test the configured torrent client connection.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function testTorrentClientRoute(req, res) {
  const config = configStore.getConfig();
  const torrentClient = torrentClientFactory.getTorrentClient(config);

  try {
    await torrentClient.authenticate();
    responses.sendSuccess(res, 'Torrent client connection succeeded.', {
      connected: true
    });
  } catch (error) {
    responses.sendSuccess(res, 'Torrent client could not be reached.', {
      connected: false
    });
  }
}

router.get('/', auth.requireUiSession, getConfigRoute);
router.post('/', auth.requireUiSession, responses.asyncHandler(postConfigRoute));
router.post('/test/prowlarr', auth.requireUiSession, responses.asyncHandler(testProwlarrRoute));
router.post('/test/torrent-client', auth.requireUiSession, responses.asyncHandler(testTorrentClientRoute));

module.exports = router;
