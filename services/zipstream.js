// Turnstile - Self-hosted download provider bridge
// Part of the Pageturner project: https://github.com/pageturner-app/turnstile
// Licensed under AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

'use strict';

const path = require('path');
const fs = require('fs');
const log = require('../utils/logger');

const ZIP_MIME_TYPE = 'application/zip';
const ZIP_EXTENSION = '.zip';
const ZIP_ENTRY_SEPARATOR = '/';
const UTF8_ENCODING = 'utf8';
const FALLBACK_ARCHIVE_NAME = 'download';
const EMPTY_BUFFER = Buffer.alloc(0);
const BYTE_MASK = 0xff;
const CRC_INITIAL_VALUE = 0xffffffff;
const CRC_POLYNOMIAL = 0xedb88320;
const BITS_PER_BYTE = 8;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_VERSION_STANDARD = 20;
const ZIP_VERSION_ZIP64 = 45;
const ZIP_GENERAL_PURPOSE_DATA_DESCRIPTOR = 0x0008;
const ZIP_GENERAL_PURPOSE_UTF8 = 0x0800;
const ZIP_GENERAL_PURPOSE_FLAGS = ZIP_GENERAL_PURPOSE_DATA_DESCRIPTOR | ZIP_GENERAL_PURPOSE_UTF8;
const ZIP_COMPRESSION_STORE = 0;
const ZIP_NO_DISK = 0;
const ZIP_TOTAL_DISKS = 1;
const ZIP_NO_COMMENT_LENGTH = 0;
const ZIP_NO_FILE_COMMENT_LENGTH = 0;
const ZIP_NO_INTERNAL_ATTRIBUTES = 0;
const ZIP_NO_EXTERNAL_ATTRIBUTES = 0;
const ZIP_LOCAL_FILE_HEADER_BYTES = 30;
const ZIP_DATA_DESCRIPTOR_STANDARD_BYTES = 16;
const ZIP_DATA_DESCRIPTOR_ZIP64_BYTES = 24;
const ZIP_CENTRAL_DIRECTORY_HEADER_BYTES = 46;
const ZIP64_END_OF_CENTRAL_DIRECTORY_BYTES = 56;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE_VALUE = 44n;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_BYTES = 20;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP64_SIZE_FIELD_BYTES = 8;
const ZIP64_EXTRA_FIELD_HEADER_BYTES = 4;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const BIG_UINT16_MAX = BigInt(UINT16_MAX);
const BIG_UINT32_MAX = BigInt(UINT32_MAX);
const DOS_EPOCH_YEAR = 1980;
const DOS_MONTH_OFFSET = 1;
const DOS_SECONDS_DIVISOR = 2;
const DOS_HOUR_SHIFT = 11;
const DOS_MINUTE_SHIFT = 5;
const DOS_YEAR_SHIFT = 9;
const DOS_MONTH_SHIFT = 5;
const ARCHIVE_SAFE_NAME_PATTERN = /[^a-zA-Z0-9._ -]/g;

const CRC_TABLE = buildCrcTable();

/**
 * Build the CRC-32 lookup table used by ZIP entries.
 * @returns {Uint32Array}
 */
function buildCrcTable() {
  const table = new Uint32Array(BYTE_MASK + 1);

  for (let value = 0; value <= BYTE_MASK; value += 1) {
    let crc = value;
    for (let bit = 0; bit < BITS_PER_BYTE; bit += 1) {
      crc = (crc & 1) ? (CRC_POLYNOMIAL ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[value] = crc >>> 0;
  }

  return table;
}

/**
 * Update a running CRC-32 value with a chunk.
 * @param {number} crc - Current CRC value.
 * @param {Buffer} chunk - File content chunk.
 * @returns {number}
 */
function updateCrc(crc, chunk) {
  let nextCrc = crc;
  for (let index = 0; index < chunk.length; index += 1) {
    nextCrc = CRC_TABLE[(nextCrc ^ chunk[index]) & BYTE_MASK] ^ (nextCrc >>> BITS_PER_BYTE);
  }

  return nextCrc >>> 0;
}

/**
 * Finalize a CRC-32 value.
 * @param {number} crc - Running CRC value.
 * @returns {number}
 */
function finalizeCrc(crc) {
  return (crc ^ CRC_INITIAL_VALUE) >>> 0;
}

/**
 * Write an unsigned 64-bit value into a buffer.
 * @param {Buffer} buffer - Target buffer.
 * @param {bigint|number} value - Value to write.
 * @param {number} offset - Buffer offset.
 * @returns {number}
 */
function writeUInt64(buffer, value, offset) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
  return offset + ZIP64_SIZE_FIELD_BYTES;
}

/**
 * Determine whether a value needs ZIP64 storage.
 * @param {bigint|number} value - Value to inspect.
 * @returns {boolean}
 */
function needsZip64(value) {
  return BigInt(value) > BIG_UINT32_MAX;
}

/**
 * Build DOS date and time fields for a ZIP header.
 * @param {Date} date - File modified date.
 * @returns {{ date: number, time: number }}
 */
function getDosDateTime(date) {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime())
    ? date
    : new Date();
  const year = Math.max(safeDate.getFullYear(), DOS_EPOCH_YEAR);
  const month = safeDate.getMonth() + DOS_MONTH_OFFSET;
  const day = safeDate.getDate();
  const hours = safeDate.getHours();
  const minutes = safeDate.getMinutes();
  const seconds = Math.floor(safeDate.getSeconds() / DOS_SECONDS_DIVISOR);

  return {
    time: (hours << DOS_HOUR_SHIFT) | (minutes << DOS_MINUTE_SHIFT) | seconds,
    date: ((year - DOS_EPOCH_YEAR) << DOS_YEAR_SHIFT) | (month << DOS_MONTH_SHIFT) | day
  };
}

/**
 * Build a ZIP64 extra field from ordered 64-bit values.
 * @param {Array<bigint|number>} values - Values to include.
 * @returns {Buffer}
 */
function buildZip64ExtraField(values) {
  if (values.length === 0) {
    return EMPTY_BUFFER;
  }

  const body = Buffer.alloc(values.length * ZIP64_SIZE_FIELD_BYTES);
  let offset = 0;
  values.forEach((value) => {
    offset = writeUInt64(body, value, offset);
  });

  const header = Buffer.alloc(ZIP64_EXTRA_FIELD_HEADER_BYTES);
  header.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
}

/**
 * Sanitize a display value for use as an archive filename.
 * @param {string} value - Proposed archive name.
 * @returns {string}
 */
function sanitizeArchiveBaseName(value) {
  const sanitized = path.basename(String(value || FALLBACK_ARCHIVE_NAME))
    .replace(ARCHIVE_SAFE_NAME_PATTERN, '')
    .trim();

  return sanitized || FALLBACK_ARCHIVE_NAME;
}

/**
 * Build the download filename for an archive.
 * @param {string} targetPath - Zipped file or folder path.
 * @returns {string}
 */
function getArchiveName(targetPath) {
  const baseName = sanitizeArchiveBaseName(path.basename(path.resolve(targetPath)));
  return baseName.toLowerCase().endsWith(ZIP_EXTENSION) ? baseName : `${baseName}${ZIP_EXTENSION}`;
}

/**
 * Convert a file path into a safe relative ZIP entry name.
 * @param {string} filePath - Absolute file path.
 * @param {string} sourceRoot - Absolute archive source root.
 * @returns {string}
 */
function getArchiveEntryName(filePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, filePath);
  const parts = relativePath.split(path.sep).filter((part) => part && part !== '.' && part !== '..');

  if (parts.length === 0) {
    return '';
  }

  return parts.join(ZIP_ENTRY_SEPARATOR);
}

/**
 * Build metadata for files that can be streamed into a ZIP.
 * @param {Array<{ path: string, size: number, mtime: Date }>} files - Files to include.
 * @param {string} sourceRoot - Absolute archive source root.
 * @returns {Array<Object>}
 */
function buildEntries(files, sourceRoot) {
  return files.map((file) => {
    const name = getArchiveEntryName(file.path, sourceRoot);
    return Object.assign({}, file, {
      name,
      nameBuffer: Buffer.from(name, UTF8_ENCODING),
      expectedSize: BigInt(file.size || 0)
    });
  }).filter((entry) => entry.name);
}

/**
 * Build a local file header for one ZIP entry.
 * @param {Object} entry - ZIP entry metadata.
 * @returns {Buffer}
 */
function buildLocalFileHeader(entry) {
  const sizeNeedsZip64 = needsZip64(entry.expectedSize);
  const extraField = sizeNeedsZip64
    ? buildZip64ExtraField([entry.expectedSize, entry.expectedSize])
    : EMPTY_BUFFER;
  const header = Buffer.alloc(ZIP_LOCAL_FILE_HEADER_BYTES);
  const dosDateTime = getDosDateTime(entry.mtime);

  header.writeUInt32LE(ZIP_LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(sizeNeedsZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_STANDARD, 4);
  header.writeUInt16LE(ZIP_GENERAL_PURPOSE_FLAGS, 6);
  header.writeUInt16LE(ZIP_COMPRESSION_STORE, 8);
  header.writeUInt16LE(dosDateTime.time, 10);
  header.writeUInt16LE(dosDateTime.date, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(sizeNeedsZip64 ? UINT32_MAX : 0, 18);
  header.writeUInt32LE(sizeNeedsZip64 ? UINT32_MAX : 0, 22);
  header.writeUInt16LE(entry.nameBuffer.length, 26);
  header.writeUInt16LE(extraField.length, 28);

  return Buffer.concat([header, entry.nameBuffer, extraField]);
}

/**
 * Build a data descriptor for one streamed ZIP entry.
 * @param {number} crc - Final CRC-32.
 * @param {bigint} size - File size.
 * @param {boolean} useZip64 - Whether to write ZIP64 size fields.
 * @returns {Buffer}
 */
function buildDataDescriptor(crc, size, useZip64) {
  const descriptor = Buffer.alloc(useZip64 ? ZIP_DATA_DESCRIPTOR_ZIP64_BYTES : ZIP_DATA_DESCRIPTOR_STANDARD_BYTES);
  let offset = 0;

  descriptor.writeUInt32LE(ZIP_DATA_DESCRIPTOR_SIGNATURE, offset);
  offset += 4;
  descriptor.writeUInt32LE(crc, offset);
  offset += 4;

  if (useZip64) {
    offset = writeUInt64(descriptor, size, offset);
    writeUInt64(descriptor, size, offset);
    return descriptor;
  }

  descriptor.writeUInt32LE(Number(size), offset);
  offset += 4;
  descriptor.writeUInt32LE(Number(size), offset);

  return descriptor;
}

/**
 * Build a central directory header for one ZIP entry.
 * @param {Object} entry - Completed ZIP entry metadata.
 * @returns {Buffer}
 */
function buildCentralDirectoryHeader(entry) {
  const sizeNeedsZip64 = needsZip64(entry.size);
  const offsetNeedsZip64 = needsZip64(entry.localHeaderOffset);
  const extraValues = [];

  if (sizeNeedsZip64) {
    extraValues.push(entry.size, entry.size);
  }
  if (offsetNeedsZip64) {
    extraValues.push(entry.localHeaderOffset);
  }

  const extraField = buildZip64ExtraField(extraValues);
  const header = Buffer.alloc(ZIP_CENTRAL_DIRECTORY_HEADER_BYTES);
  const dosDateTime = getDosDateTime(entry.mtime);
  const version = sizeNeedsZip64 || offsetNeedsZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_STANDARD;

  header.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(version, 4);
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(ZIP_GENERAL_PURPOSE_FLAGS, 8);
  header.writeUInt16LE(ZIP_COMPRESSION_STORE, 10);
  header.writeUInt16LE(dosDateTime.time, 12);
  header.writeUInt16LE(dosDateTime.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(sizeNeedsZip64 ? UINT32_MAX : Number(entry.size), 20);
  header.writeUInt32LE(sizeNeedsZip64 ? UINT32_MAX : Number(entry.size), 24);
  header.writeUInt16LE(entry.nameBuffer.length, 28);
  header.writeUInt16LE(extraField.length, 30);
  header.writeUInt16LE(ZIP_NO_FILE_COMMENT_LENGTH, 32);
  header.writeUInt16LE(ZIP_NO_DISK, 34);
  header.writeUInt16LE(ZIP_NO_INTERNAL_ATTRIBUTES, 36);
  header.writeUInt32LE(ZIP_NO_EXTERNAL_ATTRIBUTES, 38);
  header.writeUInt32LE(offsetNeedsZip64 ? UINT32_MAX : Number(entry.localHeaderOffset), 42);

  return Buffer.concat([header, entry.nameBuffer, extraField]);
}

/**
 * Build the ZIP64 end of central directory record.
 * @param {bigint} entryCount - Number of entries.
 * @param {bigint} centralDirectorySize - Central directory size.
 * @param {bigint} centralDirectoryOffset - Central directory offset.
 * @returns {Buffer}
 */
function buildZip64EndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const record = Buffer.alloc(ZIP64_END_OF_CENTRAL_DIRECTORY_BYTES);
  let offset = 0;

  record.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, offset);
  offset += 4;
  offset = writeUInt64(record, ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE_VALUE, offset);
  record.writeUInt16LE(ZIP_VERSION_ZIP64, offset);
  offset += 2;
  record.writeUInt16LE(ZIP_VERSION_ZIP64, offset);
  offset += 2;
  record.writeUInt32LE(ZIP_NO_DISK, offset);
  offset += 4;
  record.writeUInt32LE(ZIP_NO_DISK, offset);
  offset += 4;
  offset = writeUInt64(record, entryCount, offset);
  offset = writeUInt64(record, entryCount, offset);
  offset = writeUInt64(record, centralDirectorySize, offset);
  writeUInt64(record, centralDirectoryOffset, offset);

  return record;
}

/**
 * Build the ZIP64 end of central directory locator.
 * @param {bigint} zip64RecordOffset - ZIP64 end record offset.
 * @returns {Buffer}
 */
function buildZip64EndOfCentralDirectoryLocator(zip64RecordOffset) {
  const locator = Buffer.alloc(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_BYTES);

  locator.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE, 0);
  locator.writeUInt32LE(ZIP_NO_DISK, 4);
  writeUInt64(locator, zip64RecordOffset, 8);
  locator.writeUInt32LE(ZIP_TOTAL_DISKS, 16);

  return locator;
}

/**
 * Build the standard ZIP end of central directory record.
 * @param {bigint} entryCount - Number of entries.
 * @param {bigint} centralDirectorySize - Central directory size.
 * @param {bigint} centralDirectoryOffset - Central directory offset.
 * @param {boolean} useZip64 - Whether ZIP64 records are present.
 * @returns {Buffer}
 */
function buildEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset, useZip64) {
  const record = Buffer.alloc(ZIP_END_OF_CENTRAL_DIRECTORY_BYTES);
  const countField = useZip64 || entryCount > BIG_UINT16_MAX ? UINT16_MAX : Number(entryCount);
  const sizeField = useZip64 || centralDirectorySize > BIG_UINT32_MAX ? UINT32_MAX : Number(centralDirectorySize);
  const offsetField = useZip64 || centralDirectoryOffset > BIG_UINT32_MAX ? UINT32_MAX : Number(centralDirectoryOffset);

  record.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(ZIP_NO_DISK, 4);
  record.writeUInt16LE(ZIP_NO_DISK, 6);
  record.writeUInt16LE(countField, 8);
  record.writeUInt16LE(countField, 10);
  record.writeUInt32LE(sizeField, 12);
  record.writeUInt32LE(offsetField, 16);
  record.writeUInt16LE(ZIP_NO_COMMENT_LENGTH, 20);

  return record;
}

/**
 * Wait for a writable stream to accept more data.
 * @param {import('stream').Writable} output - Writable stream.
 * @returns {Promise<void>}
 */
function waitForDrain(output) {
  return new Promise((resolve, reject) => {
    /**
     * Remove temporary stream listeners.
     * @returns {void}
     */
    function cleanup() {
      output.off('drain', onDrain);
      output.off('error', onError);
    }

    /**
     * Resolve when the stream drains.
     * @returns {void}
     */
    function onDrain() {
      cleanup();
      resolve();
    }

    /**
     * Reject when the stream errors.
     * @param {Error} error - Stream error.
     * @returns {void}
     */
    function onError(error) {
      cleanup();
      reject(error);
    }

    output.once('drain', onDrain);
    output.once('error', onError);
  });
}

/**
 * Write a buffer to a stream with backpressure handling.
 * @param {import('stream').Writable} output - Writable stream.
 * @param {Buffer} buffer - Buffer to write.
 * @returns {Promise<bigint>}
 */
async function writeBuffer(output, buffer) {
  if (output.destroyed) {
    throw new Error('The download connection was closed.');
  }

  if (!output.write(buffer)) {
    await waitForDrain(output);
  }

  return BigInt(buffer.length);
}

/**
 * End a writable response and wait for buffered data to flush.
 * @param {import('stream').Writable} output - Writable stream.
 * @returns {Promise<void>}
 */
function endOutput(output) {
  return new Promise((resolve, reject) => {
    /**
     * Remove temporary stream listeners.
     * @returns {void}
     */
    function cleanup() {
      output.off('error', onError);
    }

    /**
     * Resolve after the stream ends.
     * @returns {void}
     */
    function onEnded() {
      cleanup();
      resolve();
    }

    /**
     * Reject when the stream errors.
     * @param {Error} error - Stream error.
     * @returns {void}
     */
    function onError(error) {
      cleanup();
      reject(error);
    }

    output.once('error', onError);
    output.end(onEnded);
  });
}

/**
 * Stream one file into the ZIP output while calculating CRC-32.
 * @param {import('stream').Writable} output - Writable stream.
 * @param {string} filePath - File to stream.
 * @returns {Promise<{ crc: number, size: bigint }>}
 */
async function writeFileContent(output, filePath) {
  const input = fs.createReadStream(filePath);
  let crc = CRC_INITIAL_VALUE;
  let size = 0n;

  for await (const chunk of input) {
    crc = updateCrc(crc, chunk);
    size += BigInt(chunk.length);
    await writeBuffer(output, chunk);
  }

  return {
    crc: finalizeCrc(crc),
    size
  };
}

/**
 * Determine whether the central directory needs ZIP64 end records.
 * @param {bigint} entryCount - Number of entries.
 * @param {bigint} centralDirectorySize - Central directory size.
 * @param {bigint} centralDirectoryOffset - Central directory offset.
 * @param {Array<Object>} entries - Completed ZIP entries.
 * @returns {boolean}
 */
function shouldUseZip64EndRecords(entryCount, centralDirectorySize, centralDirectoryOffset, entries) {
  return entryCount > BIG_UINT16_MAX
    || centralDirectorySize > BIG_UINT32_MAX
    || centralDirectoryOffset > BIG_UINT32_MAX
    || entries.some((entry) => needsZip64(entry.size) || needsZip64(entry.localHeaderOffset));
}

/**
 * Stream multiple files as a ZIP download.
 * @param {import('express').Response} response - Express response.
 * @param {Array<{ path: string, size: number, mtime: Date }>} files - Files to include.
 * @param {string} sourceRoot - Root used to create relative archive names.
 * @param {string} targetPath - Original folder path used for the archive filename.
 * @returns {Promise<void>}
 */
async function streamZip(response, files, sourceRoot, targetPath) {
  const entries = buildEntries(files, sourceRoot);
  if (entries.length === 0) {
    throw new Error('No downloadable files were found for this folder.');
  }

  response.type(ZIP_MIME_TYPE);
  response.attachment(getArchiveName(targetPath));

  try {
    let writtenBytes = 0n;
    const completedEntries = [];

    for (const entry of entries) {
      const localHeader = buildLocalFileHeader(entry);
      const localHeaderOffset = writtenBytes;
      writtenBytes += await writeBuffer(response, localHeader);

      const content = await writeFileContent(response, entry.path);
      const descriptor = buildDataDescriptor(
        content.crc,
        content.size,
        needsZip64(entry.expectedSize) || needsZip64(content.size)
      );
      writtenBytes += content.size;
      writtenBytes += await writeBuffer(response, descriptor);

      completedEntries.push(Object.assign({}, entry, {
        crc: content.crc,
        size: content.size,
        localHeaderOffset
      }));
    }

    const centralDirectoryOffset = writtenBytes;
    for (const entry of completedEntries) {
      writtenBytes += await writeBuffer(response, buildCentralDirectoryHeader(entry));
    }

    const centralDirectorySize = writtenBytes - centralDirectoryOffset;
    const entryCount = BigInt(completedEntries.length);
    const useZip64 = shouldUseZip64EndRecords(
      entryCount,
      centralDirectorySize,
      centralDirectoryOffset,
      completedEntries
    );

    if (useZip64) {
      const zip64RecordOffset = writtenBytes;
      writtenBytes += await writeBuffer(response, buildZip64EndOfCentralDirectory(
        entryCount,
        centralDirectorySize,
        centralDirectoryOffset
      ));
      writtenBytes += await writeBuffer(response, buildZip64EndOfCentralDirectoryLocator(zip64RecordOffset));
    }

    await writeBuffer(response, buildEndOfCentralDirectory(
      entryCount,
      centralDirectorySize,
      centralDirectoryOffset,
      useZip64
    ));
    await endOutput(response);
  } catch (error) {
    log.error(`ZIP download failed: ${error.message}`);
    if (!response.headersSent) {
      throw error;
    }
    response.destroy(error);
  }
}

module.exports = {
  getArchiveName,
  streamZip
};
