import { ruleHelp, ruleLabel } from '../../srt/rule-labels';
import { h } from '../dom';
const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
/**
 * The checklist an operator reads first, in the style of a TR 101 290 analyser: every indicator is a green or red
 * dot with its error count, when it last went wrong and, while it is wrong, what it means and what to check.
 * `count` is the running total since connect; the dot follows the live alert, so it turns green again on recovery.
 */
function groups(s, wire) {
  const t = s.ts;
  const l = s.link;
  const a = s.av;
  return [
    {
      title: 'Priority 1: can the stream be read at all',
      rows: wire
        ? [
            { rule: 'ts_sync', name: 'Sync', count: t?.syncLosses },
            { rule: 'ts_pat', name: 'PAT table', count: null },
            { rule: 'ts_pmt', name: 'PMT table', count: null },
            { rule: 'ts_cc', name: 'Continuity (lost packets)', count: t?.ccErrors },
            { rule: 'pid_missing', name: 'Video / audio present', count: null },
          ]
        : [{ rule: 'pid_missing', name: 'Video / audio present', count: null }],
    },
    ...(wire
      ? [
          {
            title: 'Priority 2: will it play smoothly',
            rows: [
              { rule: 'ts_tei', name: 'Damaged packets', count: t?.teiErrors },
              { rule: 'ts_crc', name: 'Table CRC', count: t?.psiCrcErrors },
              { rule: 'ts_pcr', name: 'Timing (PCR)', count: null },
            ],
          },
        ]
      : []),
    {
      title: 'Picture and sound',
      rows: [
        { rule: 'video_black', name: 'Black screen', count: a?.blackFrames },
        { rule: 'audio_silence', name: 'Sound present', count: a?.silenceEvents },
        { rule: 'decode_errors', name: 'Decode errors', count: a?.decodeErrors },
        { rule: 'bitrate_drop', name: 'Bitrate steady', count: null },
      ],
    },
    ...(l
      ? [
          {
            title: 'Network',
            rows: [
              { rule: 'link_rtt', name: 'Delay (RTT)', count: null },
              { rule: 'link_loss', name: 'Packet loss', count: l.lost },
              { rule: 'link_dropped', name: 'Packets lost for good', count: l.dropped },
              { rule: 'link_retrans', name: 'Re-sent packets', count: l.retransmitted },
            ],
          },
        ]
      : []),
  ];
}
/** `alerts` is the channel's alert list (newest first). Rules that share a stem (`ts_pat`) are matched by name. */
export function healthPanel(s, alerts) {
  const wire = s.tsSource === 'wire';
  const sections = groups(s, wire).map((g) =>
    h(
      'div',
      { class: 'health-group' },
      h('h4', null, g.title),
      h(
        'table',
        { class: 'health-table' },
        h(
          'tbody',
          null,
          g.rows.map((r) => {
            const mine = alerts.filter((x) => x.rule === r.rule && x.state !== 'event');
            const live = mine.find((x) => x.state === 'raised');
            const last = mine[0];
            return h(
              'tr',
              { class: live ? 'bad' : 'good' },
              h('td', null, h('i', { class: `health-dot ${live ? 'bad' : 'good'}`, title: live ? 'Problem now' : 'OK' })),
              h('th', null, r.name),
              h('td', { class: 'mono' }, r.count === null || r.count === undefined ? '' : r.count.toLocaleString()),
              h(
                'td',
                { class: 'muted small' },
                live
                  ? [live.message, h('div', { class: 'health-help' }, ruleHelp(r.rule))]
                  : last
                    ? `Last problem ${clock(last.at)}`
                    : 'No problems',
              ),
            );
          }),
        ),
      ),
    ),
  );
  const raised = alerts.filter((x) => x.state === 'raised');
  const summary = raised.length
    ? h(
        'p',
        { class: 'srt-notice error' },
        `${raised.length} problem${raised.length === 1 ? '' : 's'} right now: ${[...new Set(raised.map((x) => ruleLabel(x.rule)))].join(', ')}`,
      )
    : h('p', { class: 'srt-notice' }, 'Stream is healthy: every check is passing.');
  return h('div', { class: 'health' }, summary, ...sections);
}
