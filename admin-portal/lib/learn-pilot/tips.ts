/**
 * Learn pilot — the (i) tips on the page (BACKLOG-4219). Pure: no React.
 *
 * Each describes a number the desktop app sends (the schema-1 report, migration
 * 20261112130000 header) or a mark the page derives from the server's own version rows.
 */

export const TIPS = {
  page:
    'Numbers only, sent by desktop users who turned on "Help improve Keepr". One column per sender-rules version a user has run, oldest version on the left. Reports older than 180 days, and users who left their org, are not shown.',
  mark:
    'Released: the version everyone gets. Test for this org: the version was published as a test to this org. Test for another org: published as a test, not to this org. Unknown to the server: the app reported a version the server has no row for.',
  change: 'The small number under a cell is the change from the column to its left (the next lower version this user ran).',
  interval: 'The range is a 95% Wilson interval for k out of n. No data when n is 0.',
  census:
    'For each mailbox, how many of the sampled emails each signal would hide under that version, counted on the Learn questions surface and on the Deal detection surface.',
} as const;
