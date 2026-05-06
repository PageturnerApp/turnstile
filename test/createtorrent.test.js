// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const configStore = require('../config');
const createTorrentRoute = require('../routes/createtorrent');

test('getCacheSearchTerms skips generic Prowlarr download path names', () => {
  const config = configStore.getConfig();
  const terms = createTorrentRoute._private.getCacheSearchTerms({}, `${config.prowlarrUrl}/1/download?apikey=example`);
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

test('isConfidentTorrentMatch accepts equivalent release names from the torrent client', () => {
  const previousRecentTorrent = {
    hash: 'old-hash',
    name: 'Older release'
  };
  const torrent = {
    hash: 'new-hash',
    name: 'Matt Dinniman - [Dungeon Crawler Carl Audio Immersion Tunnel - 1] - Dungeon Crawler Carl - Audio Immersion Tunnel Season 1 (Jeff Hays).m4b'
  };
  const terms = ['Dungeon Crawler Carl: Audio Immersion Tunnel Season 1 by Matt Dinniman [ENG / M4B]'];

  assert.equal(createTorrentRoute._private.isConfidentTorrentMatch(torrent, terms, previousRecentTorrent, false), true);
});

test('buildAddedTorrentFallback rejects unchanged recent hashes', () => {
  const previousRecentTorrent = {
    hash: 'same-hash',
    name: 'Older release'
  };
  const added = {
    hash: 'same-hash',
    name: 'Dungeon Crawler Carl: Audio Immersion Tunnel Season 1 by Matt Dinniman [ENG / M4B]'
  };
  const terms = ['Dungeon Crawler Carl: Audio Immersion Tunnel Season 1 by Matt Dinniman [ENG / M4B]'];

  assert.equal(createTorrentRoute._private.buildAddedTorrentFallback(added, terms, previousRecentTorrent, false), null);
});

test('isConfidentTorrentMatch can trust a fresh authoritative hash even when the torrent name is shortened', () => {
  const previousRecentTorrent = {
    hash: 'old-hash',
    name: 'Older release'
  };
  const torrent = {
    hash: 'new-hash',
    name: '03 Children of Memory'
  };
  const terms = ['Children of Memory by Adrian Tchaikovsky [ENG / M4B]'];

  assert.equal(createTorrentRoute._private.isConfidentTorrentMatch(torrent, terms, previousRecentTorrent, true), true);
});
