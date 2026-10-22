'use strict';

const { z } = require('zod');
const config = require('../config');
const AppError = require('../utils/AppError');

/**
 * Body of POST /monitor. Accepts any of:
 *   [ {...}, {...} ]                 – a batch (preferred)
 *   { "responses": [ {...} ] }       – a wrapped batch
 *   { "api_name": "...", ... }       – a single response
 * Individual items are NOT strictly validated here: malformed items are a monitoring
 * signal (inconsistent data), so the detector inspects and reports them instead of
 * rejecting the whole batch.
 */
const itemSchema = z.unknown();
const batchSchema = z
  .array(itemSchema)
  .min(1, 'Batch is empty – send at least one API response')
  .max(config.batch.maxItems, `Batch too large – max ${config.batch.maxItems} items per request`);

function parseMonitorBody(body) {
  let items;
  if (Array.isArray(body)) items = body;
  else if (body && typeof body === 'object' && Array.isArray(body.responses)) items = body.responses;
  else if (body && typeof body === 'object' && Object.keys(body).length > 0) items = [body];
  else throw AppError.badRequest('Expected a JSON array of API responses, { "responses": [...] } or a single response object');

  const result = batchSchema.safeParse(items);
  if (!result.success) throw AppError.badRequest(result.error.issues[0].message);
  return result.data;
}

const alertsQuerySchema = z.object({
  status: z.enum(['active', 'resolved', 'all']).default('active'),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  api: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  page: z.coerce.number().int().min(1).default(1),
});

function parseAlertsQuery(query) {
  const result = alertsQuerySchema.safeParse(query);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw AppError.badRequest(`Invalid query parameter "${issue.path.join('.')}": ${issue.message}`);
  }
  return result.data;
}

const simulateSchema = z.object({ count: z.coerce.number().int().min(1).max(200).default(12) });

module.exports = { parseMonitorBody, parseAlertsQuery, simulateSchema };
