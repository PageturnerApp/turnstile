// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const express = require('express');
const packageInfo = require('../package.json');
const configStore = require('../config');
const responses = require('../utils/responses');
const prowlarr = require('../services/prowlarr');
const torrentClientFactory = require('../services/torrentclient');

const router = express.Router();

/**
 * Return Turnstile health information.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function healthRoute(req, res) {
  const config = configStore.getConfig();
  const torrentClient = torrentClientFactory.getTorrentClient(config);
  const prowlarrConnected = await prowlarr.testConnection();

  responses.sendSuccess(res, 'Turnstile is running.', {
    version: packageInfo.version,
    prowlarr: prowlarrConnected,
    torrent_client: config.torrentClient,
    torrent_client_connected: Boolean(torrentClient.authenticated)
  });
}

router.get('/', responses.asyncHandler(healthRoute));

module.exports = router;
