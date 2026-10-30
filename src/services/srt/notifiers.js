import { SEVERITY_RANK } from '../../constants/srt.js';
const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️' };
export function describeAlert(a, host = 'Pulse') {
  const recovered = a.state === 'cleared';
  const icon = recovered ? '✅' : ICON[a.severity];
  const label = recovered ? 'RECOVERED' : a.severity.toUpperCase();
  const details = a.details
    ? Object.entries(a.details)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
    : '';
  const who = a.channelName ? `${a.channelName}: ` : '';
  return {
    title: `${icon} [${label}] ${who}${a.rule}`,
    text: `${a.channelName ? `*${a.channelName}* — ` : ''}${a.message}${details ? `\n${details}` : ''}\n${host} · ${new Date(recovered ? (a.clearedAt ?? a.at) : a.at).toISOString()}`,
  };
}
/** Request body for a webhook; pure so it can be unit-tested. */
export function webhookBody(kind, a) {
  const { title, text } = describeAlert(a);
  if (kind === 'slack') return { text: `*${title}*\n${text}` };
  if (kind === 'teams') {
    // Adaptive Card in the message envelope that Teams "Workflows" webhooks accept.
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
              { type: 'TextBlock', text, wrap: true },
            ],
          },
        },
      ],
    };
  }
  return { source: 'playprobe-srt', ...a, title, text };
}
export async function sendWebhook(cfg, a, fetchImpl = fetch) {
  let url;
  try {
    url = new URL(cfg.url);
  } catch {
    throw new Error('Webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Webhook URL must be http(s)');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(webhookBody(cfg.kind, a)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Webhook responded ${res.status} ${res.statusText}`);
}
export async function sendEmail(cfg, a) {
  if (!cfg.host || !cfg.to || !cfg.from) throw new Error('Email needs an SMTP host, a from address and a to address');
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const { title, text } = describeAlert(a);
  try {
    await transport.sendMail({ from: cfg.from, to: cfg.to, subject: title, text });
  } finally {
    transport.close();
  }
}
/**
 * Only these main faults are sent to Slack / Teams / email. Everything else (link loss, retransmissions, PAT/PMT, bitrate
 * dips, ...) is still shown in the app and written to the channel log, all-channels.log and alerts.log.
 */
export const NOTIFY_RULES = new Set(['no_connection', 'no_signal', 'video_black', 'audio_silence', 'ts_sync']);
/** Applies severity filtering, flap cooldown and recovery rules, then sends to every enabled channel. */
export class Notifier {
  settings;
  onResult;
  now;
  lastSent = new Map();
  notified = new Set();
  constructor(settings, onResult = () => undefined, now = Date.now) {
    this.settings = settings;
    this.onResult = onResult;
    this.now = now;
  }
  async notify(a) {
    const s = this.settings();
    if (!NOTIFY_RULES.has(a.rule)) return [];
    if (SEVERITY_RANK[a.severity] < SEVERITY_RANK[s.minSeverity]) return [];
    const key = `${a.channelId ?? 0}:${a.key}`;
    if (a.state === 'cleared') {
      if (!s.notifyOnClear || !this.notified.delete(key)) return [];
    } else if (a.state === 'raised') {
      const last = this.lastSent.get(key);
      if (last !== undefined && this.now() - last < s.cooldownSec * 1000) return [];
      this.lastSent.set(key, this.now());
      this.notified.add(key);
    }
    return this.deliver(a, s);
  }
  /** Sends regardless of filters (the "Send test" button). */
  async deliver(a, s = this.settings()) {
    const jobs = [];
    const run = (channel, fn) =>
      jobs.push(
        fn().then(
          () => ({ channel, ok: true }),
          (err) => ({ channel, ok: false, error: err instanceof Error ? err.message : String(err) }),
        ),
      );
    if (s.webhook.enabled && s.webhook.url) run('webhook', () => sendWebhook(s.webhook, a));
    if (s.email.enabled) run('email', () => sendEmail(s.email, a));
    const results = await Promise.all(jobs);
    if (results.length) this.onResult(a, results);
    return results;
  }
}
