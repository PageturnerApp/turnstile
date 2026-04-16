// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const axios = require('axios');
const path = require('path');
const { BaseTorrentClient, REQUEST_TIMEOUT_MS, UNKNOWN_ETA_SECONDS } = require('./base');

const TRANSMISSION_RPC_PATH = '/transmission/rpc';
const SESSION_ID_HEADER = 'x-transmission-session-id';
const SESSION_REQUIRED_STATUS = 409;
const INITIAL_RPC_ID = 1;
const COMPLETED_PROGRESS = 1;
const TORRENT_FIELDS = [
  'hashString',
  'name',
  'status',
  'percentDone',
  'totalSize',
  'rateDownload',
  'eta',
  'downloadDir',
  'addedDate'
];
const STATUS_MAP = {
  0: 'queued',
  3: 'queued',
  4: 'downloading',
  5: 'downloading',
  6: 'completed'
};

/**
 * Transmission JSON-RPC adapter.
 */
class TransmissionClient extends BaseTorrentClient {
  /**
   * Create a Transmission adapter.
   * @param {Object} config - Turnstile config.
   */
  constructor(config) {
    super(config);
    this.rpcId = INITIAL_RPC_ID;
    this.sessionId = '';
    this.endpoint = config.torrentClientUrl.endsWith(TRANSMISSION_RPC_PATH)
      ? config.torrentClientUrl
      : `${config.torrentClientUrl}${TRANSMISSION_RPC_PATH}`;
  }

  /**
   * Authenticate with Transmission and cache the session id.
   * @returns {Promise<void>}
   */
  async authenticate() {
    await this.rpcWithoutRetry('session-get', {});
    this.authenticated = true;
  }

  /**
   * Add a magnet link or URL to Transmission.
   * @param {string} magnet - Magnet link or URL.
   * @param {string} savePath - Directory to save the download.
   * @returns {Promise<{ hash: string, name: string }>}
   */
  async addMagnet(magnet, savePath) {
    return this.withAuthRetry(async () => {
      const result = await this.rpcWithoutRetry('torrent-add', {
        filename: magnet,
        'download-dir': savePath
      });
      const torrent = result['torrent-added'] || result['torrent_duplicate'] || result['torrent_added'] || result['torrent-duplicate'] || {};

      return {
        hash: torrent.hashString || torrent.hash_string || this.extractInfoHash(magnet),
        name: torrent.name || this.extractMagnetName(magnet)
      };
    });
  }

  /**
   * Get a Transmission torrent by hash.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async getTorrent(hash) {
    return this.withAuthRetry(async () => {
      const result = await this.rpcWithoutRetry('torrent-get', {
        ids: [hash],
        fields: TORRENT_FIELDS
      });
      const torrents = Array.isArray(result.torrents) ? result.torrents : [];
      return torrents.length > 0 ? this.normalizeTorrent(torrents[0]) : null;
    });
  }

  /**
   * Get the most recently added Transmission torrent.
   * @returns {Promise<Object|null>}
   */
  async getRecentlyAdded() {
    return this.withAuthRetry(async () => {
      const result = await this.rpcWithoutRetry('torrent-get', {
        fields: TORRENT_FIELDS
      });
      const torrents = Array.isArray(result.torrents) ? result.torrents : [];
      torrents.sort((left, right) => Number(right.addedDate || 0) - Number(left.addedDate || 0));
      return torrents.length > 0 ? this.normalizeTorrent(torrents[0]) : null;
    });
  }

  /**
   * Send a Transmission JSON-RPC request without the base retry wrapper.
   * @param {string} method - Transmission RPC method.
   * @param {Object} args - RPC arguments.
   * @returns {Promise<Object>}
   */
  async rpcWithoutRetry(method, args) {
    const body = {
      method,
      arguments: args,
      tag: this.rpcId
    };
    this.rpcId += INITIAL_RPC_ID;

    try {
      return await this.postRpc(body);
    } catch (error) {
      if (!error.response || error.response.status !== SESSION_REQUIRED_STATUS) {
        throw error;
      }

      this.sessionId = error.response.headers[SESSION_ID_HEADER];
      return this.postRpc(body);
    }
  }

  /**
   * POST a Transmission RPC body.
   * @param {Object} body - RPC request body.
   * @returns {Promise<Object>}
   */
  async postRpc(body) {
    const response = await axios.post(this.endpoint, body, {
      timeout: REQUEST_TIMEOUT_MS,
      auth: this.config.torrentClientUser || this.config.torrentClientPass ? {
        username: this.config.torrentClientUser,
        password: this.config.torrentClientPass
      } : undefined,
      headers: this.sessionId ? {
        'X-Transmission-Session-Id': this.sessionId
      } : {}
    });

    if (response.data && response.data.result !== 'success') {
      throw new Error(response.data.result || 'Transmission could not complete the request.');
    }

    return response.data.arguments || {};
  }

  /**
   * Convert a Transmission torrent row into the Turnstile shape.
   * @param {Object} torrent - Transmission torrent row.
   * @returns {Object}
   */
  normalizeTorrent(torrent) {
    const status = STATUS_MAP[torrent.status] || 'error';
    const progress = status === 'completed' ? COMPLETED_PROGRESS : Number(torrent.percentDone || 0);

    return {
      hash: torrent.hashString || torrent.hash_string,
      name: torrent.name || 'Unnamed torrent',
      status,
      progress,
      size: torrent.totalSize || torrent.total_size || 0,
      downloadSpeed: torrent.rateDownload || torrent.rate_download || 0,
      eta: typeof torrent.eta === 'number' ? torrent.eta : UNKNOWN_ETA_SECONDS,
      savePath: path.join(torrent.downloadDir || torrent.download_dir || this.config.downloadsPath, torrent.name || '')
    };
  }
}

module.exports = TransmissionClient;
