// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

/**
 * Send a successful API response envelope.
 * @param {import('express').Response} res - Express response.
 * @param {string} detail - User-friendly response detail.
 * @param {*} data - Response payload.
 * @returns {import('express').Response}
 */
function sendSuccess(res, detail, data) {
  return res.status(HTTP_OK).json({
    success: true,
    detail,
    data
  });
}

/**
 * Send a failure API response envelope.
 * @param {import('express').Response} res - Express response.
 * @param {number} status - HTTP status code.
 * @param {string} detail - User-friendly response detail.
 * @returns {import('express').Response}
 */
function sendError(res, status, detail) {
  return res.status(status).json({
    success: false,
    detail,
    data: null
  });
}

/**
 * Wrap an async Express handler and convert unexpected errors into a 500 envelope.
 * @param {Function} handler - Async Express route handler.
 * @returns {Function}
 */
function asyncHandler(handler) {
  return async function wrappedAsyncHandler(req, res, next) {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  HTTP_BAD_REQUEST,
  HTTP_UNAUTHORIZED,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_SERVER_ERROR,
  sendSuccess,
  sendError,
  asyncHandler
};
