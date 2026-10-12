/**
 * legalFigures.js
 *
 * Reads the figures a legal sentence turns on (a threshold, a time limit) so they can be
 * compared with the passages cited for them. Statutes write "twenty-five per cent" and
 * "one hundred and eighty-two days"; answers write "25%" and "182 days". Both are reduced
 * to the same form: { number: '25', unit: 'percent' }.
 *
 * Pure functions.
 */

const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const UNIT_WORDS = Object.keys(UNITS).join('|');
const TEEN_WORDS = Object.keys(TEENS).join('|');
const TEN_WORDS = Object.keys(TENS).join('|');
const BELOW_HUNDRED = `(?:(?:${TEN_WORDS})(?:[\\s-]+(?:${UNIT_WORDS}))?|${TEEN_WORDS}|${UNIT_WORDS})`;
const NUMBER_WORDS_RE = new RegExp(`\\b(?:(${UNIT_WORDS})\\s+hundred(?:\\s+and)?(?:\\s+(${BELOW_HUNDRED}))?|(${BELOW_HUNDRED}))\\b`, 'gi');

function belowHundred(words) {
  const parts = String(words || '').toLowerCase().split(/[\s-]+/).filter(Boolean);
  let value = 0;
  for (const part of parts) value += TENS[part] || TEENS[part] || UNITS[part] || 0;
  return value;
}

/** "twenty-five per cent within one hundred and eighty-two days" -> "25 per cent within 182 days" */
function digitsIn(text) {
  return String(text || '').toLowerCase().replace(NUMBER_WORDS_RE, (match, hundreds, rest, small) => {
    if (hundreds) return String(UNITS[hundreds.toLowerCase()] * 100 + belowHundred(rest));
    return String(belowHundred(small));
  });
}

const FIGURE_RE = /(\d+(?:\.\d+)?)\s*(%|per\s*cent|percent|days?|weeks?|months?|years?)/g;

function unitOf(raw) {
  return /%|per/.test(raw) ? 'percent' : raw.replace(/s$/, '');
}

/** The figures with a unit in a sentence: [{ number, unit }], each once. */
function figuresIn(text) {
  const seen = new Set();
  const figures = [];
  for (const match of digitsIn(text).matchAll(FIGURE_RE)) {
    const figure = { number: match[1], unit: unitOf(match[2]) };
    const key = `${figure.number} ${figure.unit}`;
    if (!seen.has(key)) {
      seen.add(key);
      figures.push(figure);
    }
  }
  return figures;
}

/** Whether `text` (already passed through digitsIn) states the figure. */
function statesFigure(normalizedText, figure) {
  const unit = figure.unit === 'percent' ? '(?:%|per\\s*cent|percent)' : `${figure.unit}s?`;
  return new RegExp(`(?<![\\d.])${figure.number.replace('.', '\\.')}\\s*${unit}`).test(normalizedText);
}

module.exports = { digitsIn, figuresIn, statesFigure };
