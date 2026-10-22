'use strict';

const mongoose = require('mongoose');

const anomalySchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
    field: String,
    value: mongoose.Schema.Types.Mixed,
    threshold: Number,
    detail: String,
  },
  { _id: false }
);

const alertSchema = new mongoose.Schema(
  {
    apiName: { type: String, required: true, index: true },
    fingerprint: { type: String, required: true },
    status: { type: String, enum: ['active', 'resolved'], default: 'active', index: true },
    severity: { type: String, enum: ['warning', 'critical'], required: true, index: true },
    types: [String],
    anomalies: [anomalySchema],
    sample: {
      response_time_ms: Number,
      status_code: Number,
      records_returned: Number,
    },
    title: String,
    message: { type: String, required: true },
    likelyCause: String,
    impact: String,
    recommendedAction: String,
    aiSource: String,
    promptVersion: String,
    occurrences: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    resolvedAt: Date,
    batchId: String,
    source: { type: String, enum: ['api', 'file', 'scheduler', 'simulation', 'sample'], default: 'api' },
    emailedAt: Date,
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  }
);

// One open incident per fingerprint: concurrent batches cannot create duplicates.
alertSchema.index({ fingerprint: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
alertSchema.index({ status: 1, severity: 1, lastSeenAt: -1 });

module.exports = mongoose.models.Alert || mongoose.model('Alert', alertSchema);
