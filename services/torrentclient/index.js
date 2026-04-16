// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const QBittorrentClient = require('./qbittorrent');
const DelugeClient = require('./deluge');
const TransmissionClient = require('./transmission');
const RTorrentClient = require('./rtorrent');

let cachedClient = null;
let cachedSignature = '';

/**
 * Build a cache signature for torrent client settings.
 * @param {Object} config - Turnstile config.
 * @returns {string}
 */
function buildSignature(config) {
  return [
    config.torrentClient,
    config.torrentClientUrl,
    config.torrentClientUser,
    config.torrentClientPass,
    config.downloadsPath
  ].join('|');
}

/**
 * Create a torrent client adapter for the selected client type.
 * @param {Object} config - Turnstile config.
 * @returns {Object}
 */
function createTorrentClient(config) {
  switch (config.torrentClient) {
    case 'qbittorrent':
      return new QBittorrentClient(config);
    case 'deluge':
      return new DelugeClient(config);
    case 'transmission':
      return new TransmissionClient(config);
    case 'rtorrent':
      return new RTorrentClient(config);
    default:
      throw new Error('Please choose a supported torrent client type.');
  }
}

/**
 * Return a cached torrent client adapter, rebuilding it when config changes.
 * @param {Object} config - Turnstile config.
 * @returns {Object}
 */
function getTorrentClient(config) {
  const signature = buildSignature(config);
  if (!cachedClient || cachedSignature !== signature) {
    cachedClient = createTorrentClient(config);
    cachedSignature = signature;
  }

  return cachedClient;
}

/**
 * Clear the cached adapter so the next request uses fresh settings.
 * @returns {void}
 */
function resetTorrentClient() {
  cachedClient = null;
  cachedSignature = '';
}

module.exports = {
  createTorrentClient,
  getTorrentClient,
  resetTorrentClient
};
