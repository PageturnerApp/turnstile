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
const prowlarr = require('../services/prowlarr');
const torrentClientFactory = require('../services/torrentclient');

const router = express.Router();
const MAGNET_PROTOCOL = 'magnet:';
const HTTP_URL_PATTERN = /^https?:\/\//i;
const CACHE_TERM_PARAMS = ['dn', 'name', 'title', 'file'];

/**
 * Add a unique non-empty term to a cache search term list.
 * @param {Array<string>} terms - Search terms.
 * @param {*} value - Candidate value.
 * @returns {void}
 */
function addCacheSearchTerm(terms, value) {
  const term = String(value || '').trim();
  if (term && !terms.includes(term)) {
    terms.push(term);
  }
}

/**
 * Return search terms that may identify an already-downloaded local item.
 * @param {Object} body - Request body.
 * @param {string} link - Submitted magnet or URL.
 * @returns {Array<string>}
 */
function getCacheSearchTerms(body, link) {
  const terms = [];
  addCacheSearchTerm(terms, body.name);
  addCacheSearchTerm(terms, body.title);
  addCacheSearchTerm(terms, body.filename);

  try {
    const parsedUrl = new URL(link);
    CACHE_TERM_PARAMS.forEach((param) => addCacheSearchTerm(terms, parsedUrl.searchParams.get(param)));

    if (parsedUrl.protocol !== 'magnet:') {
      addCacheSearchTerm(terms, parsedUrl.pathname.split('/').pop());
    }
  } catch (error) {
    return terms;
  }

  return terms;
}

/**
 * Return a cached local download response if the title is already present.
 * @param {Array<string>} terms - Candidate local cache search terms.
 * @param {Object} req - Express request.
 * @returns {Object|null}
 */
function getCachedDownload(terms, req) {
  if (!terms.length) {
    return null;
  }

  const config = configStore.getConfig();
  const keyDownloadsPath = downloads.getKeyDownloadsPath(req.apiKey, config);
  const matched = terms
    .map((term) => localFiles.matchesLocal(term, keyDownloadsPath, config.downloadsPath)[0])
    .find(Boolean);

  return matched ? {
    torrent_id: 'local-cached',
    name: matched.name,
    hash: null,
    cached: true,
    downloadUrl: downloads.buildDownloadUrl(config, req.apiToken, matched.relativePath)
  } : null;
}

/**
 * Determine whether a submitted link should be sent directly to the torrent client.
 * @param {string} link - Submitted magnet or URL.
 * @returns {boolean}
 */
function shouldAddDirectly(link) {
  return link.startsWith(MAGNET_PROTOCOL)
    || (HTTP_URL_PATTERN.test(link) && !prowlarr.isProwlarrDownloadUrl(link));
}

/**
 * Queue a torrent through Prowlarr after checking the local cache.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function createTorrentRoute(req, res) {
  const magnet = String(req.body.magnet || '').trim();
  const name = String(req.body.name || '').trim();

  if (!magnet) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a magnet link or download URL.');
    return;
  }

  const cached = getCachedDownload(getCacheSearchTerms(req.body || {}, magnet), req);
  if (cached) {
    responses.sendSuccess(res, 'This title is already downloaded and ready.', cached);
    return;
  }

  const config = configStore.getConfig();
  const torrentClient = torrentClientFactory.getTorrentClient(config);
  let torrent = null;

  if (shouldAddDirectly(magnet)) {
    const savePath = downloads.getKeyDownloadsPath(req.apiKey, config);
    const added = await torrentClient.addMagnet(magnet, savePath);
    torrent = await torrentClient.getTorrent(added.hash);
    torrent = torrent || {
      hash: added.hash,
      name: added.name
    };
  } else if (prowlarr.isProwlarrDownloadUrl(magnet)) {
    await prowlarr.grab(magnet);
    torrent = await torrentClient.getRecentlyAdded();
  } else {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a magnet link, direct torrent URL, or Prowlarr download URL.');
    return;
  }

  if (!torrent) {
    responses.sendError(res, responses.HTTP_SERVER_ERROR, 'The download was sent to Prowlarr, but Turnstile could not find it in the torrent client yet.');
    return;
  }

  responses.sendSuccess(res, 'Torrent added to download queue successfully.', {
    torrent_id: torrent.hash,
    name: torrent.name || name || 'New download',
    hash: torrent.hash,
    cached: false
  });
}

router.post('/', auth.requireApiKey, responses.asyncHandler(createTorrentRoute));

module.exports = router;
