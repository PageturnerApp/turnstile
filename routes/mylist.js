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
const LOCAL_CACHED_ID = 'local-cached';

/**
 * Return status for a torrent by hash.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function myListRoute(req, res) {
  const id = String(req.query.id || '').trim();
  if (!id) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a torrent id.');
    return;
  }

  if (id === LOCAL_CACHED_ID) {
    responses.sendSuccess(res, 'Already downloaded and ready.', {
      torrent_id: LOCAL_CACHED_ID,
      status: 'completed',
      progress: 1.0,
      cached: true
    });
    return;
  }

  const torrentClient = torrentClientFactory.getTorrentClient(configStore.getConfig());
  const torrent = await torrentClient.getTorrent(id);
  if (!torrent) {
    responses.sendError(res, responses.HTTP_NOT_FOUND, 'That torrent could not be found.');
    return;
  }

  responses.sendSuccess(res, 'Torrent found.', downloads.formatTorrentInfo(torrent));
}

router.get('/', auth.requireApiKey, responses.asyncHandler(myListRoute));

module.exports = router;
