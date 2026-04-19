// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const express = require('express');
const auth = require('../auth');
const responses = require('../utils/responses');
const updateCheck = require('../services/updatecheck');

const router = express.Router();

/**
 * Return update status from the latest GitHub release.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function updateRoute(req, res) {
  const status = await updateCheck.checkForUpdates();
  const detail = status.checked
    ? 'Update status loaded successfully.'
    : 'Turnstile could not check for updates right now.';

  responses.sendSuccess(res, detail, status);
}

router.get('/', auth.requireUiSession, responses.asyncHandler(updateRoute));

module.exports = router;
