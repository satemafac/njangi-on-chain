/**
 * "What changed" lines for the legal acceptance modal
 * (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md, "When the gate triggers"): a
 * version bump re-prompts users who accepted an earlier version, and the
 * modal tells them what changed. These tests pin which docs count as a bump
 * and require a note for every doc whose current version is past 1.0.0, so a
 * future bump cannot ship without one.
 */

import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_CHANGE_NOTES,
  LEGAL_DOC_IDS,
  LEGAL_LOCALES,
  getLegalChangeNote,
  legalDocsUpdatedSinceAcceptance,
} from '../legal-acceptance';

describe('LEGAL_CHANGE_NOTES', () => {
  it.each(LEGAL_DOC_IDS.filter((doc) => CURRENT_LEGAL_VERSIONS[doc] !== '1.0.0'))(
    '%s has a note for its current version in every locale',
    (doc) => {
      for (const locale of LEGAL_LOCALES) {
        const note = getLegalChangeNote(doc, locale);
        expect(note).toEqual(expect.any(String));
        expect(note?.trim().length).toBeGreaterThan(0);
      }
    },
  );

  it('never shows a note written for another version', () => {
    for (const doc of LEGAL_DOC_IDS) {
      const note = LEGAL_CHANGE_NOTES[doc];
      if (!note) continue;
      const bumped = { ...CURRENT_LEGAL_VERSIONS, [doc]: `${note.version}-next` };
      expect(getLegalChangeNote(doc, 'en', bumped)).toBeNull();
      expect(getLegalChangeNote(doc, 'fr', bumped)).toBeNull();
    }
  });

  it('returns the note in the requested language', () => {
    const note = LEGAL_CHANGE_NOTES.privacy!;
    expect(getLegalChangeNote('privacy', 'en', { ...CURRENT_LEGAL_VERSIONS, privacy: note.version })).toBe(note.en);
    expect(getLegalChangeNote('privacy', 'fr', { ...CURRENT_LEGAL_VERSIONS, privacy: note.version })).toBe(note.fr);
  });
});

describe('legalDocsUpdatedSinceAcceptance', () => {
  it('treats a first sign-in (nothing accepted yet) as no bump', () => {
    const required = LEGAL_DOC_IDS.map((doc) => ({
      doc,
      currentVersion: CURRENT_LEGAL_VERSIONS[doc],
      acceptedVersion: null,
    }));
    expect(legalDocsUpdatedSinceAcceptance([...LEGAL_DOC_IDS], required)).toEqual([]);
  });

  it('returns the missing docs the user accepted in an earlier version', () => {
    const required = [
      { doc: 'terms', currentVersion: '1.0.0', acceptedVersion: '1.0.0' },
      { doc: 'privacy', currentVersion: '1.2.0', acceptedVersion: '1.1.0' },
      { doc: 'risk', currentVersion: '1.0.0', acceptedVersion: '1.0.0' },
    ];
    expect(legalDocsUpdatedSinceAcceptance(['privacy'], required)).toEqual(['privacy']);
  });

  it('separates bumped docs from never-accepted ones in the same prompt', () => {
    const required = [
      { doc: 'terms', currentVersion: '1.1.0', acceptedVersion: '1.0.0' },
      { doc: 'privacy', currentVersion: '1.2.0', acceptedVersion: null },
      { doc: 'risk', currentVersion: '1.0.0', acceptedVersion: '1.0.0' },
    ];
    expect(legalDocsUpdatedSinceAcceptance(['terms', 'privacy'], required)).toEqual(['terms']);
  });

  it('ignores a malformed status payload', () => {
    expect(legalDocsUpdatedSinceAcceptance(['privacy'], undefined)).toEqual([]);
    expect(legalDocsUpdatedSinceAcceptance(['privacy'], 'nope')).toEqual([]);
    expect(legalDocsUpdatedSinceAcceptance(['privacy'], [null, { doc: 'privacy' }])).toEqual([]);
    expect(
      legalDocsUpdatedSinceAcceptance(['privacy'], [{ doc: 'privacy', acceptedVersion: '' }]),
    ).toEqual([]);
  });
});
