// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const axios = require('axios');

const REQUEST_TIMEOUT_MS = 15000;
const AUTH_ERROR_STATUSES = [401, 403];
const INFOHASH_REGEX = /btih:([a-fA-F0-9]{40}|[a-fA-F0-9]{64})/;
const UNKNOWN_ETA_SECONDS = -1;

/**
 * Base class for torrent client adapters.
 */
class BaseTorrentClient {
  /**
   * Create a torrent client adapter.
   * @param {Object} config - Turnstile config.
   */
  constructor(config) {
    this.config = config;
    this.authenticated = false;
    this.http = axios.create({
      baseURL: config.torrentClientUrl,
      timeout: REQUEST_TIMEOUT_MS
    });
  }

  /**
   * Add a magnet link or URL to the torrent client.
   * @param {string} magnet - Magnet link or URL.
   * @param {string} savePath - Directory to save the download.
   * @returns {Promise<{ hash: string, name: string }>}
   */
  async addMagnet(magnet, savePath) {
    throw new Error('This torrent client does not support adding downloads yet.');
  }

  /**
   * Get torrent info by hash.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async getTorrent(hash) {
    throw new Error('This torrent client does not support torrent lookups yet.');
  }

  /**
   * Get the most recently added torrent.
   * @returns {Promise<Object|null>}
   */
  async getRecentlyAdded() {
    throw new Error('This torrent client does not support recent torrent lookups yet.');
  }

  /**
   * Authenticate with the client.
   * @returns {Promise<void>}
   */
  async authenticate() {
    throw new Error('This torrent client does not support authentication yet.');
  }

  /**
   * Run an operation, re-authenticating once if the client reports an expired session.
   * @param {Function} operation - Async operation.
   * @returns {Promise<*>}
   */
  async withAuthRetry(operation) {
    if (!this.authenticated) {
      await this.authenticate();
    }

    try {
      return await operation();
    } catch (error) {
      if (!this.isAuthError(error)) {
        throw error;
      }

      this.authenticated = false;
      await this.authenticate();
      return operation();
    }
  }

  /**
   * Determine whether an error indicates an expired or invalid session.
   * @param {Error} error - Request error.
   * @returns {boolean}
   */
  isAuthError(error) {
    return Boolean(error.response && AUTH_ERROR_STATUSES.includes(error.response.status));
  }

  /**
   * Extract a BTIH infohash from a magnet link.
   * @param {string} magnet - Magnet link.
   * @returns {string}
   */
  extractInfoHash(magnet) {
    const match = INFOHASH_REGEX.exec(String(magnet || ''));
    return match ? match[1].toLowerCase() : '';
  }

  /**
   * Extract a display name from a magnet link.
   * @param {string} magnet - Magnet link.
   * @returns {string}
   */
  extractMagnetName(magnet) {
    const parsed = new URLSearchParams(String(magnet || '').split('?')[1] || '');
    return parsed.get('dn') || this.extractInfoHash(magnet) || 'New download';
  }
}

module.exports = {
  BaseTorrentClient,
  REQUEST_TIMEOUT_MS,
  UNKNOWN_ETA_SECONDS
};
