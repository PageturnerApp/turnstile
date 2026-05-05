// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createTorrentRoute = require('../routes/createtorrent');

test('getCacheSearchTerms skips generic Prowlarr download path names', () => {
  const terms = createTorrentRoute._private.getCacheSearchTerms({}, 'http://localhost:9696/api/v1/indexer/42/download?apikey=example');
  assert.deepEqual(terms, []);
});

test('getCacheSearchTerms keeps direct URL filenames', () => {
  const terms = createTorrentRoute._private.getCacheSearchTerms({}, 'https://example.com/files/Project.Hail.Mary.torrent');
  assert.equal(terms.includes('Project.Hail.Mary.torrent'), true);
});

test('isDifferentRecentTorrent only accepts a new hash', () => {
  const previousRecentTorrent = {
    hash: 'abc123',
    name: 'Project Hail Mary'
  };
  const sameRecentTorrent = {
    hash: 'abc123',
    name: 'Project Hail Mary'
  };
  const newRecentTorrent = {
    hash: 'def456',
    name: 'Project Hail Mary'
  };

  assert.equal(createTorrentRoute._private.isDifferentRecentTorrent(sameRecentTorrent, previousRecentTorrent), false);
  assert.equal(createTorrentRoute._private.isDifferentRecentTorrent(newRecentTorrent, previousRecentTorrent), true);
});
