// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const log = {
  /**
   * Write an informational log message.
   * @param {string} msg - Message to log.
   * @returns {void}
   */
  info: (msg) => console.log(`[${new Date().toISOString()}] INFO  ${msg}`),

  /**
   * Write a warning log message.
   * @param {string} msg - Message to log.
   * @returns {void}
   */
  warn: (msg) => console.warn(`[${new Date().toISOString()}] WARN  ${msg}`),

  /**
   * Write an error log message.
   * @param {string} msg - Message to log.
   * @returns {void}
   */
  error: (msg) => console.error(`[${new Date().toISOString()}] ERROR ${msg}`),

  /**
   * Write a startup banner without adding log metadata.
   * @param {string} msg - Banner text.
   * @returns {void}
   */
  banner: (msg) => process.stdout.write(`${msg}\n`)
};

module.exports = log;
