// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const path = require('path');
const fs = require('fs');

const TRUE_VALUES = ['true', '1', 'yes'];

/**
 * Return the download path that applies to an API key.
 * @param {Object} apiKey - API key record.
 * @param {Object} config - Turnstile config.
 * @returns {string}
 */
function getKeyDownloadsPath(apiKey, config) {
  return apiKey.downloads_path || apiKey.downloadsPath || config.downloadsPath;
}

/**
 * Build a servedl URL for a file relative to the global downloads path.
 * @param {Object} config - Turnstile config.
 * @param {string} token - Raw API token.
 * @param {string} relativePath - File path relative to global downloads root.
 * @returns {string}
 */
function buildDownloadUrl(config, token, relativePath) {
  const query = new URLSearchParams({
    token,
    file: relativePath
  });
  return `${config.bridgeUrl}/api/v1/torrents/servedl?${query.toString()}`;
}

/**
 * Convert a local file match into a search result.
 * @param {Object} localMatch - Local file match.
 * @param {Object} config - Turnstile config.
 * @param {string} token - Raw API token.
 * @returns {Object}
 */
function buildLocalSearchResult(localMatch, config, token) {
  return {
    id: 'local-cached',
    title: localMatch.name,
    size: localMatch.size,
    seeders: null,
    indexer: 'Local',
    cached: true,
    downloadUrl: buildDownloadUrl(config, token, localMatch.relativePath)
  };
}

/**
 * Parse a user-provided boolean query parameter.
 * @param {*} value - Query parameter value.
 * @returns {boolean}
 */
function parseBoolean(value) {
  return TRUE_VALUES.includes(String(value || '').toLocaleLowerCase());
}

/**
 * Convert a torrent object into the API response shape used by mylist.
 * @param {Object} torrent - Normalized torrent info.
 * @returns {Object}
 */
function formatTorrentInfo(torrent) {
  return {
    torrent_id: torrent.hash,
    name: torrent.name,
    status: torrent.status,
    progress: torrent.progress,
    size: torrent.size,
    download_speed: torrent.downloadSpeed,
    eta: torrent.eta,
    save_path: torrent.savePath,
    cached: false
  };
}

/**
 * Resolve a servedl file against both per-key and global roots.
 * @param {string} file - URL-provided file path.
 * @param {string} keyDownloadsPath - API-key downloads path.
 * @param {string} globalDownloadsPath - Global downloads path.
 * @returns {string}
 */
function resolveServedlCandidate(file, keyDownloadsPath, globalDownloadsPath) {
  const fromKeyRoot = path.resolve(keyDownloadsPath, file);
  const fromGlobalRoot = path.resolve(globalDownloadsPath, file);

  if (fs.existsSync(fromGlobalRoot)) {
    return fromGlobalRoot;
  }

  return fromKeyRoot;
}

module.exports = {
  getKeyDownloadsPath,
  buildDownloadUrl,
  buildLocalSearchResult,
  parseBoolean,
  formatTorrentInfo,
  resolveServedlCandidate
};
