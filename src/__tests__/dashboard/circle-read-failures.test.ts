/**
 * The dashboard must not turn a failed circle read into a wrong answer.
 *
 * The page is too large to mount here (7000+ lines, live RPC on mount), so
 * these guards read its source, as capability-gate-partitioning.test.ts does
 * for the zkLogin route. The helpers they depend on are unit-tested in
 * src/lib/__tests__ (isCurrentMemberOrAdmin, isGoneObjectResponse).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(process.cwd(), 'src/pages/dashboard.tsx'), 'utf8');

describe('dashboard circle reads during an RPC outage', () => {
  it('never replaces a failed dynamic-field read with an empty list', () => {
    // With `[]` the circle's config was never found, and the card showed (and
    // cached) default amounts and a 3-member cap as the circle's terms.
    expect(SOURCE).not.toMatch(/dynamicFieldsResult\s*=\s*\{\s*data:\s*\[\]\s*\}/);
  });

  it('throws when a known CircleConfig cannot be read instead of using defaults', () => {
    expect(SOURCE).toMatch(
      /if \(!configFields\) \{\s*throw new Error\(`CircleConfig \$\{configObjectId\} could not be read`\);/,
    );
  });

  it('treats only notExists/deleted as a gone circle', () => {
    expect(SOURCE).toMatch(/if \(isGoneObjectResponse\(objectData\)\)/);
  });

  it('marks the scan degraded when any circle could not be read', () => {
    expect(SOURCE).toMatch(
      /if \(unreadableCircles > 0\) \{[\s\S]{0,200}initialResults = \{ \.\.\.initialResults, degraded: true \};/,
    );
    // Every place that leaves a circle out on a read failure counts it.
    expect(SOURCE.match(/unreadableCircles \+= /g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('marks the scan degraded when a membership receipt cannot be verified', () => {
    expect(SOURCE).toMatch(/if \(current === null\) unverifiable \+= 1;/);
    expect(SOURCE).toMatch(
      /if \(unverifiable > 0\) \{[\s\S]{0,300}initialResults = \{ \.\.\.initialResults, degraded: true \};/,
    );
    expect(SOURCE).not.toMatch(/const userIsCurrentMemberOrAdmin/);
  });

  // The degraded paths always set networkError, but nothing rendered it: a
  // failed load showed "No circles yet" or a stale list with no warning.
  it('shows networkError to the user, with a retry', () => {
    expect(SOURCE).toMatch(/\{networkError\.type && !error && \([\s\S]{0,400}\{networkError\.message\}/);
  });

  it('does not show the empty state or zero counts when the list is unknown', () => {
    expect(SOURCE).toMatch(
      /const circlesUnknown = !loading && circles\.length === 0 && networkError\.type !== null;/,
    );
    expect(SOURCE).toMatch(/\) : circlesUnknown \? \([\s\S]{0,200}Your circles couldn&apos;t be loaded/);
    expect(SOURCE.match(/\{!circlesUnknown && \(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

