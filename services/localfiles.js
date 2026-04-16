// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const fs = require('fs');
const path = require('path');

const CASE_INSENSITIVE_LOCALE = 'en';

/**
 * Convert a search value into a case-insensitive match token.
 * @param {string} value - Raw search value.
 * @returns {string}
 */
function normalizeForSearch(value) {
  return String(value || '').trim().toLocaleLowerCase(CASE_INSENSITIVE_LOCALE);
}

/**
 * Test whether a candidate path is inside a root directory.
 * @param {string} candidatePath - Candidate absolute or relative path.
 * @param {string} rootPath - Root path.
 * @returns {boolean}
 */
function isPathInside(candidatePath, rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const lexicalRelative = path.relative(resolvedRoot, resolvedCandidate);

  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    return false;
  }

  if (!fs.existsSync(resolvedCandidate)) {
    return true;
  }

  const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
  const realCandidate = fs.realpathSync(resolvedCandidate);
  const realRelative = path.relative(realRoot, realCandidate);

  return !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
}

/**
 * Find the largest regular file within a file or directory path.
 * @param {string} targetPath - File or directory to inspect.
 * @returns {{ path: string, size: number }|null}
 */
function findLargestFile(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  const lstat = fs.lstatSync(targetPath);
  if (lstat.isSymbolicLink()) {
    const stat = fs.statSync(targetPath);
    return stat.isFile()
      ? {
        path: targetPath,
        size: stat.size
      }
      : null;
  }

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return {
      path: targetPath,
      size: stat.size
    };
  }

  if (!stat.isDirectory()) {
    return null;
  }

  let largest = null;
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });

  entries.forEach((entry) => {
    const entryPath = path.join(targetPath, entry.name);
    let candidate = null;

    try {
      candidate = findLargestFile(entryPath);
    } catch (error) {
      candidate = null;
    }

    if (candidate && (!largest || candidate.size > largest.size)) {
      largest = candidate;
    }
  });

  return largest;
}

/**
 * Return a relative file path from the global downloads root.
 * @param {string} filePath - Absolute file path.
 * @param {string} globalDownloadsPath - Global downloads root.
 * @returns {string}
 */
function toGlobalRelativePath(filePath, globalDownloadsPath) {
  return path.relative(path.resolve(globalDownloadsPath), path.resolve(filePath));
}

/**
 * Fuzzy-match already downloaded files or directories by top-level entry name.
 * @param {string} query - Search query.
 * @param {string} downloadsPath - API-key-specific downloads path.
 * @param {string} globalDownloadsPath - Global downloads root.
 * @returns {Array<{ name: string, path: string, relativePath: string, size: number }>}
 */
function matchesLocal(query, downloadsPath, globalDownloadsPath) {
  const searchTerm = normalizeForSearch(query);
  if (!searchTerm || !fs.existsSync(downloadsPath)) {
    return [];
  }

  const root = path.resolve(downloadsPath);
  const globalRoot = path.resolve(globalDownloadsPath);

  if (!isPathInside(root, globalRoot)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const matches = [];

  entries.forEach((entry) => {
    const entryName = normalizeForSearch(entry.name);
    if (!entryName.includes(searchTerm)) {
      return;
    }

    const entryPath = path.join(root, entry.name);
    const largestFile = findLargestFile(entryPath);
    if (!largestFile || !isPathInside(largestFile.path, globalRoot)) {
      return;
    }

    matches.push({
      name: entry.name,
      path: largestFile.path,
      relativePath: toGlobalRelativePath(largestFile.path, globalRoot),
      size: largestFile.size
    });
  });

  return matches;
}

module.exports = {
  findLargestFile,
  isPathInside,
  matchesLocal,
  toGlobalRelativePath
};
