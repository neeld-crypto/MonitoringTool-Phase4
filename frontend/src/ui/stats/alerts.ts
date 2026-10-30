import type { SrtClient } from '../../srt/client';
import { enableDesktopNotifications, loadPrefs, savePrefs } from '../../srt/notify';
import {
  DEFAULT_NOTIFY,
  DEFAULT_THRESHOLDS,
  type Alert,
  type AlertThresholds,
  type NotifySettings,
  type Severity,
} from '../../srt/types';
import { badge, dataTable, h } from '../dom';

const KIND: Record<Severity, string> = { critical: 'warn', warning: 'out', info: 'other' };

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

type NumKey = { [K in keyof AlertThresholds]: AlertThresholds[K] extends number ? K : never }[keyof AlertThresholds];

const THRESHOLD_FIELDS: { key: NumKey; label: string; unit: string; hint?: string }[] = [
  { key: 'waitingSec', label: 'Not connected after', unit: 's', hint: '0 = off' },
  { key: 'noSignalSec', label: 'No signal after', unit: 's', hint: 'no data while connected' },
  { key: 'bitrateDropPct', label: 'Bitrate drop', unit: '%', hint: 'below 30 s average (0 = off)' },
  { key: 'minBitrateKbps', label: 'Minimum bitrate', unit: 'kbps', hint: '0 = off' },
  { key: 'rttMs', label: 'SRT RTT above', unit: 'ms' },
  { key: 'lossPct', label: 'SRT packet loss above', unit: '%', hint: 'over 10 s' },
  { key: 'droppedPackets', label: 'SRT dropped packets', unit: 'pkts', hint: 'over 10 s (0 = off)' },
  { key: 'retransPct', label: 'SRT retransmits above', unit: '%', hint: 'over 10 s' },
  { key: 'ccErrors', label: 'Continuity errors', unit: '/10 s' },
  { key: 'decodeErrors', label: 'Decode errors', unit: '/10 s' },
  { key: 'psiTimeoutMs', label: 'PAT / PMT missing for', unit: 'ms', hint: 'TR 101 290: 500' },
  { key: 'pcrMaxMs', label: 'PCR repetition above', unit: 'ms', hint: 'TR 101 290: 40' },
  { key: 'pidTimeoutSec', label: 'PID missing for', unit: 's' },
  { key: 'blackSec', label: 'Black video for', unit: 's' },
  { key: 'silenceSec', label: 'Audio silence for', unit: 's' },
];

const field = (text: string, control: HTMLElement, hint?: string) =>
  h('label', { class: 'drm-field' }, h('span', null, text, hint ? h('small', null, ` ${hint}`) : ''), control);

/**
 * Alerts tab: what is wrong right now, the alert history, and the settings that
 * decide what raises an alert and where it is sent (webhook / email / this browser).
 * The settings form is built once so typing is never interrupted by live updates.
 */
export class AlertsTab {
  readonly el = h('div', { class: 'tab-pane' });
  private active = h('div');
  private history = h('div');
  private thresholdInputs = new Map<NumKey, HTMLInputElement>();
  private scteInput = h('input', { type: 'checkbox' });
  private sound = h('input', { type: 'checkbox' });
  private desktop = h('input', { type: 'checkbox' });
  private result = h('div', { class: 'small' });
  private rulesTitle = h('h4');
  private others = h('p', { class: 'small' });

  private minSeverity = h('select', { 'aria-label': 'Minimum severity' }, ['info', 'warning', 'critical'].map((s) => h('option', { value: s }, s))) as HTMLSelectElement;
  private onClear = h('input', { type: 'checkbox' });
  private cooldown = h('input', { type: 'number', min: 0, max: 86400, 'aria-label': 'Cooldown seconds' });
  private hookOn = h('input', { type: 'checkbox' });
  private hookKind = h('select', { 'aria-label': 'Webhook type' }, [
    h('option', { value: 'slack' }, 'Slack'),
    h('option', { value: 'teams' }, 'Microsoft Teams (Workflows)'),
    h('option', { value: 'generic' }, 'Generic JSON'),
  ]) as HTMLSelectElement;
  private hookUrl = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'https://hooks.slack.com/services/…', 'aria-label': 'Webhook URL' });
  private mailOn = h('input', { type: 'checkbox' });
  private mailHost = h('input', { type: 'text', autocomplete: 'off', placeholder: 'smtp.example.com', 'aria-label': 'SMTP host' });
  private mailPort = h('input', { type: 'number', min: 1, max: 65535, 'aria-label': 'SMTP port' });
  private mailSecure = h('input', { type: 'checkbox' });
  private mailUser = h('input', { type: 'text', autocomplete: 'off', 'aria-label': 'SMTP user' });
  private mailPass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'SMTP password' });
  private mailFrom = h('input', { type: 'text', autocomplete: 'off', placeholder: 'alerts@example.com', 'aria-label': 'From address' });
  private mailTo = h('input', { type: 'text', autocomplete: 'off', placeholder: 'ops@example.com, oncall@example.com', 'aria-label': 'To addresses' });

  constructor(private readonly client: SrtClient) {
    const prefs = loadPrefs();
    this.sound.checked = prefs.sound;
    this.desktop.checked = prefs.desktop;
    this.sound.addEventListener('change', () => savePrefs({ sound: this.sound.checked, desktop: this.desktop.checked }));
    this.desktop.addEventListener('change', async () => {
      if (this.desktop.checked && !(await enableDesktopNotifications())) {
        this.desktop.checked = false;
        this.say('Desktop notifications are blocked or unsupported in this browser.', true);
      }
      savePrefs({ sound: this.sound.checked, desktop: this.desktop.checked });
    });

    this.el.append(this.others, this.active, this.history, this.settingsForm());
    this.fill(true);
    client.on('settings', () => this.fill(true));
    // Initial load only: later status changes must not overwrite unsaved edits.
    client.on('status', () => this.fill());
  }

  private say(text: string, error = false) {
    this.result.className = `small ${error ? 'error' : 'ok'}`;
    this.result.textContent = text;
  }

  private settingsForm(): HTMLElement {
    const thresholdFields = THRESHOLD_FIELDS.map((f) => {
      const input = h('input', { type: 'number', step: 'any', 'aria-label': f.label });
      this.thresholdInputs.set(f.key, input);
      return field(`${f.label} (${f.unit})`, input, f.hint);
    });

    return h(
      'details',
      { class: 'decoder alert-settings' },
      h('summary', null, 'Alert rules & notifications'),
      this.rulesTitle,
      h('p', { class: 'muted small' }, 'Rules are kept per channel. Webhook and email settings below are shared by all channels; every message starts with the channel name.'),
      h('div', { class: 'drm-grid' }, thresholdFields),
      h('label', { class: 'srt-check' }, this.scteInput, ' Raise SCTE-35 splice events as info alerts'),

      h('h4', null, 'This browser'),
      h('label', { class: 'srt-check' }, this.sound, ' Play a sound for warnings and critical alerts'),
      h('label', { class: 'srt-check' }, this.desktop, ' Show desktop notifications'),

      h('h4', null, 'Webhook & email'),
      h('p', { class: 'muted small' }, 'Sent by the local server, so they keep working when this page is closed. Secrets are stored in .playprobe/srt-settings.json and never shown again.'),
      h(
        'div',
        { class: 'drm-grid' },
        field('Send alerts at or above', this.minSeverity),
        field('Re-send the same alert after', this.cooldown, 'seconds'),
      ),
      h('label', { class: 'srt-check' }, this.onClear, ' Also send a message when an alert recovers'),
      h(
        'fieldset',
        { class: 'drm-box' },
        h('legend', null, 'Slack / Teams / webhook'),
        h('label', { class: 'srt-check' }, this.hookOn, ' Enabled'),
        field('Type', this.hookKind),
        field('Webhook URL', this.hookUrl),
      ),
      h(
        'fieldset',
        { class: 'drm-box' },
        h('legend', null, 'Email (SMTP)'),
        h('label', { class: 'srt-check' }, this.mailOn, ' Enabled'),
        h('div', { class: 'drm-grid' }, field('SMTP host', this.mailHost), field('Port', this.mailPort)),
        h('label', { class: 'srt-check' }, this.mailSecure, ' Use TLS from the start (port 465); leave off for STARTTLS (587)'),
        h('div', { class: 'drm-grid' }, field('User', this.mailUser), field('Password', this.mailPass)),
        field('From', this.mailFrom),
        field('To', this.mailTo, '(comma separated)'),
      ),
      h(
        'div',
        { class: 'srt-actions' },
        h('button', { type: 'button', class: 'primary', onclick: () => void this.save() }, 'Save'),
        h('button', { type: 'button', onclick: () => void this.test() }, 'Save & send test'),
        h('button', { type: 'button', onclick: () => this.resetThresholds() }, 'Reset thresholds'),
        h('button', { type: 'button', onclick: () => void this.copyRules() }, 'Copy these rules to all channels'),
      ),
      this.result,
    );
  }

  private filled = false;

  /** Copies server settings into the form: once on load, then only when forced (after saving). */
  private fill(force = false) {
    const s = this.client.settings;
    if (!s || (this.filled && !force)) return;
    this.filled = true;
    this.rulesTitle.textContent = `Alert rules for ${this.client.current?.name ?? 'this channel'}`;
    for (const [key, input] of this.thresholdInputs) input.value = String(s.thresholds[key]);
    this.scteInput.checked = s.thresholds.scteEvents;
    const n = s.notify;
    this.minSeverity.value = n.minSeverity;
    this.onClear.checked = n.notifyOnClear;
    this.cooldown.value = String(n.cooldownSec);
    this.hookOn.checked = n.webhook.enabled;
    this.hookKind.value = n.webhook.kind;
    this.hookUrl.value = n.webhook.url;
    this.mailOn.checked = n.email.enabled;
    this.mailHost.value = n.email.host;
    this.mailPort.value = String(n.email.port);
    this.mailSecure.checked = n.email.secure;
    this.mailUser.value = n.email.user;
    this.mailPass.value = n.email.pass;
    this.mailFrom.value = n.email.from;
    this.mailTo.value = n.email.to;
  }

  private resetThresholds() {
    for (const [key, input] of this.thresholdInputs) input.value = String(DEFAULT_THRESHOLDS[key]);
    this.scteInput.checked = DEFAULT_THRESHOLDS.scteEvents;
  }

  private read(): { thresholds: AlertThresholds; notify: NotifySettings } {
    const thresholds = { ...DEFAULT_THRESHOLDS, scteEvents: this.scteInput.checked };
    for (const [key, input] of this.thresholdInputs) thresholds[key] = Number(input.value);
    const notify: NotifySettings = {
      ...DEFAULT_NOTIFY,
      minSeverity: this.minSeverity.value as Severity,
      notifyOnClear: this.onClear.checked,
      cooldownSec: Number(this.cooldown.value),
      webhook: { enabled: this.hookOn.checked, kind: this.hookKind.value as NotifySettings['webhook']['kind'], url: this.hookUrl.value.trim() },
      email: {
        enabled: this.mailOn.checked,
        host: this.mailHost.value.trim(),
        port: Number(this.mailPort.value),
        secure: this.mailSecure.checked,
        user: this.mailUser.value.trim(),
        pass: this.mailPass.value,
        from: this.mailFrom.value.trim(),
        to: this.mailTo.value.trim(),
      },
    };
    return { thresholds, notify };
  }

  private async save(): Promise<boolean> {
    const cur = this.client.current;
    if (!cur) return false;
    try {
      const { thresholds, notify } = this.read();
      await this.client.saveChannel(cur.id, { thresholds });
      await this.client.saveNotify(notify);
      this.say(`Saved rules for ${cur.name}.`);
      return true;
    } catch (err) {
      this.say(`Could not save: ${err instanceof Error ? err.message : err}`, true);
      return false;
    }
  }

  private async copyRules() {
    const cur = this.client.current;
    if (!cur || !(await this.save())) return;
    try {
      await this.client.copyRules(cur.id);
      this.say(`Rules of ${cur.name} copied to every channel.`);
    } catch (err) {
      this.say(`Could not copy: ${err instanceof Error ? err.message : err}`, true);
    }
  }

  private async test() {
    if (!(await this.save())) return;
    try {
      const results = await this.client.testNotify(this.client.current?.id);
      this.say(
        results.length
          ? results.map((r) => `${r.channel}: ${r.ok ? 'sent' : `failed (${r.error})`}`).join(' · ')
          : 'No webhook or email channel is enabled.',
        results.some((r) => !r.ok),
      );
    } catch (err) {
      this.say(`Test failed: ${err instanceof Error ? err.message : err}`, true);
    }
  }

  render() {
    const alerts = this.client.alerts;
    const raised = alerts.filter((a) => a.state === 'raised');
    const name = this.client.current?.name ?? '';
    const elsewhere = this.client.channels.filter((c) => c.id !== this.client.selectedId && this.client.activeCount(c) > 0);
    this.others.className = `small ${elsewhere.length ? 'error' : 'muted'}`;
    this.others.textContent = elsewhere.length ? `Also alerting: ${elsewhere.map((c) => `${c.name} (${this.client.activeCount(c)})`).join(', ')}` : '';
    this.others.hidden = !elsewhere.length;
    this.active.replaceChildren(
      h('h3', null, raised.length ? `${name}: ${raised.length} active alert${raised.length === 1 ? '' : 's'}` : `${name}: no active alerts`),
      raised.length ? this.alertList(raised) : h('p', { class: 'muted small' }, this.client.running ? 'Everything is within the configured thresholds.' : 'Start this channel from the SRT panel in the header.'),
    );
    this.history.replaceChildren(
      h('h3', null, 'History'),
      dataTable(
        ['Time', 'Level', 'Alert'],
        alerts.slice(0, 100).map((a) => [
          h('span', { class: 'mono' }, clock(a.at)),
          badge(a.severity, KIND[a.severity]),
          [
            a.message,
            h('div', { class: 'muted small' }, a.rule, a.state === 'cleared' ? [' · ', badge(`recovered ${clock(a.clearedAt ?? a.at)}`, 'ok')] : ''),
          ],
        ]),
      ),
    );
  }

  private alertList(list: Alert[]) {
    return dataTable(
      ['Since', 'Level', 'Alert'],
      list.map((a) => [h('span', { class: 'mono' }, clock(a.at)), badge(a.severity, KIND[a.severity]), a.message]),
    );
  }
}
