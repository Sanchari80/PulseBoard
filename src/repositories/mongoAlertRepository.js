'use strict';

const mongoose = require('mongoose');
const Alert = require('../models/Alert');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEVERITY_SORT = { $cond: [{ $eq: ['$severity', 'critical'] }, 0, 1] };

/** MongoDB implementation of the alert repository (Mongoose). */
class MongoAlertRepository {
  constructor() {
    this.kind = 'mongodb';
  }

  async findActiveByFingerprints(fingerprints) {
    const docs = await Alert.find({ status: 'active', fingerprint: { $in: fingerprints } });
    return new Map(docs.map((d) => [d.fingerprint, d.toJSON()]));
  }

  async create(doc) {
    const created = await Alert.create(doc);
    return created.toJSON();
  }

  async recordOccurrence(fingerprint, { count = 1, sample, anomalies, severity, lastSeenAt, batchId }) {
    const $set = { sample, anomalies, lastSeenAt: new Date(lastSeenAt), batchId };
    if (severity === 'critical') $set.severity = 'critical'; // escalate, never downgrade an open incident
    const doc = await Alert.findOneAndUpdate({ fingerprint, status: 'active' }, { $inc: { occurrences: count }, $set }, { returnDocument: 'after' });
    return doc ? doc.toJSON() : null;
  }

  async updateText(id, fields) {
    const doc = await Alert.findByIdAndUpdate(id, { $set: fields }, { returnDocument: 'after' });
    return doc ? doc.toJSON() : null;
  }

  _match({ status = 'active', severity, api, q } = {}) {
    const m = {};
    if (status !== 'all') m.status = status;
    if (severity) m.severity = severity;
    if (api) m.apiName = api;
    if (q) {
      const re = new RegExp(escapeRe(q), 'i');
      m.$or = [{ apiName: re }, { message: re }, { title: re }];
    }
    return m;
  }

  async list(query = {}) {
    const { limit = 100, page = 1 } = query;
    const match = this._match(query);
    const [items, total] = await Promise.all([
      Alert.aggregate([{ $match: match }, { $addFields: { _sev: SEVERITY_SORT } }, { $sort: { _sev: 1, lastSeenAt: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: { _sev: 0, __v: 0 } }]),
      Alert.countDocuments(match),
    ]);
    return { items: items.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })), total };
  }

  async getById(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await Alert.findById(id);
    return doc ? doc.toJSON() : null;
  }

  async setStatus(id, status) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await Alert.findByIdAndUpdate(
      id,
      status === 'resolved' ? { status, resolvedAt: new Date() } : { status, $unset: { resolvedAt: 1 } },
      { returnDocument: 'after', runValidators: true }
    );
    return doc ? doc.toJSON() : null;
  }

  async resolveAll(filter = {}) {
    const res = await Alert.updateMany(this._match({ ...filter, status: 'active' }), { status: 'resolved', resolvedAt: new Date() });
    return res.modifiedCount;
  }

  async markEmailed(ids) {
    const valid = ids.filter((id) => mongoose.isValidObjectId(id));
    if (valid.length) await Alert.updateMany({ _id: { $in: valid } }, { emailedAt: new Date() });
  }

  async stats() {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [facet] = await Alert.aggregate([
      {
        $facet: {
          counts: [{ $group: { _id: { status: '$status', severity: '$severity' }, n: { $sum: 1 } } }],
          last24h: [{ $match: { lastSeenAt: { $gte: since } } }, { $count: 'n' }],
          byApi: [
            { $match: { status: 'active' } },
            { $group: { _id: '$apiName', count: { $sum: 1 }, occurrences: { $sum: '$occurrences' }, crit: { $max: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } } } },
            { $sort: { count: -1 } },
          ],
        },
      },
    ]);
    const count = (status, severity) => facet.counts.filter((c) => c._id.status === status && (!severity || c._id.severity === severity)).reduce((s, c) => s + c.n, 0);
    return {
      active: count('active'),
      critical: count('active', 'critical'),
      warning: count('active', 'warning'),
      resolved: count('resolved'),
      last24h: facet.last24h[0]?.n || 0,
      byApi: facet.byApi.map((b) => ({ apiName: b._id, count: b.count, occurrences: b.occurrences, severity: b.crit ? 'critical' : 'warning' })),
    };
  }

  async clear() {
    await Alert.deleteMany({});
  }
}

module.exports = MongoAlertRepository;
