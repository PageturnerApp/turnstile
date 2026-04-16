// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const auth = require('../auth');
const configStore = require('../config');
const responses = require('../utils/responses');

const router = express.Router();
const EMPTY_LIST = [];

/**
 * Parse a category list from an array or comma-separated string.
 * @param {*} value - Raw category value.
 * @returns {Array<number>}
 */
function parseCategories(value) {
  if (Array.isArray(value)) {
    return value.map((category) => Number.parseInt(category, 10)).filter(Number.isInteger);
  }

  return String(value || '')
    .split(',')
    .map((category) => Number.parseInt(category.trim(), 10))
    .filter(Number.isInteger);
}

/**
 * Parse a string list from an array or comma-separated string.
 * @param {*} value - Raw list value.
 * @returns {Array<string>}
 */
function parseStringList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Mask an API key record for repeated display.
 * @param {Object} apiKey - API key record.
 * @returns {Object}
 */
function maskApiKey(apiKey) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    key: configStore.maskValue(apiKey.key),
    categories: apiKey.categories || EMPTY_LIST,
    indexers: apiKey.indexers || EMPTY_LIST,
    downloads_path: apiKey.downloads_path,
    created_at: apiKey.created_at
  };
}

/**
 * Build an API key record from a UI payload.
 * @param {Object} body - Request body.
 * @returns {Object}
 */
function buildApiKey(body) {
  const config = configStore.getConfig();
  return {
    id: uuidv4(),
    name: String(body.name || '').trim(),
    key: uuidv4(),
    categories: parseCategories(body.categories),
    indexers: parseStringList(body.indexers),
    downloads_path: String(body.downloads_path || body.downloadsPath || config.downloadsPath),
    created_at: new Date().toISOString()
  };
}

/**
 * Update mutable fields on an API key record.
 * @param {Object} apiKey - Existing key record.
 * @param {Object} body - Request body.
 * @returns {Object}
 */
function updateApiKey(apiKey, body) {
  return Object.assign({}, apiKey, {
    name: Object.prototype.hasOwnProperty.call(body, 'name') ? String(body.name || '').trim() : apiKey.name,
    categories: Object.prototype.hasOwnProperty.call(body, 'categories') ? parseCategories(body.categories) : apiKey.categories,
    indexers: Object.prototype.hasOwnProperty.call(body, 'indexers') ? parseStringList(body.indexers) : apiKey.indexers,
    downloads_path: Object.prototype.hasOwnProperty.call(body, 'downloads_path') || Object.prototype.hasOwnProperty.call(body, 'downloadsPath')
      ? String(body.downloads_path || body.downloadsPath || apiKey.downloads_path)
      : apiKey.downloads_path
  });
}

/**
 * Return all API keys with masked key values.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function listKeysRoute(req, res) {
  const config = configStore.getConfig();
  responses.sendSuccess(res, 'API keys loaded successfully.', config.apiKeys.map(maskApiKey));
}

/**
 * Create a new API key and return the raw key once.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function createKeyRoute(req, res) {
  const apiKey = buildApiKey(req.body || {});
  if (!apiKey.name) {
    responses.sendError(res, responses.HTTP_BAD_REQUEST, 'Please provide a name for this API key.');
    return;
  }

  const config = configStore.getConfig();
  configStore.setApiKeys(config.apiKeys.concat(apiKey));
  responses.sendSuccess(res, 'API key created successfully. Save it now because it will not be shown again.', apiKey);
}

/**
 * Delete an API key by id.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function deleteKeyRoute(req, res) {
  const config = configStore.getConfig();
  const nextKeys = config.apiKeys.filter((apiKey) => apiKey.id !== req.params.id);

  if (nextKeys.length === config.apiKeys.length) {
    responses.sendError(res, responses.HTTP_NOT_FOUND, 'That API key could not be found.');
    return;
  }

  configStore.setApiKeys(nextKeys);
  responses.sendSuccess(res, 'API key deleted successfully.', {
    id: req.params.id
  });
}

/**
 * Update an API key by id.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {void}
 */
function updateKeyRoute(req, res) {
  const config = configStore.getConfig();
  let found = false;
  const nextKeys = config.apiKeys.map((apiKey) => {
    if (apiKey.id !== req.params.id) {
      return apiKey;
    }

    found = true;
    return updateApiKey(apiKey, req.body || {});
  });

  if (!found) {
    responses.sendError(res, responses.HTTP_NOT_FOUND, 'That API key could not be found.');
    return;
  }

  configStore.setApiKeys(nextKeys);
  const updated = configStore.getConfig().apiKeys.find((apiKey) => apiKey.id === req.params.id);
  responses.sendSuccess(res, 'API key updated successfully.', maskApiKey(updated));
}

router.get('/', auth.requireUiSession, listKeysRoute);
router.post('/', auth.requireUiSession, createKeyRoute);
router.delete('/:id', auth.requireUiSession, deleteKeyRoute);
router.put('/:id', auth.requireUiSession, updateKeyRoute);

module.exports = router;
