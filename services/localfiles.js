// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const fs = require('fs');
const path = require('path');

const CASE_INSENSITIVE_LOCALE = 'en';
const SINGLE_FILE_COUNT = 1;

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
  const searchTerm = normalizeForSearch(query);
  if (!searchTerm || !fs.existsSync(downloadsPath)) {
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
    const entryName = normalizeForSearch(entry.name);
    if (!entryName.includes(searchTerm)) {
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
      archive: downloadTarget.type === 'archive'
    });
  });

  return matches;
}

module.exports = {
  getDownloadTarget,
  isPathInside,
  listDownloadFiles,
  matchesLocal,
  toGlobalRelativePath
};
