/**
 * Tracked handles and streaming tweet embeds (spec §5.3).
 *
 * The Twitter monitor is the one part of Phase 3 that cannot be built without
 * a decision only the project owner can make: every provider requires a paid
 * account, so there is no keyless option (see the Phase 3 data-source spike).
 *
 * This says so plainly rather than showing an invented feed. A screen that
 * fakes data it does not have is worse than one that explains what it needs.
 */
export function CallsTab() {
  return (
    <>
      <div className="view-head">
        <h1 className="view-title">Calls</h1>
        <span className="view-sub">tweets from tracked accounts</span>
      </div>

      <div className="empty">
        <div className="empty-title">Twitter tracking needs a provider first.</div>
        <p style={{ margin: '0 0 var(--s3)' }}>
          Reading tweets has no free tier. The recommendation is <code>TwitterAPI.io</code> — already named in the
          design spec, roughly $0.15 per 1,000 tweets, and a $1 trial that needs no card, which covers far more than
          setting this up will use.
        </p>
        <p style={{ margin: 0 }}>
          The comparison and reasoning are in{' '}
          <code>docs/superpowers/specs/2026-09-01-phase-3-data-sources-spike.md</code>. Once a key exists, this tab
          shows tracked handles and their tweets, and tweet alerts join the live feed on the right.
        </p>
      </div>
    </>
  );
}
