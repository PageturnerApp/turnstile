// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prowlarr = require('../services/prowlarr');

test('normalizeSearchResults prefers magnet links for downstream adds', () => {
  const normalized = prowlarr._private.normalizeSearchResults([{
    title: 'Project Hail Mary',
    magnetUrl: 'magnet:?xt=urn:btih:abcdef&dn=Project%20Hail%20Mary',
    downloadUrl: 'http://localhost:9696/api/v1/indexer/42/download?apikey=example'
  }]);

  assert.equal(normalized[0].downloadUrl, 'magnet:?xt=urn:btih:abcdef&dn=Project%20Hail%20Mary');
  assert.equal(normalized[0].id, 'magnet:?xt=urn:btih:abcdef&dn=Project%20Hail%20Mary');
});
