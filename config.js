// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const DEFAULT_PORT = 7878;
const KEY_PREVIEW_LENGTH = 4;
const MASK_MINIMUM_LENGTH = 8;
const HEX_RADIX = 16;
const SESSION_SECRET_BYTES = 32;
const MAX_API_KEY_PARSE_DEPTH = 2;
const ENV_PATH = path.join(process.cwd(), '.env');
const ENV_DOLLAR_PATTERN = /\$/;
const ENV_QUOTED_VALUE_PATTERN = /[\s#"'\\]/;
const ROOT_PATH = '/';
const SUPPORTED_TORRENT_CLIENTS = ['qbittorrent', 'deluge', 'transmission', 'rtorrent'];
const DEFAULTS = {
  PROWLARR_URL: 'http://localhost:9696',
  PROWLARR_API_KEY: '',
  TORRENT_CLIENT: 'qbittorrent',
  TORRENT_CLIENT_URL: 'http://localhost:8080',
  TORRENT_CLIENT_USER: 'admin',
  TORRENT_CLIENT_PASS: 'adminpass',
  DOWNLOADS_PATH: '/home/user/downloads',
  BRIDGE_URL: 'http://your-seedbox-ip:7878',
  PORT: String(DEFAULT_PORT),
  API_KEYS: '[]',
  UI_PASSWORD_HASH: '',
  SESSION_SECRET: ''
};

let currentConfig = loadConfig();

/**
 * Parse an integer from an environment value with a fallback.
 * @param {string|undefined} value - Raw environment value.
 * @param {number} fallback - Fallback number.
 * @returns {number}
 */
function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read the .env file and merge it with runtime process environment values.
 * @returns {Object<string, string>}
 */
function readRawEnv() {
  const fileEnv = fs.existsSync(ENV_PATH)
    ? dotenv.parse(fs.readFileSync(ENV_PATH))
    : {};

  return Object.assign({}, DEFAULTS, process.env, fileEnv);
}

/**
 * Try to parse an API key JSON value.
 * @param {string} value - Raw JSON value.
 * @param {number} depth - Current recursion depth.
 * @returns {Array<Object>}
 */
function tryParseApiKeys(value, depth) {
  if (depth > MAX_API_KEY_PARSE_DEPTH) {
    return [];
  }

  try {
    const parsed = JSON.parse(value || DEFAULTS.API_KEYS);
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (typeof parsed === 'string') {
      return tryParseApiKeys(parsed, depth + 1);
    }
  } catch (error) {
    return [];
  }

  return [];
}

/**
 * Safely parse the JSON API key array from the environment.
 * @param {string} rawValue - Raw JSON value.
 * @returns {Array<Object>}
 */
function parseApiKeys(rawValue) {
  const value = String(rawValue || DEFAULTS.API_KEYS);
  const parsed = tryParseApiKeys(value, 0);
  if (parsed.length || value === DEFAULTS.API_KEYS) {
    return parsed;
  }

  return tryParseApiKeys(value.replace(/\\"/g, '"'), 0);
}

/**
 * Normalise a URL-like value by trimming whitespace and trailing slashes.
 * @param {string} value - URL value.
 * @returns {string}
 */
function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * Load the current Turnstile configuration from .env and process.env.
 * @returns {Object}
 */
function loadConfig() {
  const env = readRawEnv();
  const torrentClient = String(env.TORRENT_CLIENT || DEFAULTS.TORRENT_CLIENT).toLowerCase();

  return {
    prowlarrUrl: normalizeUrl(env.PROWLARR_URL),
    prowlarrApiKey: env.PROWLARR_API_KEY || '',
    torrentClient: torrentClient,
    torrentClientUrl: normalizeUrl(env.TORRENT_CLIENT_URL),
    torrentClientUser: env.TORRENT_CLIENT_USER || '',
    torrentClientPass: env.TORRENT_CLIENT_PASS || '',
    downloadsPath: env.DOWNLOADS_PATH || DEFAULTS.DOWNLOADS_PATH,
    bridgeUrl: normalizeUrl(env.BRIDGE_URL),
    port: parsePort(env.PORT, DEFAULT_PORT),
    apiKeys: parseApiKeys(env.API_KEYS),
    uiPasswordHash: env.UI_PASSWORD_HASH || '',
    sessionSecret: env.SESSION_SECRET || ''
  };
}

/**
 * Get the in-memory configuration.
 * @returns {Object}
 */
function getConfig() {
  return currentConfig;
}

/**
 * Reload configuration from disk.
 * @returns {Object}
 */
function reloadConfig() {
  currentConfig = loadConfig();
  return currentConfig;
}

/**
 * Generate a session signing secret.
 * @returns {string}
 */
function generateSessionSecret() {
  return crypto.randomBytes(SESSION_SECRET_BYTES).toString('hex');
}

/**
 * Return the current Express session secret.
 * @returns {string}
 */
function getSessionSecret() {
  if (!currentConfig.sessionSecret) {
    writeConfig(Object.assign({}, currentConfig, {
      sessionSecret: generateSessionSecret()
    }));
  }

  return currentConfig.sessionSecret;
}

/**
 * Escape a value for safe storage in a .env file.
 * @param {string} value - Raw value.
 * @returns {string}
 */
function formatEnvValue(value) {
  const stringValue = String(value || '');

  if (ENV_DOLLAR_PATTERN.test(stringValue)) {
    return `'${stringValue}'`;
  }

  if (ENV_QUOTED_VALUE_PATTERN.test(stringValue)) {
    return JSON.stringify(stringValue);
  }

  return stringValue;
}

/**
 * Convert a config object into a complete commented .env document.
 * @param {Object} config - Turnstile config.
 * @returns {string}
 */
function buildEnvDocument(config) {
  const apiKeys = JSON.stringify(config.apiKeys || []);

  return [
    '# Turnstile - Self-hosted download provider bridge',
    '# Part of the Pageturner project: https://github.com/pageturner-app/turnstile',
    '# Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html',
    '',
    '# Prowlarr',
    `PROWLARR_URL=${formatEnvValue(config.prowlarrUrl)}`,
    `PROWLARR_API_KEY=${formatEnvValue(config.prowlarrApiKey)}`,
    '',
    '# Torrent Client',
    '# Accepted values: qbittorrent, deluge, transmission, rtorrent',
    `TORRENT_CLIENT=${formatEnvValue(config.torrentClient)}`,
    `TORRENT_CLIENT_URL=${formatEnvValue(config.torrentClientUrl)}`,
    `TORRENT_CLIENT_USER=${formatEnvValue(config.torrentClientUser)}`,
    `TORRENT_CLIENT_PASS=${formatEnvValue(config.torrentClientPass)}`,
    '',
    '# Turnstile',
    `DOWNLOADS_PATH=${formatEnvValue(config.downloadsPath)}`,
    `BRIDGE_URL=${formatEnvValue(config.bridgeUrl)}`,
    `PORT=${formatEnvValue(config.port)}`,
    '',
    '# Auto-generated - do not edit manually',
    `API_KEYS=${formatEnvValue(apiKeys)}`,
    `UI_PASSWORD_HASH=${formatEnvValue(config.uiPasswordHash)}`,
    `SESSION_SECRET=${formatEnvValue(config.sessionSecret)}`,
    ''
  ].join('\n');
}

/**
 * Persist the current configuration to .env.
 * @param {Object} config - Turnstile config.
 * @returns {void}
 */
function writeConfig(config) {
  fs.writeFileSync(ENV_PATH, buildEnvDocument(config));
  currentConfig = loadConfig();
}

/**
 * Validate and normalise a torrent client value.
 * @param {string} client - Client type.
 * @returns {string}
 */
function normalizeTorrentClient(client) {
  const normalized = String(client || '').toLowerCase();
  if (!SUPPORTED_TORRENT_CLIENTS.includes(normalized)) {
    throw new Error('Please choose a supported torrent client.');
  }

  return normalized;
}

/**
 * Update user-editable configuration fields and persist them.
 * @param {Object} updates - Config updates from the UI.
 * @returns {Object}
 */
function updateConfig(updates) {
  const nextConfig = Object.assign({}, currentConfig);

  if (Object.prototype.hasOwnProperty.call(updates, 'prowlarrUrl')) {
    nextConfig.prowlarrUrl = normalizeUrl(updates.prowlarrUrl);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'prowlarrApiKey')) {
    nextConfig.prowlarrApiKey = String(updates.prowlarrApiKey || '');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'torrentClient')) {
    nextConfig.torrentClient = normalizeTorrentClient(updates.torrentClient);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'torrentClientUrl')) {
    nextConfig.torrentClientUrl = normalizeUrl(updates.torrentClientUrl);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'torrentClientUser')) {
    nextConfig.torrentClientUser = String(updates.torrentClientUser || '');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'torrentClientPass')) {
    nextConfig.torrentClientPass = String(updates.torrentClientPass || '');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'downloadsPath')) {
    nextConfig.downloadsPath = String(updates.downloadsPath || DEFAULTS.DOWNLOADS_PATH);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'bridgeUrl')) {
    nextConfig.bridgeUrl = normalizeUrl(updates.bridgeUrl);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'port')) {
    nextConfig.port = parsePort(updates.port, currentConfig.port);
  }

  writeConfig(nextConfig);
  return currentConfig;
}

/**
 * Persist a new UI password hash.
 * @param {string} hash - Bcrypt password hash.
 * @returns {Object}
 */
function setUiPasswordHash(hash) {
  const nextConfig = Object.assign({}, currentConfig, {
    uiPasswordHash: hash
  });

  writeConfig(nextConfig);
  return currentConfig;
}

/**
 * Persist the full API key list.
 * @param {Array<Object>} apiKeys - API key records.
 * @returns {Object}
 */
function setApiKeys(apiKeys) {
  const nextConfig = Object.assign({}, currentConfig, {
    apiKeys
  });

  writeConfig(nextConfig);
  return currentConfig;
}

/**
 * Mask a sensitive value while preserving the final characters.
 * @param {string} value - Sensitive value.
 * @returns {string}
 */
function maskValue(value) {
  const stringValue = String(value || '');
  if (!stringValue) {
    return '';
  }

  const suffix = stringValue.slice(-KEY_PREVIEW_LENGTH);
  const maskLength = Math.max(MASK_MINIMUM_LENGTH, stringValue.length - KEY_PREVIEW_LENGTH);
  return `${'*'.repeat(maskLength)}${suffix}`;
}

/**
 * Return config safe for display in the UI.
 * @returns {Object}
 */
function getMaskedConfig() {
  return {
    prowlarrUrl: currentConfig.prowlarrUrl,
    prowlarrApiKey: maskValue(currentConfig.prowlarrApiKey),
    torrentClient: currentConfig.torrentClient,
    torrentClientUrl: currentConfig.torrentClientUrl,
    torrentClientUser: currentConfig.torrentClientUser,
    torrentClientPass: maskValue(currentConfig.torrentClientPass),
    downloadsPath: currentConfig.downloadsPath,
    bridgeUrl: currentConfig.bridgeUrl,
    port: currentConfig.port,
    apiKeyCount: currentConfig.apiKeys.length,
    uiPasswordHash: currentConfig.uiPasswordHash ? maskValue(currentConfig.uiPasswordHash) : ''
  };
}

/**
 * Return the URL path prefix from the public bridge URL.
 * @returns {string}
 */
function getBridgeBasePath() {
  try {
    const pathname = new URL(currentConfig.bridgeUrl).pathname.replace(/\/+$/, '');
    return pathname === ROOT_PATH ? '' : pathname;
  } catch (error) {
    return '';
  }
}

/**
 * Return the HTML base href for browser-resolved UI paths.
 * @returns {string}
 */
function getBaseHref() {
  const basePath = getBridgeBasePath();
  return `${basePath}${ROOT_PATH}`;
}

/**
 * Generate a stable random value suitable for keys.
 * @returns {string}
 */
function generateSecret() {
  return crypto.randomUUID();
}

module.exports = {
  DEFAULT_PORT,
  HEX_RADIX,
  KEY_PREVIEW_LENGTH,
  SUPPORTED_TORRENT_CLIENTS,
  getConfig,
  reloadConfig,
  getSessionSecret,
  updateConfig,
  setUiPasswordHash,
  setApiKeys,
  getMaskedConfig,
  getBridgeBasePath,
  getBaseHref,
  maskValue,
  generateSecret
};
