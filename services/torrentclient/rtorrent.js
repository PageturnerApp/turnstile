// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const axios = require('axios');
const { BaseTorrentClient, REQUEST_TIMEOUT_MS, UNKNOWN_ETA_SECONDS } = require('./base');

const XML_CONTENT_TYPE = 'text/xml';
const XML_STATUS_COMPLETED = 1;
const XML_STATUS_ACTIVE = 1;
const COMPLETED_PROGRESS = 1;
const QUEUED_PROGRESS = 0;
const ARRAY_REGEX = /<value>([\s\S]*?)<\/value>/g;
const STRING_REGEX = /<string>([\s\S]*?)<\/string>/;
const INTEGER_REGEX = /<(?:i4|int)>(-?\d+)<\/(?:i4|int)>/;
const BOOLEAN_REGEX = /<boolean>([01])<\/boolean>/;

/**
 * rTorrent XML-RPC adapter.
 */
class RTorrentClient extends BaseTorrentClient {
  /**
   * Authenticate with rTorrent.
   * @returns {Promise<void>}
   */
  async authenticate() {
    await this.call('system.client_version', []);
    this.authenticated = true;
  }

  /**
   * Add a magnet link or URL to rTorrent.
   * @param {string} magnet - Magnet link or URL.
   * @param {string} savePath - Directory to save the download.
   * @returns {Promise<{ hash: string, name: string }>}
   */
  async addMagnet(magnet, savePath) {
    return this.withAuthRetry(async () => {
      await this.call('load.start_verbose', ['', magnet, `d.directory.set=${savePath}`]);
      const torrent = await this.getRecentlyAdded();
      return {
        hash: torrent ? torrent.hash : this.extractInfoHash(magnet),
        name: torrent ? torrent.name : this.extractMagnetName(magnet)
      };
    });
  }

  /**
   * Get an rTorrent torrent by hash.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async getTorrent(hash) {
    return this.withAuthRetry(() => this.fetchTorrent(hash));
  }

  /**
   * Get the most recently listed rTorrent torrent.
   * @returns {Promise<Object|null>}
   */
  async getRecentlyAdded() {
    return this.withAuthRetry(async () => {
      const hashes = await this.call('download_list', []);
      if (!Array.isArray(hashes) || hashes.length === 0) {
        return null;
      }

      return this.fetchTorrent(hashes[hashes.length - 1]);
    });
  }

  /**
   * Fetch and normalize a torrent without retrying authentication.
   * @param {string} hash - Torrent hash.
   * @returns {Promise<Object|null>}
   */
  async fetchTorrent(hash) {
    try {
      const name = await this.call('d.name', [hash]);
      const complete = Number(await this.call('d.complete', [hash]));
      const active = Number(await this.call('d.is_active', [hash]));
      const size = Number(await this.call('d.size_bytes', [hash]));
      const speed = Number(await this.call('d.down.rate', [hash]));
      const savePath = await this.call('d.directory', [hash]);

      return this.normalizeTorrent({
        hash,
        name,
        complete,
        active,
        size,
        speed,
        savePath
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * Call an rTorrent XML-RPC method.
   * @param {string} method - XML-RPC method.
   * @param {Array<*>} params - XML-RPC params.
   * @returns {Promise<*>}
   */
  async call(method, params) {
    const response = await axios.post(this.config.torrentClientUrl, this.buildXmlRequest(method, params), {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': XML_CONTENT_TYPE
      },
      auth: this.config.torrentClientUser || this.config.torrentClientPass ? {
        username: this.config.torrentClientUser,
        password: this.config.torrentClientPass
      } : undefined
    });

    if (String(response.data).includes('<fault>')) {
      throw new Error('rTorrent could not complete the request.');
    }

    return this.parseXmlValue(String(response.data));
  }

  /**
   * Build an XML-RPC request body.
   * @param {string} method - XML-RPC method.
   * @param {Array<*>} params - XML-RPC params.
   * @returns {string}
   */
  buildXmlRequest(method, params) {
    const paramXml = params.map((param) => `<param>${this.buildXmlValue(param)}</param>`).join('');
    return `<?xml version="1.0"?><methodCall><methodName>${this.escapeXml(method)}</methodName><params>${paramXml}</params></methodCall>`;
  }

  /**
   * Build an XML-RPC value node.
   * @param {*} value - Value to serialize.
   * @returns {string}
   */
  buildXmlValue(value) {
    if (Number.isInteger(value)) {
      return `<value><int>${value}</int></value>`;
    }

    return `<value><string>${this.escapeXml(String(value))}</string></value>`;
  }

  /**
   * Parse the first XML-RPC response value.
   * @param {string} xml - XML-RPC response XML.
   * @returns {*}
   */
  parseXmlValue(xml) {
    if (xml.includes('<array>')) {
      const values = [];
      let match = ARRAY_REGEX.exec(xml);
      while (match) {
        values.push(this.parseScalarValue(match[1]));
        match = ARRAY_REGEX.exec(xml);
      }
      ARRAY_REGEX.lastIndex = 0;
      return values;
    }

    return this.parseScalarValue(xml);
  }

  /**
   * Parse a scalar XML-RPC value.
   * @param {string} xml - XML containing a value node.
   * @returns {string|number|boolean}
   */
  parseScalarValue(xml) {
    const stringMatch = STRING_REGEX.exec(xml);
    if (stringMatch) {
      return this.unescapeXml(stringMatch[1]);
    }

    const integerMatch = INTEGER_REGEX.exec(xml);
    if (integerMatch) {
      return Number(integerMatch[1]);
    }

    const booleanMatch = BOOLEAN_REGEX.exec(xml);
    if (booleanMatch) {
      return booleanMatch[1] === '1';
    }

    return '';
  }

  /**
   * Escape XML entities.
   * @param {string} value - Raw value.
   * @returns {string}
   */
  escapeXml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Unescape XML entities.
   * @param {string} value - Escaped value.
   * @returns {string}
   */
  unescapeXml(value) {
    return value
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  }

  /**
   * Convert rTorrent values into the Turnstile shape.
   * @param {Object} torrent - rTorrent values.
   * @returns {Object}
   */
  normalizeTorrent(torrent) {
    let status = 'queued';
    if (torrent.complete === XML_STATUS_COMPLETED) {
      status = 'completed';
    } else if (torrent.active === XML_STATUS_ACTIVE) {
      status = 'downloading';
    }

    return {
      hash: torrent.hash,
      name: torrent.name || 'Unnamed torrent',
      status,
      progress: status === 'completed' ? COMPLETED_PROGRESS : QUEUED_PROGRESS,
      size: torrent.size || 0,
      downloadSpeed: torrent.speed || 0,
      eta: UNKNOWN_ETA_SECONDS,
      savePath: torrent.savePath || this.config.downloadsPath
    };
  }
}

module.exports = RTorrentClient;
