// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const fs = require('fs');
const path = require('path');

const CASE_INSENSITIVE_LOCALE = 'en';
const SINGLE_FILE_COUNT = 1;
const EMPTY_MATCH_SCORE = 0;
const EXACT_MATCH_SCORE = 100;
const SUBSTRING_MATCH_SCORE = 90;
const TOKEN_MATCH_BASE_SCORE = 70;
const TOKEN_MATCH_MAX_BONUS = 20;
const MINIMUM_QUERY_LENGTH_FOR_SUBSTRING = 4;
const MINIMUM_TOKEN_MATCH_COUNT = 2;
const MINIMUM_TOKEN_COVERAGE = 0.65;
const BRACKETED_TEXT_PATTERN = /[\[(][^\])]*[\])]/g;
const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{2,5}$/i;
const WORD_SEPARATOR_PATTERN = /[^a-z0-9]+/g;
const MULTIPLE_SPACE_PATTERN = /\s+/g;
const MATCH_STOP_WORDS = [
  'a',
  'an',
  'and',
  'book',
  'by',
  'edition',
  'for',
  'from',
  'in',
  'of',
  'or',
  'the',
  'to',
  'with'
];
const MATCH_NOISE_WORDS = [
  'aac',
  'abridged',
  'audio',
  'audiobook',
  'azw3',
  'cbr',
  'cbz',
  'complete',
  'english',
  'eng',
  'epub',
  'flac',
  'm4a',
  'm4b',
  'mobi',
  'mp3',
  'pdf',
  'retail',
  'unabridged'
];
const IGNORED_MATCH_TOKENS = new Set(MATCH_STOP_WORDS.concat(MATCH_NOISE_WORDS));

/**
 * Convert a search value into a case-insensitive match token.
 * @param {string} value - Raw search value.
 * @returns {string}
 */
function normalizeForSearch(value) {
  return String(value || '').trim().toLocaleLowerCase(CASE_INSENSITIVE_LOCALE);
}

/**
 * Normalize a title or filename for local cache matching.
 * @param {string} value - Raw title or file value.
 * @returns {string}
 */
function normalizeForTitleMatch(value) {
  return normalizeForSearch(value)
    .replace(BRACKETED_TEXT_PATTERN, ' ')
    .replace(FILE_EXTENSION_PATTERN, ' ')
    .replace(WORD_SEPARATOR_PATTERN, ' ')
    .replace(MULTIPLE_SPACE_PATTERN, ' ')
    .trim();
}

/**
 * Return significant title tokens for local cache matching.
 * @param {string} value - Raw title or file value.
 * @returns {Array<string>}
 */
function getTitleTokens(value) {
  return normalizeForTitleMatch(value)
    .split(' ')
    .filter((token) => token && !IGNORED_MATCH_TOKENS.has(token));
}

/**
 * Count unique token intersections between two token lists.
 * @param {Array<string>} leftTokens - Left token list.
 * @param {Array<string>} rightTokens - Right token list.
 * @returns {number}
 */
function countTokenIntersection(leftTokens, rightTokens) {
  const rightTokenSet = new Set(rightTokens);
  return Array.from(new Set(leftTokens)).filter((token) => rightTokenSet.has(token)).length;
}

/**
 * Score how well a local entry name matches a user query or release title.
 * @param {string} query - Search query or selected release title.
 * @param {string} candidateName - Local file or folder name.
 * @returns {number}
 */
function scoreLocalNameMatch(query, candidateName) {
  const normalizedQuery = normalizeForTitleMatch(query);
  const normalizedCandidate = normalizeForTitleMatch(candidateName);

  if (!normalizedQuery || !normalizedCandidate) {
    return EMPTY_MATCH_SCORE;
  }

  if (normalizedQuery === normalizedCandidate) {
    return EXACT_MATCH_SCORE;
  }

  if (
    normalizedQuery.length >= MINIMUM_QUERY_LENGTH_FOR_SUBSTRING
    && normalizedCandidate.length >= MINIMUM_QUERY_LENGTH_FOR_SUBSTRING
    && (normalizedQuery.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedQuery))
  ) {
    return SUBSTRING_MATCH_SCORE;
  }

  const queryTokens = getTitleTokens(normalizedQuery);
  const candidateTokens = getTitleTokens(normalizedCandidate);
  const shortestTokenCount = Math.min(queryTokens.length, candidateTokens.length);

  if (shortestTokenCount === 0) {
    return EMPTY_MATCH_SCORE;
  }

  const matchingTokens = countTokenIntersection(queryTokens, candidateTokens);
  const coverage = matchingTokens / shortestTokenCount;
  const hasEnoughTokens = matchingTokens >= Math.min(MINIMUM_TOKEN_MATCH_COUNT, shortestTokenCount);

  if (!hasEnoughTokens || coverage < MINIMUM_TOKEN_COVERAGE) {
    return EMPTY_MATCH_SCORE;
  }

  return TOKEN_MATCH_BASE_SCORE + Math.round(coverage * TOKEN_MATCH_MAX_BONUS);
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

  try {
    const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
    const realCandidate = fs.realpathSync(resolvedCandidate);
    const realRelative = path.relative(realRoot, realCandidate);

    return !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
  } catch (error) {
    return false;
  }
}

/**
 * Safely read lstat metadata for a path.
 * @param {string} targetPath - Path to inspect.
 * @returns {fs.Stats|null}
 */
function safeLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    return null;
  }
}

/**
 * Safely read stat metadata for a path.
 * @param {string} targetPath - Path to inspect.
 * @returns {fs.Stats|null}
 */
function safeStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    return null;
  }
}

/**
 * Safely read directory entries.
 * @param {string} targetPath - Directory to inspect.
 * @returns {Array<fs.Dirent>}
 */
function safeReadDir(targetPath) {
  try {
    return fs.readdirSync(targetPath, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

/**
 * Add one file to a download file list when it stays inside the downloads root.
 * @param {Array<{ path: string, size: number, mtime: Date }>} files - Collected file list.
 * @param {string} filePath - Candidate file path.
 * @param {string} globalDownloadsPath - Global downloads root.
 * @returns {void}
 */
function addDownloadFile(files, filePath, globalDownloadsPath) {
  if (!isPathInside(filePath, globalDownloadsPath)) {
    return;
  }

  const stat = safeStat(filePath);
  if (!stat) {
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  files.push({
    path: filePath,
    size: stat.size,
    mtime: stat.mtime
  });
}

/**
 * Recursively collect regular files under a path without following directory symlinks.
 * @param {string} targetPath - File or directory to inspect.
 * @param {string} globalDownloadsPath - Global downloads root.
 * @param {Array<{ path: string, size: number, mtime: Date }>} files - Collected file list.
 * @returns {void}
 */
function collectDownloadFiles(targetPath, globalDownloadsPath, files) {
  if (!fs.existsSync(targetPath) || !isPathInside(targetPath, globalDownloadsPath)) {
    return;
  }

  const lstat = safeLstat(targetPath);
  if (!lstat) {
    return;
  }

  if (lstat.isSymbolicLink()) {
    addDownloadFile(files, targetPath, globalDownloadsPath);
    return;
  }

  const stat = safeStat(targetPath);
  if (!stat) {
    return;
  }

  if (stat.isFile()) {
    addDownloadFile(files, targetPath, globalDownloadsPath);
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  safeReadDir(targetPath)
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((entry) => {
      collectDownloadFiles(path.join(targetPath, entry.name), globalDownloadsPath, files);
    });
}

/**
 * Sum file sizes in bytes.
 * @param {Array<{ size: number }>} files - Download files.
 * @returns {number}
 */
function getTotalFileSize(files) {
  return files.reduce((total, file) => total + file.size, 0);
}

/**
 * List downloadable regular files beneath a file or directory.
 * @param {string} targetPath - File or directory to inspect.
 * @param {string} globalDownloadsPath - Global downloads root.
 * @returns {Array<{ path: string, size: number, mtime: Date }>}
 */
function listDownloadFiles(targetPath, globalDownloadsPath) {
  const files = [];
  collectDownloadFiles(path.resolve(targetPath), path.resolve(globalDownloadsPath), files);
  return files;
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
 * Resolve whether a download target should be served as one file or a zipped folder.
 * @param {string} targetPath - File or directory to inspect.
 * @param {string} globalDownloadsPath - Global downloads root.
 * @returns {{ type: string, path: string, relativePath: string, size: number, fileCount: number, files: Array<Object> }|null}
 */
function getDownloadTarget(targetPath, globalDownloadsPath) {
  const files = listDownloadFiles(targetPath, globalDownloadsPath);
  if (files.length === 0) {
    return null;
  }

  if (files.length === SINGLE_FILE_COUNT) {
    return {
      type: 'file',
      path: files[0].path,
      relativePath: toGlobalRelativePath(files[0].path, globalDownloadsPath),
      size: files[0].size,
      fileCount: files.length,
      files
    };
  }

  return {
    type: 'archive',
    path: path.resolve(targetPath),
    relativePath: toGlobalRelativePath(targetPath, globalDownloadsPath),
    size: getTotalFileSize(files),
    fileCount: files.length,
    files
  };
}

/**
 * Fuzzy-match already downloaded files or directories by top-level entry name.
 * @param {string} query - Search query.
 * @param {string} downloadsPath - API-key-specific downloads path.
 * @param {string} globalDownloadsPath - Global downloads root.
 * @returns {Array<{ name: string, path: string, relativePath: string, size: number, fileCount: number, archive: boolean }>}
 */
function matchesLocal(query, downloadsPath, globalDownloadsPath) {
  if (!normalizeForTitleMatch(query) || !fs.existsSync(downloadsPath)) {
    return [];
  }

  const root = path.resolve(downloadsPath);
  const globalRoot = path.resolve(globalDownloadsPath);

  if (!isPathInside(root, globalRoot)) {
    return [];
  }

  const entries = safeReadDir(root);
  const matches = [];

  entries.forEach((entry) => {
    const matchScore = scoreLocalNameMatch(query, entry.name);
    if (matchScore === EMPTY_MATCH_SCORE) {
      return;
    }

    const entryPath = path.join(root, entry.name);
    const downloadTarget = getDownloadTarget(entryPath, globalRoot);
    if (!downloadTarget) {
      return;
    }

    matches.push({
      name: entry.name,
      path: downloadTarget.path,
      relativePath: downloadTarget.relativePath,
      size: downloadTarget.size,
      fileCount: downloadTarget.fileCount,
      archive: downloadTarget.type === 'archive',
      matchScore
    });
  });

  return matches
    .sort((left, right) => right.matchScore - left.matchScore || left.name.localeCompare(right.name))
    .map((match) => {
      const output = Object.assign({}, match);
      delete output.matchScore;
      return output;
    });
}

module.exports = {
  getDownloadTarget,
  isPathInside,
  listDownloadFiles,
  matchesLocal,
  scoreLocalNameMatch,
  toGlobalRelativePath
};
