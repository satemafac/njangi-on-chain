/**
 * NJA-3447 (refile of NJA-3379 / NJA-2814): the landing hero and the custody
 * proof item must describe the escrow plainly, in the exact EN and FR text
 * cleared under legal matter LC-T-e1ac6dc3, and must make no new promises
 * ("fixed" order, "nobody can") nor call the pot self-custodied.
 *
 * The dictionaries use FLAT keys that contain dots ('landing.heroTitle').
 * Jest's toHaveProperty reads a dotted key as a nested path and can never
 * match them (that is what sank NJA-3379), so keys are read with bracket
 * access and checked with Object.prototype.hasOwnProperty.call.
 */
import { DICTIONARIES } from '../../lib/i18n';

const en = DICTIONARIES.en;
const fr = DICTIONARIES.fr;

const has = (dict: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(dict, key);

const EXPECTED_EN: Record<string, string> = {
  'landing.heroTitle':
    'The savings circle your family already trusts — now with a rotation order and a record every member can check.',
  'landing.heroSubtitle':
    "Members contribute on schedule, each takes the pot in turn. Njangi On-Chain keeps that exact rhythm: each contribution is held by the circle's escrow contract until the member whose turn it is collects it, and each member signs their own transactions — no treasurer holding the cash, no seed phrase to start. Our FAQ explains how the escrow contract works and who holds its upgrade key.",
  'landing.proof.custodyValue': 'Escrow contract',
};

const EXPECTED_FR: Record<string, string> = {
  'landing.heroTitle':
    "Le cercle d'épargne auquel votre famille fait déjà confiance — désormais avec un ordre de passage et un registre que chaque membre peut vérifier.",
  'landing.heroSubtitle':
    "Les membres cotisent selon un calendrier, chacun reçoit la cagnotte à son tour. Njangi On-Chain conserve ce rythme exact : chaque cotisation est gardée par le contrat de séquestre du cercle jusqu'à ce que le membre dont c'est le tour la récupère, et chaque membre signe ses propres transactions — aucun trésorier ne détient l'argent, aucune phrase secrète pour démarrer. Notre FAQ explique le fonctionnement du contrat de séquestre et qui détient sa clé de mise à jour.",
  'landing.proof.custodyValue': 'Contrat de séquestre',
};

const KEYS = Object.keys(EXPECTED_EN);
const HERO_KEYS = ['landing.heroTitle', 'landing.heroSubtitle'] as const;

// Wording the legal decision ruled out: no self-custody claim, no "fixed"
// order, no "nobody can". One list for both locales so a locale borrowing the
// other's wording is caught too.
const BANNED = ['self-custod', 'autodétenu', 'fixed', 'fixe', 'nobody'];

describe('landing escrow wording (NJA-3447)', () => {
  it('defines the six keys as flat dotted keys in both dictionaries', () => {
    for (const key of KEYS) {
      expect(has(en, key)).toBe(true);
      expect(has(fr, key)).toBe(true);
    }
  });

  it.each(KEYS)('EN %s is exactly the approved text', (key) => {
    expect(en[key]).toBe(EXPECTED_EN[key]);
  });

  it.each(KEYS)('FR %s is exactly the approved text', (key) => {
    expect(fr[key]).toBe(EXPECTED_FR[key]);
  });

  it.each(HERO_KEYS)('neither hero makes a ruled-out promise in %s', (key) => {
    for (const [locale, dict] of [
      ['en', en],
      ['fr', fr],
    ] as const) {
      const value = dict[key];
      expect(typeof value).toBe('string');
      for (const word of BANNED) {
        // The failure message names the locale, key and word.
        expect(`${locale} ${key} contains "${word}": ${value.toLowerCase().includes(word.toLowerCase())}`).toBe(
          `${locale} ${key} contains "${word}": false`,
        );
      }
    }
  });

  it('the heroes name the escrow contract and point to the FAQ on its upgrade key', () => {
    expect(en['landing.heroSubtitle']).toContain('escrow contract');
    expect(en['landing.heroSubtitle']).toContain('upgrade key');
    expect(fr['landing.heroSubtitle']).toContain('contrat de séquestre');
    expect(fr['landing.heroSubtitle']).toContain('clé de mise à jour');
  });
});
