/**
 * Caste from a Gujarati voter name: the last word of the name (the surname) is the caste,
 * e.g. "મહેશકુમાર પટેલ" -> "પટેલ", "દિવાળીબેન સુરેશભાઈ રબારી" -> "રબારી".
 *
 * Rolls print the same surname with small spelling differences (anusvara, long/short
 * vowels, ષ/શ, ન/ણ). Those are merged into one caste so counts and filters stay together.
 */

// Explicit spellings → the caste name to show.
const CANONICAL = {
  'વેગરાંણી': 'વેગરાણી',
  'રાજપુત': 'રાજપૂત',
  'ગોહીલ': 'ગોહિલ',
  'બિજલાણી': 'બીજલાણી',
  'બિજીલાણી': 'બીજલાણી',
  'જોશી': 'જોષી',
  'ચૌહાન': 'ચૌહાણ',
  'બ્રહ્મણ': 'બ્રાહ્મણ',
  'ગોસ્વામી': 'ગૌસ્વામી',
};

/** Loose key used to merge spelling variants that are not listed above. */
function variantKey(word) {
  return String(word || '')
    .normalize('NFC')
    .replace(/[ઁંઃ]/g, '') // candrabindu / anusvara / visarga
    .replace(/ૂ/g, 'ુ') // ૂ -> ુ
    .replace(/ી/g, 'િ') // ી -> િ
    .replace(/ષ/g, 'શ') // ષ -> શ
    .replace(/ન$/g, 'ણ') // trailing ન -> ણ
    .trim();
}

function surnameOf(name) {
  const words = String(name || '').normalize('NFC').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return '';
  return words[words.length - 1].replace(/[.,]+$/, '');
}

/**
 * @param {string} name voter name
 * @param {string[]} known existing caste names (to reuse their spelling for variants)
 */
function casteFromName(name, known = []) {
  const surname = surnameOf(name);
  if (!surname) return '';
  if (CANONICAL[surname]) return CANONICAL[surname];
  const key = variantKey(surname);
  const match = known.find((k) => variantKey(k) === key);
  if (match) return match;
  const canonicalMatch = Object.values(CANONICAL).find((v) => variantKey(v) === key);
  return canonicalMatch || surname;
}

module.exports = { casteFromName, surnameOf, variantKey };
