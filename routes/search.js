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

const router = express.Router();

/**
 * Parse a positive integer limit.
 * @param {*} value - Raw query value.
 * @returns {number}
 */
function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : prowlarr.DEFAULT_SEARCH_LIMIT;
}

/**
 * Search local files first, then Prowlarr.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function searchRoute(req, res) {
  const query = String(req.query.q || '').trim();
  if (!query) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a search query.');
    return;
  }

  const config = configStore.getConfig();
  const keyDownloadsPath = downloads.getKeyDownloadsPath(req.apiKey, config);
  const localMatches = localFiles
    .matchesLocal(query, keyDownloadsPath, config.downloadsPath)
    .map((match) => downloads.buildLocalSearchResult(match, config, req.apiToken));
  const remoteMatches = await prowlarr.search(query, req.apiKey, parseLimit(req.query.limit));

  responses.sendSuccess(res, 'Search results found successfully.', localMatches.concat(remoteMatches));
}

router.get('/', auth.requireApiKey, responses.asyncHandler(searchRoute));

module.exports = router;
