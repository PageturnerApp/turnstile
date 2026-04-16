// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const express = require('express');
const auth = require('../auth');
const configStore = require('../config');
const responses = require('../utils/responses');
const downloads = require('../utils/downloads');
const localFiles = require('../services/localfiles');
const torrentClientFactory = require('../services/torrentclient');

const router = express.Router();
const LOCAL_CACHED_ID = 'local-cached';

/**
 * Generate or redirect to a direct download URL for a completed torrent.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function requestDownloadRoute(req, res) {
  const torrentId = String(req.query.torrent_id || '').trim();
  if (!torrentId) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a torrent id.');
    return;
  }

  if (torrentId === LOCAL_CACHED_ID) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Cached results already include a direct download link.');
    return;
  }

  const config = configStore.getConfig();
  const torrentClient = torrentClientFactory.getTorrentClient(config);
  const torrent = await torrentClient.getTorrent(torrentId);

  if (!torrent) {
    responses.sendError(res, responses.HTTP_NOT_FOUND, 'That torrent could not be found.');
    return;
  }

  if (!localFiles.isPathInside(torrent.savePath, config.downloadsPath)) {
    responses.sendError(res, responses.HTTP_FORBIDDEN, 'This download is outside the configured downloads folder.');
    return;
  }

  const largestFile = localFiles.findLargestFile(torrent.savePath);
  if (!largestFile) {
    responses.sendError(res, responses.HTTP_NOT_FOUND, 'No downloadable file was found for this torrent yet.');
    return;
  }

  const relativePath = localFiles.toGlobalRelativePath(largestFile.path, config.downloadsPath);
  const url = downloads.buildDownloadUrl(config, req.apiToken, relativePath);

  if (downloads.parseBoolean(req.query.redirect)) {
    res.redirect(url);
    return;
  }

  responses.sendSuccess(res, 'Download link generated successfully.', url);
}

router.get('/', auth.requireApiKey, responses.asyncHandler(requestDownloadRoute));

module.exports = router;
