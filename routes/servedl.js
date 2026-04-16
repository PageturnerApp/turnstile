// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const express = require('express');
const path = require('path');
const auth = require('../auth');
const configStore = require('../config');
const responses = require('../utils/responses');
const downloads = require('../utils/downloads');
const localFiles = require('../services/localfiles');

const router = express.Router();

/**
 * Send a file download response.
 * @param {import('express').Response} res - Express response.
 * @param {string} filePath - Absolute file path.
 * @returns {void}
 */
function downloadFile(res, filePath) {
  res.download(filePath, path.basename(filePath), (error) => {
    if (error && !res.headersSent) {
      responses.sendError(res, responses.HTTP_SERVER_ERROR, 'The file could not be downloaded right now.');
    }
  });
}

/**
 * Serve a direct download file from the configured downloads root.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function serveDownloadRoute(req, res) {
  const file = String(req.query.file || '').trim();
  if (!file) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a file path.');
    return;
  }

  const config = configStore.getConfig();
  const keyDownloadsPath = downloads.getKeyDownloadsPath(req.apiKey, config);
  const candidatePath = downloads.resolveServedlCandidate(file, keyDownloadsPath, config.downloadsPath);

  if (!localFiles.isPathInside(candidatePath, config.downloadsPath)) {
    responses.sendError(res, responses.HTTP_FORBIDDEN, 'That file path is not allowed.');
    return;
  }

  const largestFile = localFiles.findLargestFile(candidatePath);
  if (!largestFile) {
    responses.sendError(res, responses.HTTP_NOT_FOUND, 'That file could not be found.');
    return;
  }

  if (!localFiles.isPathInside(largestFile.path, config.downloadsPath)) {
    responses.sendError(res, responses.HTTP_FORBIDDEN, 'That file path is not allowed.');
    return;
  }

  downloadFile(res, largestFile.path);
}

router.get('/', auth.requireApiKey, serveDownloadRoute);

module.exports = router;
