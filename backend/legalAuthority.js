/**
 * legalAuthority.js
 *
 * Decides how much a retrieved passage counts and whether it is current law.
 *
 *   authority  Act / Rules / Regulations > notification > circular > case law >
 *              commentary / procedure > regulator papers > expert queries > articles > books
 *   currency   a passage from, or about, an instrument that has since been replaced is not
 *              current law; nor is an article written before the governing instrument existed
 *
 * rankByAuthority() scores the reranked passages; selectContext() picks what the answer
 * model sees and in what order. Everything here is pure (no network, no database).
 */

const fs = require('fs');
const path = require('path');

const TIERS = {
  legislation: {
    rank: 1, bonus: 0.10, cap: 6, binding: true,
    label: 'Primary law (Act / Rules / Regulations): binding. This is the text of the law as amended; bracketed numbers such as 86[...] mark amendments.',
  },
  notification: {
    rank: 2, bonus: 0.07, cap: 4, binding: true,
    label: 'Notification: binding. A later notification amends or supersedes earlier text.',
  },
  circular: {
    rank: 3, bonus: 0.06, cap: 3, binding: true,
    label: 'Circular: binding on regulated entities; cannot override the Act, Rules or Regulations.',
  },
  caselaw: {
    rank: 4, bonus: 0.04, cap: 3, binding: true,
    label: 'Case law: interprets the law.',
  },
  commentary: {
    rank: 5, bonus: 0, cap: 2, binding: false,
    label: 'Commentary: editorial, not binding. Use only to explain the primary text, never as the source of a provision.',
  },
  procedure: {
    rank: 6, bonus: 0, cap: 2, binding: false,
    label: 'Procedure note: practical guidance, not a source of law.',
  },
  regulator_paper: {
    rank: 7, bonus: -0.04, cap: 2, binding: false,
    label: 'Regulator paper (consultation paper, committee report, press release or guidance note): not law. A proposal in it may never have been adopted.',
  },
  query: {
    rank: 8, bonus: -0.03, cap: 1, binding: false,
    label: 'Expert query: opinion, not binding.',
  },
  article: {
    rank: 9, bonus: -0.05, cap: 2, binding: false,
    label: 'Article: opinion, not binding, and may be out of date. Never take the wording, numbers or thresholds of a provision from it.',
  },
  book: {
    rank: 10, bonus: -0.08, cap: 1, binding: false,
    label: 'Book: editorial and undated; its edition may predate the current law. Never take the wording, numbers or thresholds of a provision from it.',
  },
};

const MAX_CONTEXT_CHUNKS = 16;
const MAX_CHUNKS_PER_DOCUMENT = 3;
// A question is usually governed by one instrument: its passages may fill the legislation quota.
const MAX_CHUNKS_PER_INSTRUMENT = 6;
const MIN_CONTEXT_CHUNKS = 4;
// Below this, even the best passage is off the point (measured: answerable questions top out
// at 0.8 or more, questions the database does not cover at 0.27 or less).
const NO_AUTHORITY_RELEVANCE = 0.30;
const PINNED_DEFINITION_SCORE = 1.2;
const SOFT_CURRENCY_PENALTY = 0.15;
const RECENT_SECONDARY_BONUS = 0.03;
const RECENT_YEARS = 3;
const AGED_TIERS = new Set(['notification', 'circular', 'regulator_paper', 'article', 'query']);
const AGE_FREE_YEARS = 5;
const AGE_PENALTY_PER_YEAR = 0.012;
const MAX_AGE_PENALTY = 0.15;
const OLD_INSTRUMENT_YEARS = 10;
const MIN_FRESH_PRIMARY = 3;
// The latest amendment to a governing instrument is worth showing even when its wording
// ("for the words fifteen months, substitute nine months") matches the question poorly.
const AMENDMENT_BONUS = 0.08;
const AMENDMENT_RELEVANCE_SHARE = 0.4;
// The query analysis named the provision that answers the question, and this passage opens
// it: it goes ahead of other passages of the instrument that merely discuss the same topic.
const NAMED_PROVISION_BONUS = 0.12;

const CURRENCY = {
  CURRENT: 'current',
  SUPERSEDED: 'superseded',
  PREDATES: 'predates_current_law',
  UNDATED: 'undated',
};

// Kinds of source that are dropped outright when they are not current. Case law decided under
// an earlier instrument can still be good authority, and an old notification may still be in
// force, so those are kept, marked and ranked lower instead.
const DROPPED_WHEN_STALE = new Set(['legislation', 'article', 'query', 'book', 'regulator_paper', 'commentary']);
const DATED_SECONDARY = new Set(['article', 'query', 'regulator_paper']);

const NON_BINDING_PAPER_RE = /consultation paper|discussion paper|committee|report\b|press release|board meeting|guidance note|draft\b|concept paper|frequently asked|faq/i;
const HISTORICAL_MODES = /POINT_IN_TIME|COMPARISON|LEGACY/i;

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

function isBook(chunk) {
  return Boolean(chunk && (chunk.is_book || chunk.source_table === 'CLA Books' || chunk.database_source === 'Pinecone_Books'));
}

function tierKeyOf(chunk) {
  if (isBook(chunk)) return 'book';
  const table = String(chunk?.source_table || '').toLowerCase();
  const title = String(chunk?.doc_title || '');
  if (table.includes('legis')) return 'legislation';
  if (table.includes('notif') || table.includes('circ')) {
    if (NON_BINDING_PAPER_RE.test(title)) return 'regulator_paper';
    return table.includes('notif') ? 'notification' : 'circular';
  }
  if (table.includes('case')) return 'caselaw';
  if (table.includes('comm')) return 'commentary';
  if (table.includes('proc')) return 'procedure';
  if (table.includes('query')) return 'query';
  return 'article';
}

// ---------------------------------------------------------------------------
// Superseded instruments
// ---------------------------------------------------------------------------

const SEBI_LONG_NAME = 'securities and exchange board of india';
const NOT_A_REPLACEMENT_RE = /amendment|removal of difficult|finance act|appropriation/i;

function titleTokens(title) {
  return String(title || '').toLowerCase().replace(new RegExp(SEBI_LONG_NAME, 'g'), 'sebi').match(/[a-z]+|\d{4}/g) || [];
}

// "SEBI (Prohibition of Insider Trading) Regulations, 2015" -> "sebi prohibition insider trading regulations"
function baseNameOf(title) {
  return titleTokens(title).filter((t) => !/^\d{4}$/.test(t) && !['the', 'of', 'and', 'for', 'in', 'to', 'a'].includes(t)).join(' ');
}

const INSTRUMENT_JOIN_RE = /\s+(?:read (?:together )?with|r\/w|along with|together with)\s+|\s*;\s*/i;

/**
 * The query analysis sometimes names the governing law as "X Regulations, 2015 read with the
 * Y Act, 1992". The first instrument is the one that governs; the rest are related.
 * @returns {string[]} [governing instrument, ...related instruments]
 */
function splitInstruments(primaryAct) {
  return String(primaryAct || '').split(INSTRUMENT_JOIN_RE).map((name) => name.replace(/^the\s+/i, '').trim()).filter(Boolean);
}

function yearOf(text) {
  const years = String(text || '').match(/\b(?:19|20)\d{2}\b/g);
  return years ? Number(years[years.length - 1]) : null;
}

function titleKey(title) {
  return titleTokens(title).filter((t) => t !== 'the').join(' ');
}

function mentionPattern(title) {
  const tokens = titleTokens(title).filter((t) => t !== 'the');
  const body = tokens.map((t) => (t === 'sebi' ? `(?:sebi|${SEBI_LONG_NAME.replace(/ /g, '\\W+')})` : t)).join('\\W+');
  return new RegExp(body, 'i');
}

/**
 * Builds the list of replaced instruments.
 *
 * @param {Object} labels   embedding/legislation_labels.json (file name -> { title })
 * @param {Array}  manual   entries of supersededInstruments.json (replacements under a new name)
 * @param {number} currentYear
 */
function buildSupersededCatalogue(labels = {}, manual = [], currentYear = new Date().getFullYear()) {
  const groups = new Map();
  for (const entry of Object.values(labels)) {
    const title = entry && entry.title;
    const year = yearOf(title);
    if (!title || !year || year > currentYear || NOT_A_REPLACEMENT_RE.test(title)) continue;
    const base = baseNameOf(title);
    if (!groups.has(base)) groups.set(base, new Map());
    groups.get(base).set(year, title);
  }

  const byTitleKey = new Map();
  const mentions = [];
  const versionsByBase = new Map();
  for (const [base, versions] of groups) {
    versionsByBase.set(base, [...versions.entries()].map(([year, title]) => ({ year, title })).sort((a, b) => a.year - b.year));
    if (versions.size < 2) continue;
    const years = [...versions.keys()].sort((a, b) => a - b);
    const latest = versions.get(years[years.length - 1]);
    for (const year of years.slice(0, -1)) {
      const title = versions.get(year);
      byTitleKey.set(titleKey(title), { title, successor: latest });
      mentions.push({ title, successor: latest, mention: mentionPattern(title), unless: mentionPattern(latest) });
    }
  }
  for (const entry of manual) {
    if (!entry || !entry.title || !entry.mention) continue;
    byTitleKey.set(titleKey(entry.title), { title: entry.title, successor: entry.successor });
    mentions.push({
      title: entry.title,
      successor: entry.successor,
      mention: new RegExp(entry.mention, 'i'),
      unless: entry.unless ? new RegExp(entry.unless, 'i') : null,
    });
  }
  return { byTitleKey, mentions, versionsByBase };
}

const AMENDMENT_TITLE_WORDS = new Set(('amendment first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth ' +
  'thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth').split(' '));

/**
 * The version of an instrument that an amendment notification amended: the latest version
 * made in or before the amendment's year. "X (Ninth Amendment) Regulations, 2013" amended
 * "X Regulations, 2000", not the "X Regulations, 2017" that later replaced it.
 * @returns {{ year: number, title: string }|null}
 */
function amendedVersion(title, year, catalogue) {
  if (!/amend/i.test(String(title || ''))) return null;
  const base = baseNameOf(title).split(' ').filter((t) => !AMENDMENT_TITLE_WORDS.has(t)).join(' ');
  const versions = catalogue.versionsByBase && catalogue.versionsByBase.get(base);
  if (!versions || !versions.length) return null;
  const amendmentYear = year || yearOf(title);
  if (!amendmentYear) return null;
  return [...versions].reverse().find((version) => version.year <= amendmentYear) || null;
}

let catalogueCache = null;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`[Legal Authority] ${path.basename(filePath)} could not be read: ${error.message}`);
    return fallback;
  }
}

function getSupersededCatalogue() {
  if (!catalogueCache) {
    const labels = readJson(path.resolve(__dirname, '../embedding/legislation_labels.json'), {});
    const manual = readJson(path.resolve(__dirname, 'supersededInstruments.json'), { instruments: [] }).instruments || [];
    catalogueCache = buildSupersededCatalogue(labels, manual);
  }
  return catalogueCache;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

function chunkYear(chunk) {
  const year = Number(String(chunk?.doc_date || '').slice(0, 4));
  return Number.isFinite(year) && year > 1900 ? year : null;
}

function chunkText(chunk) {
  return String(chunk?.chunk_body || chunk?.chunk_text || chunk?.content || chunk?.text || '');
}

/**
 * @param {Object} ctx { primaryAct, mode, question, catalogue }
 * @returns {{ historical: boolean, governingYear: number|null }}
 */
function describeRequest(ctx = {}) {
  const catalogue = ctx.catalogue || getSupersededCatalogue();
  const question = String(ctx.question || '');
  const asksAboutOldLaw = catalogue.mentions.some((m) => m.mention.test(question)) ||
    /\b(?:earlier|erstwhile|old|previous|repealed|superseded|historical|history of|prior to|before the)\b/i.test(question);
  return {
    historical: HISTORICAL_MODES.test(String(ctx.mode || '')) || asksAboutOldLaw,
    governingYear: yearOf(splitInstruments(ctx.primaryAct)[0]),
  };
}

/**
 * Whether a passage is current law.
 * @returns {{ status: string, note: string|null }}
 */
function currencyOf(chunk, ctx = {}) {
  const catalogue = ctx.catalogue || getSupersededCatalogue();
  const tier = tierKeyOf(chunk);
  const { governingYear } = ctx.request || describeRequest(ctx);

  if (tier === 'legislation') {
    const replaced = catalogue.byTitleKey.get(titleKey(chunk.law_title || chunk.doc_title));
    if (replaced) {
      return { status: CURRENCY.SUPERSEDED, note: `Replaced by ${replaced.successor}. Not current law.` };
    }
    return { status: CURRENCY.CURRENT, note: null };
  }

  if (tier === 'notification') {
    const amended = amendedVersion(chunk.doc_title, chunkYear(chunk), catalogue);
    const replaced = amended && catalogue.byTitleKey.get(titleKey(amended.title));
    if (replaced) {
      return {
        status: CURRENCY.SUPERSEDED,
        note: `Amends ${replaced.title}, since replaced by ${replaced.successor}. Not current law.`,
        drop: true,
      };
    }
  }

  const text = `${chunk.doc_title || ''} ${chunkText(chunk)}`;
  for (const entry of catalogue.mentions) {
    if (entry.mention.test(text) && !(entry.unless && entry.unless.test(text))) {
      const note = tier === 'caselaw'
        ? `Decided under ${entry.title}, since replaced by ${entry.successor}. It applies to the current law only so far as the provisions are the same.`
        : `Written about ${entry.title}, since replaced by ${entry.successor}. Not a statement of current law.`;
      return { status: CURRENCY.SUPERSEDED, note };
    }
  }

  const year = chunkYear(chunk);
  if (governingYear && year && year < governingYear && (DATED_SECONDARY.has(tier) || tier === 'notification' || tier === 'circular')) {
    return {
      status: CURRENCY.PREDATES,
      note: `Dated ${year}, before ${ctx.primaryAct} existed: it describes the earlier law, not the current position.`,
    };
  }
  if (tier === 'book') {
    return { status: CURRENCY.UNDATED, note: null };
  }
  return { status: CURRENCY.CURRENT, note: null };
}

// ---------------------------------------------------------------------------
// Defined terms
// ---------------------------------------------------------------------------

const MIN_ACRONYM_LENGTH = 3;

function termIsInQuestion(term, question) {
  const text = String(question || '').toLowerCase();
  const words = String(term || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const singular = words.map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');
  if (text.includes(words.join(' ')) || text.includes(singular)) return true;
  // "UPSI" for "unpublished price sensitive information"
  const acronym = words.map((w) => w[0]).join('');
  return acronym.length >= MIN_ACRONYM_LENGTH && new RegExp(`\\b${acronym}s?\\b`, 'i').test(String(question || ''));
}

/**
 * The defined terms whose statutory definitions are worth reading for this question.
 * A definition is read only when the question itself asks about the term ("Who is an
 * insider?", "Does it have control?"); that term becomes the root and the rest of the list
 * follows it. A threshold or procedure question that merely involves defined terms gets none.
 */
function definedTermsAskedAbout(terms, question) {
  const list = (terms || []).filter(Boolean);
  const rootIndex = list.findIndex((term) => termIsInQuestion(term, question));
  if (rootIndex === -1) return [];
  return [list[rootIndex], ...list.filter((_, index) => index !== rootIndex)];
}

// ---------------------------------------------------------------------------
// Ranking and selection
// ---------------------------------------------------------------------------

function rawRelevanceOf(chunk) {
  for (const value of [chunk.cohere_relevance_score, chunk.rerank_relevance_score, chunk.backend_relevance_score, chunk.score]) {
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Adds authority and currency to every passage and turns the reranker's relevance into a
 * ranking score. Relevance stays the main signal; authority and currency adjust it.
 */
function rankByAuthority(chunks, ctx = {}) {
  const catalogue = ctx.catalogue || getSupersededCatalogue();
  const request = describeRequest({ ...ctx, catalogue });
  const currentYear = ctx.currentYear || new Date().getFullYear();

  return (chunks || []).map((chunk) => {
    const tierKey = tierKeyOf(chunk);
    const tier = TIERS[tierKey];
    const currency = currencyOf(chunk, { ...ctx, catalogue, request });
    const relevance = rawRelevanceOf(chunk);
    const stale = currency.status === CURRENCY.SUPERSEDED || currency.status === CURRENCY.PREDATES;

    let score = chunk.pinned ? PINNED_DEFINITION_SCORE - (chunk.definition_depth || 0) * 0.01 : relevance + tier.bonus;
    if (stale && !request.historical) score -= SOFT_CURRENCY_PENALTY;
    const year = chunkYear(chunk);
    const age = year ? currentYear - year : null;
    if (!tier.binding && age !== null && age <= RECENT_YEARS) score += RECENT_SECONDARY_BONUS;
    // Dated material loses ground with age: between two circulars on one point the newer is
    // more likely to be the one in force. Acts and case law are not aged this way.
    if (AGED_TIERS.has(tierKey) && age !== null && age > AGE_FREE_YEARS && !request.historical) {
      score -= Math.min(MAX_AGE_PENALTY, (age - AGE_FREE_YEARS) * AGE_PENALTY_PER_YEAR);
    }
    if (chunk.is_amendment) score += AMENDMENT_BONUS;
    if (chunk.named_provision) score += NAMED_PROVISION_BONUS;

    let currencyNote = currency.note;
    if (!currencyNote && AGED_TIERS.has(tierKey) && age !== null && age > OLD_INSTRUMENT_YEARS) {
      currencyNote = tier.binding
        ? `Dated ${year}. Later amendments, regulations or directions may have changed this; where a newer primary passage differs, the newer one is the law.`
        : `Dated ${year}. The law may have changed since; do not rely on it for the current position.`;
    }
    if (!currencyNote && tierKey === 'legislation' && chunk.last_amended) {
      currencyNote = `Current instrument. This text carries amendments up to ${chunk.last_amended} (the latest recorded in it).`;
    }
    if (!currencyNote && chunk.is_amendment && year) {
      currencyNote = `Recent amendment (${year})${chunk.governing_instrument ? ` to ${chunk.governing_instrument}` : ''}. It changes only the provisions it names: where it alters a provision the question turns on, it is the current position; otherwise the instrument itself governs.`;
    }

    return {
      ...chunk,
      // A statutory definition read from the governing instrument is on point by construction.
      ...(chunk.pinned ? { cohere_relevance_score: 1 } : {}),
      authority_tier: tierKey,
      authority_rank: tier.rank,
      authority_label: tier.label,
      currency_status: currency.status,
      currency_note: currencyNote,
      relevance,
      backend_relevance_score: score,
      // Not current, and of a kind that must not reach the answer as if it were.
      excluded_as_stale: stale && !request.historical && (DROPPED_WHEN_STALE.has(tierKey) || currency.drop === true),
      age_years: age,
      excluded_as_unverified: tierKey === 'legislation' && chunk.title_verified === false,
    };
  });
}

function documentKeyOf(chunk) {
  if (isBook(chunk)) return `book|${chunk.file_name || chunk.doc_title}|${chunk.page_number || chunk.parent_id || ''}`;
  return `${chunk.source_table}|${chunk.record_id}`;
}

/**
 * Picks the passages the answer is written from.
 *
 * @param {Array}  ranked   output of rankByAuthority()
 * @param {Object} options  { usableBooks: Set<string>|null, relevanceIsCalibrated: boolean }
 * @returns {{ context: Array, stats: Object }}
 */
function selectContext(ranked, options = {}) {
  const usableBooks = options.usableBooks || null;
  const calibrated = options.relevanceIsCalibrated !== false;
  // A definition read from a replaced instrument is as stale as any other passage of it.
  const pinned = ranked.filter((c) => c.pinned && !c.excluded_as_stale);
  const searched = ranked.filter((c) => !c.pinned);

  const stats = {
    candidates: searched.length,
    pinnedDefinitions: pinned.length,
    droppedStale: ranked.filter((c) => c.pinned && c.excluded_as_stale).length,
    droppedUnverifiedLegislation: 0,
    droppedInaccessibleBooks: 0,
    droppedLowRelevance: 0,
    topRelevance: searched.reduce((max, c) => Math.max(max, c.relevance), 0),
    nothingOnPoint: false,
  };

  const eligible = searched.filter((c) => {
    if (c.excluded_as_stale) { stats.droppedStale += 1; return false; }
    if (c.excluded_as_unverified) { stats.droppedUnverifiedLegislation += 1; return false; }
    if (c.authority_tier === 'book' && usableBooks && !usableBooks.has(String(c.file_name || ''))) {
      stats.droppedInaccessibleBooks += 1;
      return false;
    }
    return true;
  });

  const topEligible = eligible.reduce((max, c) => Math.max(max, c.relevance), 0);
  stats.nothingOnPoint = pinned.length === 0 && calibrated && topEligible < NO_AUTHORITY_RELEVANCE;
  if (stats.nothingOnPoint) return { context: [], stats };

  const minRelevance = calibrated ? Math.max(0.12, topEligible * 0.4) : Math.max(0.20, topEligible * 0.35);
  stats.minRelevance = minRelevance;
  let relevant = eligible.filter((c) => c.relevance >= (c.is_amendment ? minRelevance * AMENDMENT_RELEVANCE_SHARE : minRelevance));
  stats.droppedLowRelevance = eligible.length - relevant.length;
  if (relevant.length < MIN_CONTEXT_CHUNKS) {
    // A very strong single hit must not starve the answer of supporting context.
    relevant = [...eligible].sort((a, b) => b.relevance - a.relevance).slice(0, Math.min(MIN_CONTEXT_CHUNKS, eligible.length));
  }

  // A circular, notification or article more than ten years old is a last resort: when
  // enough current primary law is on point, it is left out rather than set beside newer
  // text it may contradict.
  if (!options.historical) {
    const isOldInstrument = (c) => AGED_TIERS.has(c.authority_tier) && !c.is_amendment &&
      c.age_years !== null && c.age_years !== undefined && c.age_years > OLD_INSTRUMENT_YEARS;
    const freshPrimary = relevant.filter((c) => TIERS[c.authority_tier].rank <= TIERS.circular.rank && !isOldInstrument(c)).length;
    if (freshPrimary >= MIN_FRESH_PRIMARY) {
      const before = relevant.length;
      relevant = relevant.filter((c) => !isOldInstrument(c));
      stats.droppedOldInstruments = before - relevant.length;
    }
  }

  const perTier = {};
  const perDocument = {};
  const kept = [];
  for (const chunk of [...relevant].sort((a, b) => b.backend_relevance_score - a.backend_relevance_score)) {
    if (kept.length >= MAX_CONTEXT_CHUNKS) break;
    const tier = chunk.authority_tier;
    const documentKey = documentKeyOf(chunk);
    if ((perTier[tier] || 0) >= TIERS[tier].cap) continue;
    const documentCap = tier === 'legislation' ? MAX_CHUNKS_PER_INSTRUMENT : MAX_CHUNKS_PER_DOCUMENT;
    if ((perDocument[documentKey] || 0) >= documentCap) continue;
    perTier[tier] = (perTier[tier] || 0) + 1;
    perDocument[documentKey] = (perDocument[documentKey] || 0) + 1;
    kept.push(chunk);
  }

  // Order the model reads them in: statutory definitions, then by authority, then by score.
  const byAuthority = (a, b) => (a.authority_rank - b.authority_rank) || (b.backend_relevance_score - a.backend_relevance_score);
  const context = [
    ...[...pinned].sort((a, b) => (a.definition_depth || 0) - (b.definition_depth || 0)),
    ...kept.sort(byAuthority),
  ];
  stats.perTier = perTier;
  return { context, stats };
}

module.exports = {
  TIERS,
  CURRENCY,
  NO_AUTHORITY_RELEVANCE,
  tierKeyOf,
  yearOf,
  splitInstruments,
  buildSupersededCatalogue,
  getSupersededCatalogue,
  amendedVersion,
  describeRequest,
  definedTermsAskedAbout,
  currencyOf,
  rankByAuthority,
  selectContext,
};
