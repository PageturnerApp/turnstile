// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const axios = require('axios');
const packageInfo = require('../package.json');
const log = require('../utils/logger');

const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/PageturnerApp/turnstile/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/PageturnerApp/turnstile/releases';
const DOCKER_IMAGE = 'ghcr.io/pageturnerapp/turnstile';
const USER_AGENT = `Turnstile/${packageInfo.version}`;
const VERSION_PREFIX_PATTERN = /^v/i;
const VERSION_SUFFIX_SEPARATOR = '-';
const VERSION_PART_SEPARATOR = '.';
const VERSION_PART_COUNT = 3;
const REQUEST_TIMEOUT_MS = 5000;
const HTTP_NOT_FOUND = 404;
const CACHE_TTL_MINUTES = 30;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const ZERO = 0;

let cachedStatus = null;
let cachedAtMs = ZERO;

/**
 * Strip common release prefixes and suffixes from a version string.
 * @param {string} value - Raw release tag or package version.
 * @returns {string}
 */
function cleanVersion(value) {
  return String(value || '')
    .trim()
    .replace(VERSION_PREFIX_PATTERN, '')
    .split(VERSION_SUFFIX_SEPARATOR)[ZERO];
}

/**
 * Convert a version string to numeric major/minor/patch parts.
 * @param {string} value - Version string.
 * @returns {Array<number>}
 */
function versionParts(value) {
  const parts = cleanVersion(value)
    .split(VERSION_PART_SEPARATOR)
    .map((part) => Number.parseInt(part, 10));

  while (parts.length < VERSION_PART_COUNT) {
    parts.push(ZERO);
  }

  return parts.slice(ZERO, VERSION_PART_COUNT).map((part) => Number.isInteger(part) ? part : ZERO);
}

/**
 * Compare two semantic-ish versions.
 * @param {string} left - First version.
 * @param {string} right - Second version.
 * @returns {number}
 */
function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);

  for (let index = ZERO; index < VERSION_PART_COUNT; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }

    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return ZERO;
}

/**
 * Build update commands for supported installation styles.
 * @param {string} latestTag - Latest release tag.
 * @returns {Object}
 */
function buildUpdateCommands(latestTag) {
  return {
    bare_node: [
      'cd ~/turnstile',
      'git fetch --tags',
      `git checkout ${latestTag}`,
      'npm install --omit=dev',
      'systemctl --user restart turnstile.service'
    ],
    docker: [
      'docker compose pull',
      'docker compose up -d'
    ]
  };
}

/**
 * Build the default update status used before or after a failed check.
 * @param {boolean} checked - Whether GitHub was checked successfully.
 * @returns {Object}
 */
function buildBaseStatus(checked) {
  return {
    checked,
    current_version: packageInfo.version,
    latest_version: null,
    latest_tag: null,
    update_available: false,
    release_url: GITHUB_RELEASES_URL,
    published_at: null,
    docker_image: `${DOCKER_IMAGE}:latest`,
    commands: buildUpdateCommands(`v${packageInfo.version}`)
  };
}

/**
 * Build the update status used before the first GitHub Release exists.
 * @returns {Object}
 */
function buildNoReleaseStatus() {
  return {
    checked: true,
    current_version: packageInfo.version,
    latest_version: packageInfo.version,
    latest_tag: `v${packageInfo.version}`,
    update_available: false,
    release_url: GITHUB_RELEASES_URL,
    published_at: null,
    docker_image: `${DOCKER_IMAGE}:latest`,
    commands: buildUpdateCommands(`v${packageInfo.version}`)
  };
}

/**
 * Determine whether the cached status can still be returned.
 * @returns {boolean}
 */
function hasFreshCache() {
  return Boolean(cachedStatus && Date.now() - cachedAtMs < CACHE_TTL_MS);
}

/**
 * Fetch the latest GitHub release metadata.
 * @returns {Promise<Object>}
 */
async function fetchLatestRelease() {
  const response = await axios.get(GITHUB_LATEST_RELEASE_URL, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT
    }
  });

  return response.data || {};
}

/**
 * Convert GitHub release metadata into the UI update status shape.
 * @param {Object} release - GitHub release payload.
 * @returns {Object}
 */
function normalizeReleaseStatus(release) {
  const latestTag = String(release.tag_name || '').trim();
  const latestVersion = cleanVersion(latestTag);
  const releaseUrl = release.html_url || `${GITHUB_RELEASES_URL}/tag/${latestTag}`;

  return {
    checked: true,
    current_version: packageInfo.version,
    latest_version: latestVersion || null,
    latest_tag: latestTag || null,
    update_available: latestVersion ? compareVersions(latestVersion, packageInfo.version) > ZERO : false,
    release_url: releaseUrl,
    published_at: release.published_at || null,
    docker_image: latestTag ? `${DOCKER_IMAGE}:${latestTag}` : `${DOCKER_IMAGE}:latest`,
    commands: buildUpdateCommands(latestTag || `v${packageInfo.version}`)
  };
}

/**
 * Check GitHub Releases for the latest Turnstile version.
 * @returns {Promise<Object>}
 */
async function checkForUpdates() {
  if (hasFreshCache()) {
    return cachedStatus;
  }

  try {
    cachedStatus = normalizeReleaseStatus(await fetchLatestRelease());
  } catch (error) {
    if (error.response && error.response.status === HTTP_NOT_FOUND) {
      cachedStatus = buildNoReleaseStatus();
    } else {
      log.warn(`Update check could not reach GitHub Releases: ${error.message}`);
      cachedStatus = buildBaseStatus(false);
    }
  }

  cachedAtMs = Date.now();
  return cachedStatus;
}

module.exports = {
  checkForUpdates,
  compareVersions
};
