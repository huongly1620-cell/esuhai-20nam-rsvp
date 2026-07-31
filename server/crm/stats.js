'use strict';

const { pool } = require('../db');

// KPI mời ↔ đăng ký ↔ buổi (E08-D016 pha 1).
// Counts only — never names/phones/emails. Auth-gated like the rest of /crm.
//
// Buổi is split into three DISJOINT groups that sum to `invited`:
//   1. sessionList      — buổi read from the invite list (D018 tags)
//   2. sessionFormKnown — no session tag, but linked to an RSVP → buổi read
//                         from rsvp_submissions.sessions
//   3. sessionUnknown   — no tag AND no RSVP → genuinely unknown
//
// `tiec-toi` / `dang-ky` in tags are the RSVP *source page*, NOT a session
// (tiec-toi.html sets RSVP_SOURCE; rsvp.js:44 stores it; sync-from-rsvp tags
// ['rsvp', source]). Reading buổi from source would be wrong — group 2 reads
// rsvp_submissions.sessions instead.

// Exact token match inside the comma-separated tags string — same convention as
// E08-D020, so `gala-vip` never counts as `gala`.
const TAG = (col, t) => `(',' || COALESCE(${col},'') || ',') ILIKE '%,${t},%'`;

const HAS_TD = TAG('g.tags', 'toa-dam');
const HAS_GALA = TAG('g.tags', 'gala');
const TAGGED = `(${HAS_TD} OR ${HAS_GALA})`;

// Group 1 + 3 + the invite-side totals. One pass over crm_guests.
const SQL_GUESTS = `
  WITH g AS (
    SELECT g.id, g.response_id,
           ${HAS_TD} AS td,
           ${HAS_GALA} AS ga,
           ${TAG('g.tags', 'tgd116')} AS tgd
    FROM crm_guests g WHERE g.deleted_at IS NULL
  )
  SELECT count(*)::int                                              AS invited,
         count(*) FILTER (WHERE tgd)::int                           AS invited_tgd,
         count(*) FILTER (WHERE response_id IS NOT NULL)::int       AS linked,
         count(*) FILTER (WHERE response_id IS NULL)::int           AS unlinked,
         count(*) FILTER (WHERE td OR ga)::int                      AS tagged,
         count(*) FILTER (WHERE td)::int                            AS any_toa_dam,
         count(*) FILTER (WHERE ga)::int                            AS any_gala,
         count(*) FILTER (WHERE td AND ga)::int                     AS both,
         count(*) FILTER (WHERE td AND NOT ga)::int                 AS only_toa_dam,
         count(*) FILTER (WHERE ga AND NOT td)::int                 AS only_gala,
         count(*) FILTER (WHERE NOT td AND NOT ga
                            AND response_id IS NOT NULL)::int       AS form_known,
         count(*) FILTER (WHERE NOT td AND NOT ga
                            AND response_id IS NULL)::int           AS session_unknown,
         -- AC-3c: must be 0 for the three groups to be disjoint.
         count(*) FILTER (WHERE (td OR ga)
                            AND response_id IS NOT NULL)::int       AS overlap_tag_and_form
  FROM g`;

// Group 2 detail — buổi comes from the submission the card is linked to, NOT
// from the source tag. Guests are counted, not submissions (1 submission can
// produce several cards).
// LEFT JOIN on purpose: a card whose response_id points at a missing submission
// must still land in a bucket (`unspecified`) instead of vanishing from the
// breakdown while still counting in `form_known`.
const SQL_FORM_SESSIONS = `
  SELECT s.sessions, count(DISTINCT g.id)::int AS n
  FROM crm_guests g
  LEFT JOIN rsvp_submissions s ON s.id = g.response_id
  WHERE g.deleted_at IS NULL AND g.response_id IS NOT NULL AND NOT ${TAGGED}
  GROUP BY s.sessions`;

// AC-5b: Rg is its OWN query. It happens to equal `linked` on today's data, but
// it is a different quantity (sum of guest_count over `yes` submissions vs the
// number of guest cards carrying a response_id). Folding them into one query
// would pass today and silently break the moment the data moves.
const SQL_RSVP = `
  SELECT count(*)::int AS submissions,
         coalesce(sum(guest_count) FILTER (WHERE status = 'yes'), 0)::int AS rsvp_guests
  FROM rsvp_submissions`;

// Check-ins of ACTIVE guests only. Guest delete is a soft delete (guests.js sets
// deleted_at), so the check-in row survives — counting it raw would put
// `checkedIn` on a different denominator than `invited`.
const SQL_CHECKINS = `
  SELECT count(*)::int AS n
  FROM crm_check_ins ci
  JOIN crm_guests g ON g.id = ci.guest_id
  WHERE g.deleted_at IS NULL`;

// Independent recount of I, deliberately NOT derived from SQL_GUESTS, so the
// partition check below compares two separately-computed numbers instead of
// asserting a tautology.
const SQL_INVITED_CHECK = 'SELECT count(*)::int AS n FROM crm_guests WHERE deleted_at IS NULL';

// "Tọa đàm · Gala" vs "Gala" — classify without assuming an exact label.
function classifySessions(raw) {
  const s = String(raw || '').toLowerCase();
  const td = s.includes('tọa đàm') || s.includes('toa dam') || s.includes('toa-dam');
  const gala = s.includes('gala');
  return { td, gala };
}

function mount(app, requireCrmAuth) {
  app.get('/crm/stats', requireCrmAuth, async (req, res) => {
    // One connection, one read-only REPEATABLE READ snapshot: the RSVP endpoint
    // auto-syncs into crm_guests, so counts taken from separate connections can
    // straddle a write and disagree with each other.
    // connect() MUST stay inside the try: a rejection here is an unhandled
    // rejection that kills the process, and KPI must never take the check-in
    // screen down with it. Same shape as admin.js / import.js.
    let client;
    try {
      client = await pool.connect();
      let gr, fr, rr, cr, ir;
      try {
        await client.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
        gr = await client.query(SQL_GUESTS);
        fr = await client.query(SQL_FORM_SESSIONS);
        rr = await client.query(SQL_RSVP);
        cr = await client.query(SQL_CHECKINS);
        ir = await client.query(SQL_INVITED_CHECK);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
      const g = gr.rows[0];

      // Group 2 breakdown by declared session.
      const form = { total: g.form_known, gala: 0, toaDamGala: 0, toaDamOnly: 0, unspecified: 0 };
      for (const row of fr.rows) {
        const { td, gala } = classifySessions(row.sessions);
        if (td && gala) form.toaDamGala += row.n;
        else if (td) form.toaDamOnly += row.n;
        else if (gala) form.gala += row.n;
        else form.unspecified += row.n;
      }

      const sessionList = {
        tagged: g.tagged,
        anyToaDam: g.any_toa_dam,
        anyGala: g.any_gala,
        both: g.both,
        onlyToaDam: g.only_toa_dam,
        onlyGala: g.only_gala,
      };

      // AC-3b invariant + AC-3c disjointness. Both are reported, never patched:
      // if either breaks the UI must degrade, not quietly reconcile.
      // Compared against SQL_INVITED_CHECK — a separate query — because checking
      // the three FILTERs against their own count(*) can never fail.
      const partitionOk = (g.tagged + g.form_known + g.session_unknown) === ir.rows[0].n
        && g.invited === ir.rows[0].n;
      const disjoint = g.overlap_tag_and_form === 0;
      // Every group-2 card must land in exactly one bucket; a gap means the
      // breakdown is lying even though the total looks right.
      const bucketsOk = (form.gala + form.toaDamGala + form.toaDamOnly + form.unspecified) === form.total;

      return res.json({
        ok: true,
        invited: g.invited,
        invitedTgd: g.invited_tgd,
        rsvpSubmissions: rr.rows[0].submissions,
        rsvpGuests: rr.rows[0].rsvp_guests,
        linked: g.linked,
        unlinked: g.unlinked,
        checkedIn: cr.rows[0].n,
        sessionList,
        sessionFormKnown: form,
        sessionUnknown: g.session_unknown,
        integrity: {
          partitionOk,
          disjoint,
          bucketsOk,
          overlapTagAndForm: g.overlap_tag_and_form,
        },
        asOf: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[crm-stats] failed:', err.message);
      return res.status(500).json({ ok: false, error: 'stats error' });
    } finally {
      if (client) client.release();
    }
  });
}

module.exports = { mount };
