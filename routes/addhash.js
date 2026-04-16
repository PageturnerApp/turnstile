// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const express = require('express');
const auth = require('../auth');
const configStore = require('../config');
const responses = require('../utils/responses');
const downloads = require('../utils/downloads');
const torrentClientFactory = require('../services/torrentclient');

const router = express.Router();
const INFOHASH_REGEX = /^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/;

/**
 * Build a magnet URI from an infohash and display name.
 * @param {string} infohash - Torrent infohash.
 * @param {string} name - Optional display name.
 * @returns {string}
 */
function buildMagnet(infohash, name) {
  const params = new URLSearchParams({
    xt: `urn:btih:${infohash}`
  });

  if (name) {
    params.set('dn', name);
  }

  return `magnet:?${params.toString()}`;
}

/**
 * Add a torrent directly by infohash, bypassing Prowlarr.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function addHashRoute(req, res) {
  const infohash = String(req.body.infohash || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();

  if (!INFOHASH_REGEX.test(infohash)) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a valid 40 or 64 character torrent infohash.');
    return;
  }

  const config = configStore.getConfig();
  const torrentClient = torrentClientFactory.getTorrentClient(config);
  const savePath = downloads.getKeyDownloadsPath(req.apiKey, config);
  await torrentClient.addMagnet(buildMagnet(infohash, name), savePath);

  responses.sendSuccess(res, 'Torrent added via infohash successfully.', {
    torrent_id: infohash,
    name: name || infohash,
    hash: infohash,
    cached: false
  });
}

router.post('/', auth.requireApiKey, responses.asyncHandler(addHashRoute));

module.exports = router;
