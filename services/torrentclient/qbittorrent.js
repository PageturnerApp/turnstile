// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const path = require('path');
const { BaseTorrentClient, UNKNOWN_ETA_SECONDS } = require('./base');

const LOGIN_PATH = '/api/v2/auth/login';
const ADD_PATH = '/api/v2/torrents/add';
const INFO_PATH = '/api/v2/torrents/info';
const HTTP_FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const COMPLETED_PROGRESS = 1;
const QUEUED_PROGRESS = 0;
const STATUS_MAP = {
  downloading: 'downloading',
  stalledDL: 'downloading',
  checkingDL: 'downloading',
  metaDL: 'downloading',
  uploading: 'completed',
  stalledUP: 'completed',
  checkingUP: 'completed',
  forcedUP: 'completed',
  pausedDL: 'queued',
  queuedDL: 'queued',
  error: 'error',
  missingFiles: 'error',
  unknown: 'error'
};

/**
 * qBittorrent Web API adapter.
 */
class QBittorrentClient extends BaseTorrentClient {
  /**
   * Create a qBittorrent adapter.
   * @param {Object} config - Turnstile config.
   */
  constructor(config) {
    super(config);
    this.cookie = '';
  }

  /**
   * Authenticate with qBittorrent and cache the session cookie.
   * @returns {Promise<void>}
   */
  async authenticate() {
    const body = new URLSearchParams({
      username: this.config.torrentClientUser,
      password: this.config.torrentClientPass
    });

    const response = await this.http.post(LOGIN_PATH, body.toString(), {
      headers: {
        'Content-Type': HTTP_FORM_CONTENT_TYPE,
        Referer: this.config.torrentClientUrl
      }
    });

    if (String(response.data).trim() !== 'Ok.') {
      throw new Error('qBittorrent rejected the configured username or password.');
    }

    this.cookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ')
      : '';
    this.authenticated = true;
  }

  /**
   * Add a magnet link or URL to qBittorrent.
   * @param {string} magnet - Magnet link or URL.
   * @param {string} savePath - Directory to save the download.
   * @returns {Promise<{ hash: string, name: string }>}
   */
  async addMagnet(magnet, savePath) {
    return this.withAuthRetry(async () => {
      const body = new URLSearchParams({
        urls: magnet,
        savepath: savePath
      });

      await this.http.post(ADD_PATH, body.toString(), {
        headers: this.buildHeaders({
          'Content-Type': HTTP_FORM_CONTENT_TYPE
        })
      });

      const torrent = await this.fetchRecentlyAdded();
      return {
        hash: torrent ? torrent.hash : this.extractInfoHash(magnet),
        name: torrent ? torrent.name : this.extractMagnetName(magnet)
      };
    });
  }

  /**
   * Get a qBittorrent torrent by hash.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async getTorrent(hash) {
    return this.withAuthRetry(() => this.fetchTorrentByHash(hash));
  }

  /**
   * Get the most recently added qBittorrent torrent.
   * @returns {Promise<Object|null>}
   */
  async getRecentlyAdded() {
    return this.withAuthRetry(() => this.fetchRecentlyAdded());
  }

  /**
   * Build request headers including the cached session cookie.
   * @param {Object} extraHeaders - Additional headers.
   * @returns {Object}
   */
  buildHeaders(extraHeaders) {
    return Object.assign({
      Referer: this.config.torrentClientUrl
    }, extraHeaders || {}, this.cookie ? { Cookie: this.cookie } : {});
  }

  /**
   * Fetch one torrent by hash without retrying authentication.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async fetchTorrentByHash(hash) {
    const response = await this.http.get(INFO_PATH, {
      params: {
        hashes: hash
      },
      headers: this.buildHeaders()
    });

    const torrents = Array.isArray(response.data) ? response.data : [];
    return torrents.length > 0 ? this.normalizeTorrent(torrents[0]) : null;
  }

  /**
   * Fetch the most recently added torrent without retrying authentication.
   * @returns {Promise<Object|null>}
   */
  async fetchRecentlyAdded() {
    const response = await this.http.get(INFO_PATH, {
      params: {
        sort: 'added_on',
        reverse: true,
        limit: 1
      },
      headers: this.buildHeaders()
    });

    const torrents = Array.isArray(response.data) ? response.data : [];
    return torrents.length > 0 ? this.normalizeTorrent(torrents[0]) : null;
  }

  /**
   * Convert a qBittorrent torrent row into the Turnstile shape.
   * @param {Object} torrent - qBittorrent torrent row.
   * @returns {Object}
   */
  normalizeTorrent(torrent) {
    const status = STATUS_MAP[torrent.state] || 'error';
    const progress = typeof torrent.progress === 'number'
      ? torrent.progress
      : status === 'completed' ? COMPLETED_PROGRESS : QUEUED_PROGRESS;

    return {
      hash: torrent.hash,
      name: torrent.name || 'Unnamed torrent',
      status,
      progress,
      size: torrent.size || 0,
      downloadSpeed: torrent.dlspeed || 0,
      eta: typeof torrent.eta === 'number' ? torrent.eta : UNKNOWN_ETA_SECONDS,
      savePath: torrent.content_path || path.join(torrent.save_path || this.config.downloadsPath, torrent.name || '')
    };
  }
}

module.exports = QBittorrentClient;
