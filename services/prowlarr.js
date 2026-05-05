// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const axios = require('axios');
const configStore = require('../config');

const DEFAULT_SEARCH_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 15000;
const PROWLARR_SEARCH_PATH = '/api/v1/search';
const PROWLARR_STATUS_PATH = '/api/v1/system/status';
const PROWLARR_DOWNLOAD_PATTERNS = [
  /\/api\/v1\/indexer\/\d+\/download$/,
  /\/\d+\/download$/
];

/**
 * Build a full Prowlarr API URL.
 * @param {string} pathname - Prowlarr API path.
 * @returns {string}
 */
function buildProwlarrUrl(pathname) {
  const config = configStore.getConfig();
  return `${config.prowlarrUrl}${pathname}`;
}

/**
 * Build request headers for Prowlarr.
 * @returns {Object}
 */
function buildProwlarrHeaders() {
  const config = configStore.getConfig();
  return {
    'X-Api-Key': config.prowlarrApiKey
  };
}

/**
 * Determine whether a link is a Prowlarr download URL for the configured instance.
 * @param {string} link - Candidate URL.
 * @returns {boolean}
 */
function isProwlarrDownloadUrl(link) {
  const config = configStore.getConfig();

  try {
    const prowlarrUrl = new URL(config.prowlarrUrl);
    const candidateUrl = new URL(link, config.prowlarrUrl);
    const normalizedPath = candidateUrl.pathname.replace(/\/+$/, '');

    return candidateUrl.origin === prowlarrUrl.origin
      && normalizedPath.includes(prowlarrUrl.pathname.replace(/\/+$/, ''))
      && PROWLARR_DOWNLOAD_PATTERNS.some((pattern) => pattern.test(normalizedPath));
  } catch (error) {
    return false;
  }
}

/**
 * Ensure Prowlarr has enough configuration to make requests.
 * @returns {void}
 */
function assertProwlarrConfigured() {
  const config = configStore.getConfig();
  if (!config.prowlarrUrl || !config.prowlarrApiKey) {
    throw new Error('Please configure the Prowlarr URL and API key first.');
  }
}

/**
 * Convert raw Prowlarr rows into Turnstile search result rows.
 * @param {Array<Object>} results - Raw Prowlarr results.
 * @returns {Array<Object>}
 */
function normalizeSearchResults(results) {
  return results.map((result) => ({
    id: result.magnetUrl || result.downloadUrl || result.guid || result.infoHash || result.title,
    title: result.title || 'Untitled result',
    size: result.size || 0,
    seeders: Object.prototype.hasOwnProperty.call(result, 'seeders') ? result.seeders : null,
    indexer: result.indexer || result.indexerName || 'Unknown',
    cached: false,
    downloadUrl: result.magnetUrl || result.downloadUrl || result.guid
  }));
}

/**
 * Filter Prowlarr rows using API-key indexer restrictions.
 * @param {Array<Object>} results - Normalized result rows.
 * @param {Array<string>} allowedIndexers - Allowed indexer names.
 * @returns {Array<Object>}
 */
function filterByIndexer(results, allowedIndexers) {
  if (!Array.isArray(allowedIndexers) || allowedIndexers.length === 0) {
    return results;
  }

  const allowed = allowedIndexers.map((indexer) => String(indexer).toLocaleLowerCase());
  return results.filter((result) => allowed.includes(String(result.indexer).toLocaleLowerCase()));
}

/**
 * Search Prowlarr with API-key-specific category and indexer restrictions.
 * @param {string} query - Search query.
 * @param {Object} apiKey - Authenticated API key record.
 * @param {number} limit - Maximum number of remote rows.
 * @returns {Promise<Array<Object>>}
 */
async function search(query, apiKey, limit) {
  assertProwlarrConfigured();

  const config = configStore.getConfig();
  const categories = Array.isArray(apiKey.categories) ? apiKey.categories : [];
  const requestLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_SEARCH_LIMIT;
  const params = new URLSearchParams({
    query,
    apikey: config.prowlarrApiKey,
    limit: String(requestLimit)
  });

  categories.forEach((category) => {
    params.append('categories', String(category));
  });

  const response = await axios.get(buildProwlarrUrl(PROWLARR_SEARCH_PATH), {
    params,
    headers: buildProwlarrHeaders(),
    timeout: REQUEST_TIMEOUT_MS
  });

  const normalized = normalizeSearchResults(Array.isArray(response.data) ? response.data : []);
  return filterByIndexer(normalized, apiKey.indexers || []).slice(0, requestLimit);
}

/**
 * Ask Prowlarr to grab a result link and send it to its configured download client.
 * @param {string} link - Magnet link or Prowlarr grab URL.
 * @returns {Promise<void>}
 */
async function grab(link) {
  assertProwlarrConfigured();

  const config = configStore.getConfig();
  const url = new URL(link, config.prowlarrUrl);

  if (url.protocol === 'magnet:') {
    throw new Error('Direct magnet links should be added through the torrent client.');
  }

  if (!url.searchParams.has('apikey')) {
    url.searchParams.set('apikey', config.prowlarrApiKey);
  }

  await axios.get(url.toString(), {
    headers: buildProwlarrHeaders(),
    timeout: REQUEST_TIMEOUT_MS
  });
}

/**
 * Check whether Prowlarr is reachable.
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    assertProwlarrConfigured();
    const config = configStore.getConfig();
    await axios.get(buildProwlarrUrl(PROWLARR_STATUS_PATH), {
      params: {
        apikey: config.prowlarrApiKey
      },
      headers: buildProwlarrHeaders(),
      timeout: REQUEST_TIMEOUT_MS
    });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  DEFAULT_SEARCH_LIMIT,
  search,
  grab,
  isProwlarrDownloadUrl,
  testConnection,
  _private: {
    normalizeSearchResults
  }
};
