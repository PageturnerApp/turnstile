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
const AUTHORITATIVE_ADD_RESULT_CLIENTS = ['deluge', 'transmission'];

const PROWLARR_RECENT_MATCH_THRESHOLD = 90;
const PROWLARR_RECENT_MATCH_RETRIES = 10;
const PROWLARR_RECENT_MATCH_DELAY_MS = 1500;

/**
 * Pause for a short delay.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine whether a torrent name strongly matches any expected search term.
 * @param {string} torrentName - Candidate torrent name.
 * @param {Array<string>} terms - Expected title/release terms.
 * @returns {boolean}
 */
function matchesRequestedTorrentName(torrentName, terms) {
  return terms.some((term) => localFiles.scoreLocalNameMatch(term, torrentName) >= PROWLARR_RECENT_MATCH_THRESHOLD);
}

/**
 * Determine whether a recent torrent is different from the pre-grab baseline.
 * @param {Object|null} recentTorrent - Latest recent torrent.
 * @param {Object|null} previousRecentTorrent - Recent torrent before the grab.
 * @returns {boolean}
 */
function isDifferentRecentTorrent(recentTorrent, previousRecentTorrent) {
  if (!recentTorrent || !recentTorrent.hash) {
    return false;
  }

  if (!previousRecentTorrent || !previousRecentTorrent.hash) {
    return true;
  }

  return recentTorrent.hash !== previousRecentTorrent.hash;
}

/**
 * Determine whether a torrent can be accepted as the requested release.
 * @param {Object|null} torrent - Candidate torrent.
 * @param {Array<string>} terms - Expected title/release terms.
 * @param {Object|null} previousRecentTorrent - Recent torrent before the add.
 * @returns {boolean}
 */
function isConfidentTorrentMatch(torrent, terms, previousRecentTorrent, trustHash) {
  if (!isDifferentRecentTorrent(torrent, previousRecentTorrent)) {
    return false;
  }

  if (trustHash) {
    return true;
  }

  if (!terms.length) {
    return true;
  }

  return matchesRequestedTorrentName(torrent.name || '', terms);
}

/**
 * Build a safe fallback torrent from an add response when a direct lookup is not ready yet.
 * @param {{ hash: string, name: string }} added - Torrent client add response.
 * @param {Array<string>} terms - Expected title/release terms.
 * @param {Object|null} previousRecentTorrent - Recent torrent before the add.
 * @returns {Object|null}
 */
function buildAddedTorrentFallback(added, terms, previousRecentTorrent, trustHash) {
  if (!added || !added.hash) {
    return null;
  }

  const candidate = {
    hash: added.hash,
    name: added.name || 'New download'
  };

  return isConfidentTorrentMatch(candidate, terms, previousRecentTorrent, trustHash) ? candidate : null;
}

/**
 * Wait for the torrent client to expose a newly grabbed torrent that can be matched safely.
 * @param {Object} torrentClient - Torrent client adapter.
 * @param {Array<string>} terms - Expected title/release terms.
 * @param {Object|null} previousRecentTorrent - Recent torrent before the grab.
 * @returns {Promise<Object|null>}
 */
async function waitForRecentlyGrabbedTorrent(torrentClient, terms, previousRecentTorrent) {
  const hasExpectedTerms = terms.length > 0;

  for (let attempt = 0; attempt < PROWLARR_RECENT_MATCH_RETRIES; attempt += 1) {
    const recent = await torrentClient.getRecentlyAdded();
    const isNewRecentTorrent = isDifferentRecentTorrent(recent, previousRecentTorrent);

    if (recent && isNewRecentTorrent && (!hasExpectedTerms || matchesRequestedTorrentName(recent.name || '', terms))) {
      return recent;
    }

    await delay(PROWLARR_RECENT_MATCH_DELAY_MS);
  }

  return null;
}

/**
 * Resolve a newly added torrent using a direct lookup first, then a recent-torrent fallback.
 * @param {Object} torrentClient - Torrent client adapter.
 * @param {{ hash: string, name: string }} added - Torrent client add response.
 * @param {Array<string>} terms - Expected title/release terms.
 * @param {Object|null} previousRecentTorrent - Recent torrent before the add.
 * @returns {Promise<Object|null>}
 */
async function resolveAddedTorrent(torrentClient, added, terms, previousRecentTorrent, trustHash) {
  if (added && added.hash) {
    const torrent = await torrentClient.getTorrent(added.hash);
    if (isConfidentTorrentMatch(torrent, terms, previousRecentTorrent, trustHash)) {
      return torrent;
    }
  }

  const fallback = buildAddedTorrentFallback(added, terms, previousRecentTorrent, trustHash);
  if (fallback) {
    return fallback;
  }

  return waitForRecentlyGrabbedTorrent(torrentClient, terms, previousRecentTorrent);
}

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

    if (parsedUrl.protocol !== 'magnet:' && !prowlarr.isProwlarrDownloadUrl(link)) {
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
  let matched = null;

  terms.some((term) => {
    const candidates = localFiles.matchesLocal(term, keyDownloadsPath, config.downloadsPath)
      .map((candidate) => ({
        candidate,
        score: localFiles.scoreLocalNameMatch(term, candidate.name)
      }))
      .sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name));

    if (!candidates.length) {
      return false;
    }

    const best = candidates[0];
    const runnerUp = candidates[1] || null;
    const hasStrongLead = !runnerUp || best.score - runnerUp.score >= 10;
    const isStrictEnough = best.score >= 90;

    if (isStrictEnough && hasStrongLead) {
      matched = best.candidate;
      return true;
    }

    return false;
  });

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
  const trustHash = AUTHORITATIVE_ADD_RESULT_CLIENTS.includes(config.torrentClient);
  let torrent = null;
  const expectedTerms = getCacheSearchTerms(req.body || {}, magnet);

  if (shouldAddDirectly(magnet)) {
    const savePath = downloads.getKeyDownloadsPath(req.apiKey, config);
    const added = await torrentClient.addMagnet(magnet, savePath);
    torrent = await torrentClient.getTorrent(added.hash);
    torrent = torrent || {
      hash: added.hash,
      name: added.name
    };
  } else if (prowlarr.isProwlarrDownloadUrl(magnet)) {
    const savePath = downloads.getKeyDownloadsPath(req.apiKey, config);
    const previousRecentTorrent = await torrentClient.getRecentlyAdded();
    const added = await torrentClient.addMagnet(magnet, savePath);
    torrent = await resolveAddedTorrent(torrentClient, added, expectedTerms, previousRecentTorrent, trustHash);
  } else {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a magnet link, direct torrent URL, or Prowlarr download URL.');
    return;
  }

  if (!torrent) {
    responses.sendError(res, responses.HTTP_SERVER_ERROR, 'Turnstile queued the download, but could not confidently match the new torrent in the client yet.');
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
module.exports._private = {
  AUTHORITATIVE_ADD_RESULT_CLIENTS,
  buildAddedTorrentFallback,
  getCacheSearchTerms,
  isConfidentTorrentMatch,
  isDifferentRecentTorrent,
  matchesRequestedTorrentName,
  resolveAddedTorrent
};
