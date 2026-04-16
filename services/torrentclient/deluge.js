// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const axios = require('axios');
const path = require('path');
const { BaseTorrentClient, REQUEST_TIMEOUT_MS, UNKNOWN_ETA_SECONDS } = require('./base');

const INITIAL_RPC_ID = 1;
const ONE_HUNDRED_PERCENT = 100;
const COMPLETED_PROGRESS = 1;
const DELUGE_JSON_PATH = '/json';
const TORRENT_FIELDS = [
  'name',
  'state',
  'progress',
  'total_size',
  'download_payload_rate',
  'eta',
  'save_path',
  'time_added'
];
const STATUS_MAP = {
  Downloading: 'downloading',
  Seeding: 'completed',
  Queued: 'queued',
  Error: 'error',
  Paused: 'queued'
};

/**
 * Deluge JSON-RPC adapter.
 */
class DelugeClient extends BaseTorrentClient {
  /**
   * Create a Deluge adapter.
   * @param {Object} config - Turnstile config.
   */
  constructor(config) {
    super(config);
    this.rpcId = INITIAL_RPC_ID;
    this.cookie = '';
    this.endpoint = config.torrentClientUrl.endsWith(DELUGE_JSON_PATH)
      ? config.torrentClientUrl
      : `${config.torrentClientUrl}${DELUGE_JSON_PATH}`;
  }

  /**
   * Authenticate with Deluge and cache the session cookie.
   * @returns {Promise<void>}
   */
  async authenticate() {
    const result = await this.rpcWithoutRetry('auth.login', [this.config.torrentClientPass]);
    if (!result) {
      throw new Error('Deluge rejected the configured password.');
    }

    await this.ensureDaemonConnected();
    this.authenticated = true;
  }

  /**
   * Add a magnet link or URL to Deluge.
   * @param {string} magnet - Magnet link or URL.
   * @param {string} savePath - Directory to save the download.
   * @returns {Promise<{ hash: string, name: string }>}
   */
  async addMagnet(magnet, savePath) {
    return this.withAuthRetry(async () => {
      const method = String(magnet).startsWith('magnet:')
        ? 'core.add_torrent_magnet'
        : 'core.add_torrent_url';
      const hash = await this.rpcWithoutRetry(method, [
        magnet,
        {
          download_location: savePath
        }
      ]);
      const torrent = hash ? await this.fetchTorrent(hash) : null;

      return {
        hash: hash || this.extractInfoHash(magnet),
        name: torrent ? torrent.name : this.extractMagnetName(magnet)
      };
    });
  }

  /**
   * Get a Deluge torrent by hash.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async getTorrent(hash) {
    return this.withAuthRetry(() => this.fetchTorrent(hash));
  }

  /**
   * Get the most recently added Deluge torrent.
   * @returns {Promise<Object|null>}
   */
  async getRecentlyAdded() {
    return this.withAuthRetry(async () => {
      const torrents = await this.rpcWithoutRetry('core.get_torrents_status', [{}, TORRENT_FIELDS]);
      const entries = Object.keys(torrents || {}).map((hash) => this.normalizeTorrent(hash, torrents[hash]));
      entries.sort((left, right) => right.timeAdded - left.timeAdded);
      return entries.length > 0 ? entries[0] : null;
    });
  }

  /**
   * Fetch and normalize a single torrent without retrying authentication.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async fetchTorrent(hash) {
    const torrent = await this.rpcWithoutRetry('core.get_torrent_status', [hash, TORRENT_FIELDS]);
    return torrent ? this.normalizeTorrent(hash, torrent) : null;
  }

  /**
   * Send a Deluge JSON-RPC request without the base retry wrapper.
   * @param {string} method - Deluge RPC method.
   * @param {Array<*>} params - RPC parameters.
   * @returns {Promise<*>}
   */
  async rpcWithoutRetry(method, params) {
    const response = await axios.post(this.endpoint, {
      method,
      params,
      id: this.rpcId
    }, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: this.cookie ? { Cookie: this.cookie } : {}
    });

    this.rpcId += INITIAL_RPC_ID;
    if (Array.isArray(response.headers['set-cookie'])) {
      this.cookie = response.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
    }

    if (response.data && response.data.error) {
      throw new Error(response.data.error.message || 'Deluge could not complete the request.');
    }

    return response.data ? response.data.result : null;
  }

  /**
   * Ensure the Deluge web process is connected to a daemon.
   * @returns {Promise<void>}
   */
  async ensureDaemonConnected() {
    const connected = await this.rpcWithoutRetry('web.connected', []);
    if (connected) {
      return;
    }

    const hosts = await this.rpcWithoutRetry('web.get_hosts', []);
    if (!Array.isArray(hosts) || hosts.length === 0) {
      throw new Error('Deluge is not connected to a daemon. Please connect one in the Deluge web UI.');
    }

    const preferredHost = hosts.find((host) => Array.isArray(host) && String(host[3]).toLowerCase() === 'online') || hosts[0];
    await this.rpcWithoutRetry('web.connect', [preferredHost[0]]);
  }

  /**
   * Convert a Deluge torrent row into the Turnstile shape.
   * @param {string} hash - Torrent hash.
   * @param {Object} torrent - Deluge torrent row.
   * @returns {Object}
   */
  normalizeTorrent(hash, torrent) {
    const status = STATUS_MAP[torrent.state] || 'error';
    const progress = status === 'completed'
      ? COMPLETED_PROGRESS
      : (Number(torrent.progress || 0) / ONE_HUNDRED_PERCENT);

    return {
      hash,
      name: torrent.name || 'Unnamed torrent',
      status,
      progress,
      size: torrent.total_size || 0,
      downloadSpeed: torrent.download_payload_rate || 0,
      eta: typeof torrent.eta === 'number' ? torrent.eta : UNKNOWN_ETA_SECONDS,
      savePath: path.join(torrent.save_path || this.config.downloadsPath, torrent.name || ''),
      timeAdded: Number(torrent.time_added || 0)
    };
  }
}

module.exports = DelugeClient;
