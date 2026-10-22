'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger').for('email');

let transporter = null;

const isEnabled = () => Boolean(config.email.enabled && config.email.host && config.email.to.length);

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined,
    });
  }
  return transporter;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderReport(alerts, { reason }) {
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #dfe7e5;vertical-align:top;width:6px;background:${a.severity === 'critical' ? '#c42b3d' : '#c98a0b'}"></td>
        <td style="padding:14px 16px;border-bottom:1px solid #dfe7e5;vertical-align:top">
          <div style="font:600 15px/1.4 Arial,sans-serif;color:#10302b">${esc(a.apiName)} <span style="font-weight:400;color:#5c716c">· ${esc(a.severity)}${a.occurrences > 1 ? ` · seen ${a.occurrences}×` : ''}</span></div>
          <div style="font:14px/1.5 Arial,sans-serif;color:#10302b;margin-top:4px">${esc(a.message)}</div>
          ${a.recommendedAction ? `<div style="font:13px/1.5 Arial,sans-serif;color:#0f6e62;margin-top:6px"><b>Next step:</b> ${esc(a.recommendedAction)}</div>` : ''}
          <div style="font:12px/1.5 Arial,sans-serif;color:#5c716c;margin-top:6px">Status ${esc(a.sample?.status_code ?? '—')} · ${esc(a.sample?.response_time_ms ?? '—')} ms · ${esc(a.sample?.records_returned ?? '—')} records · last seen ${esc(new Date(a.lastSeenAt).toUTCString())}</div>
        </td>
      </tr>`
    )
    .join('');

  const heading = reason === 'new-critical' ? `${critical} new critical API alert${critical === 1 ? '' : 's'}` : `API anomaly report – ${alerts.length} active alert${alerts.length === 1 ? '' : 's'}`;
  const html = `<!doctype html><html><body style="margin:0;background:#eef3f2;padding:24px">
    <table role="presentation" width="100%" style="max-width:680px;margin:0 auto;background:#ffffff;border-collapse:collapse;border-radius:10px;overflow:hidden">
      <tr><td colspan="2" style="padding:20px 16px;background:#10302b;color:#ffffff;font:600 18px Arial,sans-serif">${esc(heading)}</td></tr>
      ${rows || '<tr><td colspan="2" style="padding:16px;font:14px Arial,sans-serif">No active alerts.</td></tr>'}
      <tr><td colspan="2" style="padding:14px 16px;font:12px Arial,sans-serif;color:#5c716c">Sent by Pulseboard API Monitor · ${esc(new Date().toUTCString())}</td></tr>
    </table></body></html>`;
  const text = alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.apiName}: ${a.message}${a.recommendedAction ? `\n  Next step: ${a.recommendedAction}` : ''}`).join('\n\n');
  return { subject: `[API Monitor] ${heading}`, html, text: text || 'No active alerts.' };
}

async function sendAlertReport(alerts, { reason = 'report', to } = {}) {
  if (!isEnabled()) throw new Error('E-mail is not configured (set EMAIL_ENABLED, SMTP_HOST and EMAIL_TO)');
  const { subject, html, text } = renderReport(alerts, { reason });
  const info = await getTransporter().sendMail({ from: config.email.from, to: to || config.email.to.join(','), subject, html, text });
  logger.info(`Sent "${subject}" (${info.messageId})`);
  return { messageId: info.messageId, recipients: to || config.email.to, subject };
}

module.exports = { isEnabled, sendAlertReport, renderReport };
