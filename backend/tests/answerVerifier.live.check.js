/**
 * Live check of the citation and currency verifier (calls the verifier model).
 *
 * Each case is a draft answer containing one sentence that must not survive: a figure that a
 * later amendment replaced, a threshold from a superseded instrument, a proposition the cited
 * article does not contain, a compliance class passed off as a statutory category, and an
 * uncited figure no passage states. The sound sentences beside them must survive.
 *
 *   node tests/answerVerifier.live.check.js      (in backend/, needs OPENAI_API_KEY)
 */
require('dotenv').config();
const { verifyAnswer } = require('../answerVerifier');
const { getLLMProvider } = require('../llm/factory');
const { settings } = require('../config');

const generate = (request) => getLLMProvider('openai', settings.OPENAI_MODEL || 'gpt-4.1-mini').generate(request);
const LEGISLATION = 'Primary law (Act / Rules / Regulations): binding.';
const ARTICLE = 'Article: opinion, not binding, and may be out of date.';

const CASES = [
  {
    name: 'a later amendment conflicts with the older text: the newer effective provision wins',
    results: [
      { source_table: 'Legislation', doc_title: 'Foreign Exchange Management (Export of Goods and Services) Regulations, 2015', authority_label: LEGISLATION,
        chunk_body: '9. Period within which export value of goods/software/services to be realised. (1) The amount representing the full export value of goods / software/ services exported shall be realised and repatriated to India within fifteen months from the date of export.' },
      { source_table: 'Notifications', doc_title: 'Foreign Exchange Management (Export of Goods and Services) (First Amendment) Regulations, 2026', doc_date: '2026-06-06',
        authority_label: 'Notification: binding. A later notification amends or supersedes earlier text.',
        currency_note: 'Recent amendment (2026) to Foreign Exchange Management (Export of Goods and Services) Regulations 2015.',
        chunk_body: 'In the Foreign Exchange Management (Export of Goods and Services) Regulations, 2015, in regulation 9, in sub-regulation (1), for the words "fifteen months", the words "nine months" shall be substituted. These regulations shall come into force on the date of their publication in the Official Gazette.' },
    ],
    answer: '## Overview\nRegulation 9 governs the period for realising export proceeds [Source 1].\n\n## Analysis\nThe full export value must currently be realised and repatriated within fifteen months from the date of export [Source 1]. The 2026 amendment substituted nine months for fifteen months in Regulation 9(1) [Source 2].\n\n## Conclusion\nThe realisation period is nine months from the date of export [Source 2].',
    mustGo: /currently be realised and repatriated within fifteen months/,
    mustStay: [/substituted nine months for fifteen months/, /The realisation period is nine months/],
  },
  {
    name: 'a threshold from a superseded instrument is not stated as current law',
    results: [
      { source_table: 'Legislation', doc_title: 'SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011', authority_label: LEGISLATION,
        chunk_body: '3. Substantial acquisition of shares or voting rights. (1) No acquirer shall acquire shares or voting rights in a target company which taken together with shares or voting rights, if any, held by him and by persons acting in concert with him in such target company, entitle them to exercise twenty-five per cent or more of the voting rights in such target company unless the acquirer makes a public announcement of an open offer.' },
      { source_table: 'Articles', doc_title: 'Takeover Code - an overview', doc_date: '2009-05-01', authority_label: ARTICLE,
        currency_note: 'Written about SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 1997, since replaced by SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011. Not a statement of current law.',
        chunk_body: 'Under regulation 10 of the Takeover Regulations, 1997 an acquirer who acquires fifteen per cent or more of the voting rights in a company must make a public announcement to acquire shares.' },
    ],
    answer: '## Overview\nAn open offer is required once an acquirer crosses the statutory threshold [Source 1].\n\n## Analysis\nAn acquirer must make a public announcement of an open offer on acquiring fifteen per cent or more of the voting rights [Source 2]. Regulation 3(1) sets the trigger at twenty-five per cent or more of the voting rights [Source 1].\n\n## Conclusion\nThe trigger is twenty-five per cent of the voting rights [Source 1].',
    mustGo: /fifteen per cent or more of the voting rights/,
    mustStay: [/Regulation 3\(1\) sets the trigger at twenty-five per cent/],
  },
  {
    name: 'a cited commentary that does not contain the proposition does not carry it',
    results: [
      { source_table: 'Legislation', doc_title: 'Companies Act 2013', authority_label: LEGISLATION, provision_ref: 'Section 2(27)',
        chunk_body: '(27) "control" shall include the right to appoint majority of the directors or to control the management or policy decisions exercisable by a person or persons acting individually or in concert, directly or indirectly, including by virtue of their shareholding or management rights or shareholders agreements or voting agreements or in any other manner;' },
      { source_table: 'CLASE_Commentary', doc_title: 'Commentary on section 2(27)', authority_label: 'Commentary: editorial, not binding.',
        chunk_body: 'The definition of control is inclusive. Courts have looked at the substance of the rights conferred rather than the form of the agreement.' },
    ],
    answer: '## Overview\nSection 2(27) defines control inclusively [Source 1].\n\n## Analysis\nControl includes the right to appoint a majority of the directors or to control management or policy decisions [Source 1]. A shareholder holding twenty-six per cent of the shares is always treated as being in control [Source 2]. The definition is inclusive and substance prevails over form [Source 2].\n\n## Conclusion\nControl turns on the rights held, not on a shareholding figure [Source 1].',
    mustGo: /twenty-six per cent of the shares is always treated/,
    mustStay: [/Control includes the right to appoint a majority/, /substance prevails over form/],
  },
  {
    name: 'a compliance class is not accepted as a category of a defined term, and the correct framing is kept',
    results: [
      { source_table: 'Legislation', doc_title: 'SEBI (Prohibition of Insider Trading) Regulations, 2015', authority_label: LEGISLATION, provision_ref: 'Regulation 2(1)(g)', defined_term: 'insider',
        chunk_body: '(g) "insider" means any person who is: i) a connected person; or ii) in possession of or having access to unpublished price sensitive information;' },
      { source_table: 'Legislation', doc_title: 'SEBI (Prohibition of Insider Trading) Regulations, 2015', authority_label: LEGISLATION,
        chunk_body: 'The board of directors shall in consultation with the compliance officer specify the designated persons to be covered by the code of conduct on the basis of their role and function in the organisation and the access that such role and function would provide to unpublished price sensitive information.' },
    ],
    answer: '## Overview\nRegulation 2(1)(g) defines an insider as a connected person or a person in possession of or having access to unpublished price sensitive information [Source 1].\n\n## Analysis\nDesignated persons are a third category of insider under the Regulations [Source 2]. Designated persons are specified by the board for the code of conduct on the basis of role and access to unpublished price sensitive information [Source 2]. That is a compliance category: a designated person is an insider only if one of the two limbs of the definition is met [Source 1].\n\n## Conclusion\nDesignation does not by itself make a person an insider [Source 1].',
    mustGo: /third category of insider/,
    mustStay: [/That is a compliance category/, /specified by the board for the code of conduct/],
  },
  {
    name: 'a discussion paper is not cited as settled law, but may be cited as what it is',
    results: [
      { source_table: 'Legislation', doc_title: 'SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011', authority_label: LEGISLATION, authority_tier: 'legislation', provision_ref: 'Regulation 2(1)(e)',
        chunk_body: '(e) "control" includes the right to appoint majority of the directors or to control the management or policy decisions exercisable by a person or persons acting individually or in concert, directly or indirectly, including by virtue of their shareholding or management rights or shareholders agreements or voting agreements or in any other manner.' },
      { source_table: 'Circular', doc_title: 'Discussion Paper on "Brightline Tests for Acquisition of Control under SEBI Takeover Regulations"', doc_date: '2016-03-16', authority_tier: 'regulator_paper',
        authority_label: 'Regulator paper (consultation paper, committee report, press release or guidance note): not law. A proposal in it may never have been adopted.',
        chunk_body: 'It is proposed that veto rights not amounting to acquisition of control may be protective in nature rather than participative, i.e. such rights may be aimed at protecting the investment of the investor and not at day to day running of the business.' },
    ],
    answer: '## Overview\nRegulation 2(1)(e) defines control to include the right to appoint a majority of the directors or to control management or policy decisions [Source 1].\n\n## Analysis\nVeto rights that protect an investment are protective rights and do not amount to control [Source 2]. A SEBI discussion paper proposed that veto rights aimed at protecting the investment, and not at the day to day running of the business, be treated as protective rather than participative [Source 2]. The definition is inclusive and turns on the rights actually held [Source 1][Source 2].\n\n## Conclusion\nControl depends on the right to appoint a majority of directors or to control management or policy decisions [Source 1].',
    mustGo: /are protective rights and do not amount to control \[Source 2\]/,
    mustStay: [/A SEBI discussion paper proposed that veto rights/, /turns on the rights actually held \[Source 1\]\./],
  },
  {
    name: 'a figure stated without any citation is checked and removed when no passage states it',
    results: [
      { source_table: 'Legislation', doc_title: 'Foreign Exchange Management (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019', authority_label: LEGISLATION,
        chunk_body: 'An Indian company issuing equity instruments to a person resident outside India shall report such issue in Form FC-GPR, not later than thirty days from the date of issue of equity instruments. 5. Delays in reporting. The person or entity responsible for filing the reports shall be liable for payment of late submission fee, as may be decided by the Reserve Bank, in consultation with the Central Government, for any delays in reporting.' },
    ],
    answer: '## Overview\nForm FC-GPR must be filed within thirty days of the issue of equity instruments.\n\n## Analysis\nDelay in reporting attracts a late submission fee decided by the Reserve Bank [Source 1]. The late submission fee is capped at 7.5 per cent of the amount involved. The fee is paid by the person responsible for filing the report [Source 1].\n\n## Conclusion\nThe company regularises the delay by paying the late submission fee [Source 1].',
    mustGo: /capped at 7\.5 per cent/,
    mustStay: [/Delay in reporting attracts a late submission fee/, /within thirty days of the issue of equity instruments \[Source 1\]/],
  },
];

(async () => {
  let failed = 0;
  for (const testCase of CASES) {
    const { answer, stats } = await verifyAnswer({ answer: testCase.answer, results: testCase.results, generate });
    const gone = !testCase.mustGo.test(answer);
    const kept = testCase.mustStay.filter((pattern) => !pattern.test(answer));
    const pass = gone && kept.length === 0 && !stats.error;
    if (!pass) failed += 1;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name}`);
    console.log(`      removed: ${JSON.stringify((stats.removedSentences || []).map((r) => `${r.verdict}: ${r.sentence.slice(0, 70)}`))}  attributed: ${stats.uncitedAttributed || 0}`);
    if (!gone) console.log('      the unsound sentence survived');
    if (kept.length) console.log(`      sound sentence(s) lost: ${kept.map(String).join(' ')}`);
    if (stats.error) console.log(`      error: ${stats.error}`);
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} verifier cases passed`);
  process.exit(failed ? 1 : 0);
})();
