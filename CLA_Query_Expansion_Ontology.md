# CLA Query Expansion Ontology — Companies Act "Control" + FEMA (India)

This is the single ontology used by the Query_Expansion_Agent. It combines two sources:

- **Section CA — Companies Act, 2013 / SEBI SAST: the concept of "Control"** (source: "Companies Act control — updated pt 2").
- **Section FEMA — A Working Ontology of FEMA (India)** (source: "FEMA ontology — updated").

Use it to traverse from the user's facts to the governing concepts, instruments, sections, rules, regulations, forms and authorities, and to build the search plan. The two parts are linked: the definition of "control" is shared across the Companies Act (Section 2(27)), SEBI SAST (Regulation 2(1)(e)) and FEMA (FEMA Part G.1 ownership-and-control test, G.2 FOCC/downstream investment). A question about control over an Indian company may engage all three.

---

# SECTION CA. COMPANIES ACT, 2013 AND SEBI SAST — THE CONCEPT OF "CONTROL"

## CA.1 Why control matters

The concept of "control" is important under the Companies Act, 2013 and, for listed companies, the SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011 ("SAST Regulations"). Section 2(27) of the Companies Act and Regulation 2(1)(e) of the SAST Regulations define control broadly to include the ability to appoint directors or control management or policy decisions. Thus, control may arise through shareholding, voting rights, management rights or contractual arrangements, rather than shareholding percentage alone.

## CA.2 The definition (two parallel instruments)

| Instrument | Provision | Definition of "control" | Applies to |
|---|---|---|---|
| Companies Act, 2013 | Section 2(27) | Includes the right to appoint a majority of the directors or the ability to control the management or policy decisions of a company, directly or indirectly, through shareholding, management rights, shareholders' agreements, voting agreements or otherwise | All companies |
| SEBI (SAST) Regulations, 2011 | Regulation 2(1)(e) | Substantially similar: covers the right to appoint a majority of directors or the ability to control management or policy decisions through shareholding, management rights, shareholders' agreements, voting agreements or other arrangements | Listed companies (takeover regime) |

Inference: where the question concerns a **listed** company, the SAST Regulations are directly relevant alongside Section 2(27); for an unlisted company, Section 2(27) is the anchor.

## CA.3 Control does not require majority shareholding

50% ownership is not a fixed threshold for determining control. The relevant question is whether the person's rights give them the ability to influence or determine how the company is managed or how important policy decisions are made.

Inference: a minority shareholder (for example, an investor holding 18%) may still exercise control if it has the contractual right to appoint key directors or determine important management or policy decisions. The shareholding percentage by itself neither establishes nor excludes control.

## CA.4 Routes by which control arises

1. **Control through legal rights** — legally enforceable rights, such as the right to appoint a majority of the Board, expressly recognised in Section 2(27) of the Companies Act, 2013 and Regulation 2(1)(e) of the SAST Regulations.
2. **Control through voting or contractual rights** — voting rights attached to shareholding, shareholders' agreements, voting agreements or other arrangements, where those rights enable a person to control the company's management or policy decisions.

## CA.5 Positive rights vs. protective (negative) rights — the decisive distinction

| Positive (control) rights | Protective / negative (investor-protection) rights |
|---|---|
| Enable a person to **direct** management or policy decisions | Merely allow a person to **prevent** specified decisions |
| e.g. right to appoint or remove directors, determine senior management, direct strategy, exercise substantive influence over management or policy decisions | e.g. consent/veto before a major acquisition, substantial borrowings, or other specified fundamental changes affecting the investor's investment |
| Stronger basis for treating the holder as exercising control despite a minority stake | May not, by themselves, establish control |

Not every contractual right amounts to control. The question is whether the rights allow the investor to positively influence or direct the company's affairs. The assessment depends on the nature, extent and practical effect of the rights **as a whole**, rather than merely the shareholding percentage or the existence of veto provisions in the shareholders' agreement.

## CA.6 Judicial authority (by analogy)

- **ArcelorMittal India Pvt. Ltd. v. Satish Kumar Gupta** (Supreme Court) — decided in the context of Section 29A of the Insolvency and Bankruptcy Code, 2016. The Supreme Court's discussion of "control" distinguishes **positive control** (power to direct management or policy decisions) from **negative or protective rights** (power merely to block specified decisions). It is used **by analogy** when assessing whether contractual rights held by a minority investor amount to control under the Companies Act / SAST Regulations; it is not a direct holding under those instruments.

## CA.7 Consequences of a finding of control

If a person's contractual, voting, board or management rights give them real and positive influence over management or policy decisions, the authorities may treat them as exercising control and apply the resulting Companies Act and SEBI obligations (for a company with non-resident investors, also consider the FEMA foreign-controlled status — see FEMA Part G.1 and G.2).

## CA.8 Connections and expansion anchors

- Concept nodes: control; positive control vs negative/protective rights; veto rights; affirmative vote matters; board nomination rights; shareholders' agreement (SHA); voting agreement; minority investor; management or policy decisions; right to appoint majority of directors.
- Statutory anchors: Section 2(27) Companies Act, 2013; Regulation 2(1)(e) SEBI SAST Regulations, 2011; Section 29A IBC, 2016 (by analogy).
- Cross-links: FEMA Part G.1 (ownership and control two-limb test), G.2 (foreign-owned or controlled company, downstream investment, Rule 23 NDI Rules), G.3 (total foreign investment), G.7 (beneficial ownership, land-border rule).
- Case anchor: ArcelorMittal India Pvt. Ltd. v. Satish Kumar Gupta (SC).

## CA.9 Model resolution (worked example)

Question: Can someone be considered to have control over a listed company even if they own much less than 50% of its shares? What kind of rights would be enough to give them control?

Resolution path: listed company → Section 2(27) Companies Act + Regulation 2(1)(e) SAST → 50% is not a threshold → classify each right as positive (appoint/remove directors, determine senior management, direct strategy) or protective (consent for major acquisition, substantial borrowings, fundamental changes) → apply ArcelorMittal positive/negative distinction by analogy → assess rights as a whole → if real and positive influence exists, control (and its Companies Act / SEBI consequences) follows despite a minority stake.

References: Companies Act, 2013; SEBI (Substantial Acquisition of Shares and Takeovers) Regulations, 2011; ArcelorMittal India Pvt. Ltd. v. Satish Kumar Gupta.

---

# SECTION FEMA. A WORKING ONTOLOGY OF FEMA (INDIA)

(Parts A to M below belong to the FEMA section; "Part I" below means FEMA Part I — Reporting and Forms.)

### Reference for navigating foreign-exchange law by concept rather than by index

This document is a map of FEMA concepts and the connections between them. It is not a summary of the statute. Each section defines a class of thing (a source of law, a person, a transaction, an intermediary, a concept, an enforcement event), states what it means in plain terms, and identifies what it connects to and what can be inferred from it.

The intended use is reasoning by traversal. Given a fact such as "a Delaware LLC wants to buy shares in an Indian company," the reader should be able to move through the graph: a Delaware LLC is a person resident outside India; the acquisition of equity is a capital account transaction; capital account transactions are prohibited by default; they are permitted only through the Non-Debt Instruments Rules; the price must meet the Rule 21 floor certified by a valuer; the transaction is routed through an Authorised Dealer bank; it is reported on Form FC-GPR. Each step is defined below so that the traversal can be performed without external context.

The document has two layers. Parts A to L set out the ontology: the concepts and their connections, kept navigational. Part M is a detail layer that records the mechanics of each instrument, meaning the shape of its tests, gates, and formulas. On figures, the document follows one rule: a number that determines transaction structure or the answer (a threshold that flips an approval route, a classification threshold, a realisation window, a statutory penalty) is stated in the text, always with a verification pointer, because a reader cannot resolve the question without it. A number that is purely operational and changes constantly (a full sectoral cap table, an exact cost spread, a fee schedule) is described in shape and pointed to the live source rather than reproduced. Every figure, whether stated or pointed, carries the marker "[verify: live source]", because all of them are subject to amendment.

## PART A. STRUCTURE OF THE LAW

FEMA is a layered set of instruments. The most common error in reading it is treating the layers as interchangeable. They differ by who makes them, what authority they carry, and what function they serve. The layer from which a proposition is drawn must always be identified.

### A.1 The four layers

| Layer | Instrument | Made by | Force | Function |
|---|---|---|---|---|
| 1 | The Act (FEMA, 1999) | Parliament | Primary legislation; binding | Sets the framework, defines core terms, confers power to make everything below |
| 2 | Rules | Central Government (Ministry of Finance) | Subordinate legislation; binding | Govern current account transactions, compounding, adjudication, and non-debt instruments |
| 3 | Regulations | Reserve Bank of India (RBI) | Subordinate legislation; binding | Govern capital account transactions, trade, deposits, derivatives, and most operational matters |
| 4 | Master Directions | RBI | Directions to Authorised Persons; binding on them; consolidated guidance | Compile and explain how the Rules and Regulations operate in practice |

### A.2 Division of labour between the two rule-makers

Two authorities make subordinate law, and their competences are separated.

The Central Government makes Rules for: current account transactions, compounding proceedings, adjudication proceedings, and non-debt instruments, meaning equity-type inbound investment.

The RBI makes Regulations for: capital account transactions generally, trade (export and import), deposits, borrowing and lending, guarantees, derivatives, money-changing, and debt instruments.

Inference: a proposition about equity foreign direct investment or about immovable property held by non-residents is governed by a Rule (the Non-Debt Instruments Rules, made by the Central Government), even though such subjects are commonly associated with the RBI. This reallocation took effect in 2019 and is a frequent source of error. The RBI's residual role for FDI is confined to the mode of payment and reporting, which remains a Regulation.

### A.3 Relationship between the layers

A Master Direction does not override a Rule or Regulation. Where they conflict, the Rule or Regulation prevails. The Master Direction is a consolidated operational source. It explains how the underlying Rules and Regulations operate in practice but does not override them.

A Master Direction is maintained continuously. The RBI amends it in place when the underlying law changes and records the date of each update. When citing a Master Direction, the update date carries the same weight as the title.

When a Master Direction is issued on a topic, the earlier Master Circular on that topic is withdrawn.

## PART B. FUNCTION OF FEMA

The following framing facts determine the default rules that follow.

FEMA manages foreign exchange. It replaced the Foreign Exchange Regulation Act, 1973 (FERA), and the change of terminology is substantive. FEMA is a civil statute. Contraventions are not offences, which is a significant departure from FERA. Contraventions attract monetary penalties. Imprisonment may arise only in connection with failure to pay a penalty imposed under FEMA.

Stated objects: to facilitate external trade and payments, and to promote the orderly development and maintenance of the foreign-exchange market in India.

Two enforcement bodies with distinct functions:

The RBI is the regulator. It frames regulations, authorises intermediaries, and handles compounding (voluntary settlement).

The Enforcement Directorate (ED) is the enforcer. It investigates and adjudicates contraventions. It sits under the Department of Revenue, Ministry of Finance.

The organising distinction of the Act: every cross-border transaction is either a current account transaction or a capital account transaction. Most downstream questions follow from this classification, because the two categories carry opposite default rules (see Part D). A transaction that cannot be classified into one of these categories cannot be matched to the correct instrument.

## PART C. THE PERSON AND RESIDENCY ONTOLOGY

Residency under FEMA is the pivot on which the Act turns, and it does not follow ordinary intuition. This section sets out the classifications and the inferences they support.

### C.1 Residency is distinct from citizenship and nationality

FEMA classifies every actor as one of two things:

Person Resident in India (PRII).

Person Resident Outside India (PROI), defined as anyone who is not a PRII.

Residency is determined by presence and intention, not by passport. An Indian citizen may be a PROI; a foreign citizen may be a PRII. Residency should not be inferred from nationality.

### C.2 Classification of a natural person

A person is a PRII if resident in India for more than 182 days during the preceding financial year, except where the person:

left India for employment, business, or a stay of uncertain duration, in which case the person becomes a PROI (even if present for more than 182 days in the preceding year); or came to India for employment, business, or a stay of uncertain duration, in which case the person becomes a PRII (even if present for fewer than 182 days).

Inferences for individuals:

An engineer who moved abroad last month for a job becomes a PROI from the date of departure, regardless of the 182-day count. Intention to remain abroad changes residency immediately.

A foreign national who relocated to India to run a company is a PRII. The foreign passport is not relevant.

A person who goes abroad for studies may be treated as a PROI where the circumstances indicate an intention to stay outside India for an uncertain period

### C.3 Classification of a legal person

For entities the test is the place of incorporation or registration.

Incorporated in India: PRII, regardless of who owns or controls it. An Indian subsidiary wholly owned by a foreign parent remains a PRII.

Incorporated outside India: PROI, regardless of who owns it. A company incorporated abroad but owned by Indian citizens remains a PROI.

Inferences for entities, to be stated explicitly:

A company incorporated in the United States, Singapore, or any jurisdiction outside India is a person resident outside India.

A private limited company registered in India is a PRII, even where it is a wholly owned subsidiary of a foreign multinational.

A limited liability partnership formed in India is a PRII.

An office, branch or agency outside India of a person resident in India is subject to the specific FEMA treatment applicable to such overseas establishments and should not be classified solely by location.

The residency label attaches to both sides of a transaction, and the classification of the transaction depends on it. If the residency labels are wrong, every subsequent inference is wrong. Note the further point developed in Part G: an Indian company (a PRII) that is itself foreign-owned or controlled is treated, for investment purposes, as if it were foreign when it invests further downstream. Residency and the ownership-and-control test are two separate lenses, and both must be applied.

### C.4 Sub-classes of PROI

PROI is a category with sub-classes, and different instruments confer different rights on each.

NRI (Non-Resident Indian): a Person Resident Outside India who is a citizen of India.

OCI (Overseas Citizen of India): a foreign citizen who is registered as an OCI cardholder. FEMA provisions may confer certain investment and property rights on OCIs broadly similar to those available to NRIs, subject to the specific applicable rules.

PIO (Person of Indian Origin): an older category whose separate OCI card scheme was merged into the OCI card scheme; references to PIO may therefore appear in legacy provisions or materials.

FPI, FVCI, foreign central banks, and sovereign wealth funds: institutional PROI sub-classes with their own investment schedules under the Non-Debt Instruments Rules and the Debt Instruments Regulations.

Inference: "NRI" implies a PROI who is an Indian citizen with enhanced deposit and property rights. "Foreign company" implies a PROI with no origin link and the narrowest set of rights. The sub-class determines what is permitted; PROI should not be treated as uniform.

### C.5 Residency of accounts and money

Residency also attaches to accounts and to funds, which feeds the deposit ontology in Part F.6.

NRE (Non-Resident External) account: a rupee-denominated account maintained by an eligible non-resident, with balances generally freely repatriable, subject to the applicable rules on permitted credits and debits.

NRO (Non-Resident Ordinary) account: a rupee-denominated account used for permitted transactions in India; balances are subject to the applicable restrictions and conditions on repatriation.

FCNR(B) (Foreign Currency Non-Resident (Bank)) account: a foreign-currency-denominated term deposit maintained by an eligible non-resident.

Repatriation: the buying or drawing of foreign exchange from an Authorised Dealer in India and remitting it outside India, or crediting it to a foreign-currency or non-resident account from which it may be sent out. "Freely repatriable" means the funds may leave India without further permission. Whether proceeds are repatriable is among the most frequently contested questions in any transaction.

## PART D. THE TRANSACTION ONTOLOGY

Every transaction is either a current account transaction or a capital account transaction, and the two carry opposite defaults.

### D.1 The two categories and their defaults

|  | Current account transaction | Capital account transaction |
|---|---|---|
| Governed by | Rules (Central Government): Current Account Transactions Rules, 2000 | Regulations (RBI), and the Non-Debt Instruments Rules for equity |
| Default | Permitted unless expressly restricted or prohibited | Prohibited unless expressly permitted |
| Test | A transaction that is not a capital account transaction and relates to payments of a current nature, such as payments connected with foreign trade, services, interest, living expenses and remittances. | A transaction that alters the assets or liabilities, including contingent liabilities, outside India of persons resident in India, or the assets or liabilities in India of persons resident outside India. |
| Ordinary examples | Payments for travel, imports, fees, dividends | Shares, property, loans, deposits |

Inference: if a transaction alters an asset or liability position across the border (acquiring foreign shares, taking a foreign loan, acquiring property abroad), it is a capital account transaction and is presumptively prohibited; the enabling regulation must be found. If the transaction is a payment for goods, services, or living expenses (an import invoice, tuition, a medical bill, business travel, a dividend remittance), it is a current account transaction and is presumptively free; only the restricted and prohibited lists need to be checked.

### D.2 Current account transactions

Because the default is permission, the law operates by listing exceptions in three schedules to the Current Account Transactions Rules, 2000.

Schedule I: prohibited transactions (for example, remittance of lottery winnings, income from racing, and the purchase of lottery tickets or proscribed publications).

Schedule II: transactions requiring prior Government approval (for example, certain cultural tours and advertisements in foreign media by specified bodies).

Schedule III: transactions requiring RBI approval above monetary limits, and transactions falling under the Liberalised Remittance Scheme for resident individuals.

Inference: for a current account item, first determine whether it is prohibited under Schedule I, requires prior Government approval under Schedule II, or requires RBI approval/otherwise falls within the conditions specified in Schedule III. If none of these restrictions applies, the transaction is generally permitted, subject to compliance with any other applicable FEMA requirements and the prescribed banking channels.

### D.3 The Liberalised Remittance Scheme (LRS)

LRS permits a resident individual to remit up to USD 250,000 per financial year [verify: live source] for a combined basket of permitted current and capital account transactions (travel, education, gifts, acquisition of shares or property abroad, and maintenance of relatives). LRS is a facility for resident individuals to make permitted remittances abroad for current account or capital account transactions, or a combination of both, subject to the prescribed annual ceiling and conditions The ceiling is decision-critical because it determines whether the remittance falls within the general LRS facility; any transaction outside the permitted LRS framework must be examined under the applicable FEMA provisions.

Inferences:

LRS applies only to individuals who are PRII. It does not apply to companies or LLPs.

LRS cannot be used to achieve indirectly what is prohibited; a Schedule I prohibited remittance cannot be routed through it.

Overseas investment by a resident individual (acquiring foreign shares) is a capital-account use of LRS and also engages the Overseas Investment framework (Part F.2).

### D.4 Capital account transactions

Because the default is prohibition, the law operates by listing what is permitted in the Permissible Capital Account Transactions Regulations, 2000, which contains two lists.

Schedule I: permissible capital account transactions of a PRII (for example, investment abroad, foreign-currency loans, and acquisition of property outside India).

Schedule II: permissible capital account transactions of a PROI (for example, investment in India, acquisition of property in India, and holding deposits).

Each permitted item is then detailed in a dedicated Regulation or Rule. The 2000 Regulation is the gateway list; the operational detail resides in the subject-matter instruments below.

Inference: for a capital account transaction, identify the applicable permission under FEMA and the relevant Rules or Regulations. If the transaction is permitted, the conditions prescribed by the applicable instrument must be satisfied. A transaction that is not permitted under the applicable FEMA framework cannot be undertaken merely by obtaining RBI approval unless the relevant provision specifically provides for such approval.

## PART E. THE INTERMEDIARY ONTOLOGY (AUTHORISED PERSONS)

Few cross-border transactions occur directly between the parties and the state. They are channelled through an Authorised Person, a person authorised by the RBI under Section 10 of FEMA to deal in foreign exchange or foreign securities.Understanding this layer identifies who executes and screens a transaction.

### E.1 Classes of Authorised Person

Governed by the Authorised Persons Regulations, 2026 (which replaced the earlier framework) and the Money Changing Activities Master Direction.

AD Category-I (Authorised Dealer Category-I): authorised entities, principally banks, permitted to undertake a broad range of permitted current and capital account transactions, subject to their authorisation and the applicable FEMA framework.

AD Category-II: able to handle a specified range of non-trade current account transactions and limited trade transactions up to prescribed limits, together with money-changing.

AD Category-III: restricted, specified entities.

Full-Fledged Money Changers (FFMC): able to buy and sell foreign currency for private and business travel. The RBI is phasing out fresh FFMC authorisations under the 2026 regime.

Forex Correspondents (FxC): a principal-agent model introduced by the 2026 Regulations, replacing the former franchisee model, which is being wound down over two years. AD Category-I and Category-II entities appoint Forex Correspondents to conduct restricted money-changing as their agents.

Inferences:

Many FEMA transactions involving companies, including FDI, ECB and trade transactions, are routed through an AD Category-I bank, subject to the applicable FEMA framework.

A currency-exchange kiosk at an airport is an FFMC or a Forex Correspondent, not an AD bank; it can change currency but cannot execute an FDI filing.

The Authorised Person is the reporting entity for most filings and is legally obliged to verify that a transaction is FEMA-compliant before executing it. It is therefore both executor and first-line compliance check. The 2026 trade regime expands this gatekeeper role: AD banks now exercise wider discretion to grant extensions, approve write-offs, and close monitoring-system entries without prior RBI reference.

### E.2 The Authorised Person as reporting nexus

Significant FEMA transactions may involve reporting by the parties themselves or through the Authorised Person, using the applicable RBI reporting system

FIRMS (Foreign Investment Reporting and Management System): FDI filings such as FC-GPR and FC-TRS.

FETERS: balance-of-payments transaction reporting by banks.

CIMS (Centralised Information Management System): an RBI data and reporting platform used for specified regulatory reporting.

EDPMS and IDPMS: the export and import data processing and monitoring systems, reconciled by AD banks for trade transactions.

ECB returns (Form ECB, Form ECB-2): external commercial borrowings.

## PART F. THE SUBJECT-MATTER DOMAINS

Each activity a client seeks to undertake maps to a cluster of Rule, Regulation, and Master Direction. Identifying the domain locates the instruments. Each item below is attached to its trigger. The operational mechanics of each domain are set out in Part M.

### F.1 Inbound investment: FDI

Trigger: a PROI acquires equity or non-debt instruments of an Indian entity.

Instruments:

Foreign Exchange Management (Non-Debt Instruments) Rules, 2019: the principal substantive Rules governing foreign investment in non-debt instruments, including sectoral caps, entry routes and pricing requirements.

FEM (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019: the RBI's companion instrument on how funds move and how the transaction is reported.

Master Direction: Foreign Investment in India, the operational manual.

Alongside FEMA, though not under it: DPIIT's Consolidated FDI Policy and Press Notes, the sectoral-cap policy layer.

Key concepts: entry route (automatic or Government); sectoral caps; prohibited sectors; pricing guidelines; and the land-border rule. These cross-cutting investment concepts are developed in Part G. Reporting: Form FC-GPR (issue of shares to a non-resident) and Form FC-TRS (transfer of shares between resident and non-resident), on FIRMS.

Inference: a foreign fund acquiring a 30% equity stake in an Indian software company is a PROI acquiring equity in India: FDI, governed by the Non-Debt Instruments Rules; the sector cap and route are checked (software is generally 100% automatic); the price must meet the Rule 21 floor certified by a valuer; the transaction is reported on Form FC-GPR through FIRMS.

### F.2 Outbound investment: ODI and OPI

Trigger: a PRII acquires equity or an interest in a foreign entity, or a resident individual invests abroad.

Instruments:

FEM (Overseas Investment) Rules, 2022 (Central Government) and FEM (Overseas Investment) Regulations, 2022 (RBI), read together, and the FEM (Overseas Investment) Directions, 2022.

Master Direction: Overseas Investment.

Key concepts: ODI (Overseas Direct Investment): investment in an unlisted foreign entity, or investment in 10% or more of the equity of a listed foreign entity, or investment that results in control of the foreign entity. OPI (Overseas Portfolio Investment) is investment that falls outside the ODI definition; financial commitment and its components; the net-worth-based ceiling; bona fide business activity as a continuing obligation; the prohibition on round-tripping and excess layering; and eligibility bars. These are developed in Part M.2.

Inference: an Indian company establishing a wholly owned subsidiary in Dubai is a PRII investing abroad: ODI, governed by the Overseas Investment Rules and Regulations and the Overseas Investment Master Direction. An Indian company acquiring a 5% stake in a listed foreign company is OPI, with different reporting.

### F.3 Cross-border borrowing: ECB

Trigger: a PRII borrows from a PROI (in foreign currency or in rupees).

Instruments:

FEM (Borrowing and Lending) Regulations, 2018 (amended in 2026, the revised ECB framework).

Master Direction: External Commercial Borrowings, Trade Credits and Structured Obligations.

Master Direction: Borrowing and Lending in Indian Rupee between Residents and NRIs or PIOs (the rupee-loan counterpart).

Key concepts: eligible borrowers and recognised lenders; the all-in-cost ceiling; minimum average maturity; end-use restrictions; trade credits; and structured obligations. Developed in Part M.3. Reporting: Form ECB, Form ECB-2 and the Loan Registration Number (LRN), through the designated Authorised Dealer Category-I bank, in accordance with the applicable FEMA reporting requirements

Inference: an Indian manufacturer taking a five-year foreign-currency loan from a Japanese bank is a PRII borrowing from a PROI: ECB, governed by the Borrowing and Lending Regulations and the ECB Master Direction.

### F.4 Debt securities held by non-residents

Trigger: a PROI acquires debt instruments (government securities, non-convertible debentures, commercial paper), the debt counterpart to FDI.

Instrument: FEM (Debt Instruments) Regulations, 2019 (RBI). This is the Regulation that partners the Non-Debt Instruments Rules: equity is governed by a Rule, debt by a Regulation.

Inference: an FPI acquiring Indian government bonds is a PROI acquiring debt: the Debt Instruments Regulations apply, not the Non-Debt Instruments Rules.

### F.5 Trade: export and import of goods and services

Trigger: cross-border sale (export) or purchase (import) of goods, services, or software.

Instruments:

Foreign Exchange Management (Export and Import of Goods and Services) Regulations, 2026: the forthcoming consolidated instrument for exports and imports, scheduled to take effect from 1 October 2026.

Foreign Exchange Management (Export of Goods and Services) Regulations, 2015: the existing export framework until the 2026 Regulations take effect.

Master Direction: Export of Goods and Services, and Master Direction: Import of Goods and Services.

FEM (Manner of Receipt and Payment) Regulations, 2023: governs the permitted currencies and channels through which trade receipts and payments must move; all export and import settlement must comply with it.

Key concepts: realisation and repatriation of export proceeds; the Export Declaration Form (EDF); advance payments and the guarantee trigger; write-off and value reduction; set-off of receivables against payables; third-party receipts and payments; merchanting trade transactions; and monitoring-system reconciliation. Developed in Part M.4.

Inference: an Indian exporter that shipped goods abroad and remains unpaid beyond the applicable realisation period has a realisation and repatriation issue under the applicable export framework.

### F.6 Deposits and accounts

Trigger: a bank account or deposit that crosses the residency line.

Instruments: FEM (Deposit) Regulations, 2016, and the Master Direction on Deposits and Accounts.

Concepts: the NRE, NRO, and FCNR(B) account types (see C.5); Special Non-Resident Rupee (SNRR) accounts; Exchange Earners Foreign Currency (EEFC) accounts; and deposit-acceptance rules.

### F.7 Immovable property

Trigger: acquisition or transfer of real property across the residency line.

Instruments:

Property in India held by non-residents: now governed by the Non-Debt Instruments Rules, 2019. Acquisition and transfer of immovable property in India by persons resident outside India are governed by the Non-Debt Instruments Rules, 2019. The earlier Foreign Exchange Management (Acquisition and Transfer of Immovable Property in India) Regulations, 2018 have been superseded.

Property outside India held by residents: FEM (Acquisition and Transfer of Immovable Property Outside India) Regulations, 2015.

Master Direction: Acquisition or Transfer of Immovable Property under FEMA.

Concepts: NRIs and OCIs may purchase residential or commercial property in India, but may not purchase agricultural land, farmhouse or plantation property, subject to the applicable FEMA exceptions, including acquisition by inheritance; foreign nationals with no Indian-origin link face the tightest limits; and repatriation of sale proceeds is capped by number of residential properties. Developed in Part M.6.

Inference: an OCI acquiring a flat is permitted (residential, not agricultural). A foreign national with no Indian link seeking to acquire farmland is prohibited.

### F.8 Guarantees

Trigger: a guarantee given or received across the border.

Instrument: FEM (Guarantees) Regulations, 2026 (replacing the 2000 regime), read with the Borrowing and Lending Regulations for eligibility.

Concepts: the surety and the principal debtor must each satisfy the borrowing and lending eligibility conditions; and all guarantees issued, modified, or invoked are subject to quarterly reporting.

### F.9 Derivatives and hedging

Instruments: FEM (Foreign Exchange Derivative Contracts) Regulations, 2000, and FEM (Margin for Derivative Contracts) Regulations, 2020.

Concepts: permitted derivative contracts for hedging currency risk; and margin accounts (including interest-bearing accounts) for non-residents in respect of permitted derivative contracts.

### F.10 Money changing and money transfer

Instruments: Master Direction on Money Changing Activities; Master Direction on the Money Transfer Service Scheme (MTSS), covering inbound personal remittances; and Master Direction on the Opening and Maintenance of Vostro Accounts of Non-resident Exchange Houses.

Concepts: FFMCs, Forex Correspondents, and MTSS for personal remittances into India.

### F.11 Mergers, offices in India, and IFSC

FEM (Cross Border Merger) Regulations, 2018: inbound and outbound mergers.

FEM (Establishment in India of a Branch, Liaison, or Project Office) Regulations, 2016, with its Master Direction: how a foreign company establishes a presence in India.

FEM (International Financial Services Centre) Regulations, 2015: the IFSC (GIFT City), where an IFSC is deemed to be outside India for many FEMA purposes.

### F.12 Remittance of assets and individual remittance facilities

FEM (Remittance of Assets) Regulations, 2016, with its Master Direction: a non-resident or emigrant remitting assets out of India.

Master Direction on the Liberalised Remittance Scheme, and Master Direction on Other Remittance Facilities: the individual-facing outflow rules.

### F.13 Currency, and possession and retention

FEM (Export and Import of Currency) Regulations, 2015: physical movement of Indian and foreign currency across the border, including the Nepal and Bhutan carve-outs.

FEM (Possession and Retention of Foreign Currency) Regulations, 2015: how much foreign currency a resident may hold.

FEM (Realisation, Repatriation and Surrender of Foreign Exchange) Regulations, 2015: the resident's duty to bring home and surrender foreign exchange.

FEM (Regularization of Assets Held Abroad by a Person Resident in India) Regulations, 2015: regularisation of foreign assets.

## PART G. CROSS-CUTTING INVESTMENT CONCEPTS

These concepts recur across FDI, ODI, downstream investment, transfers, and guarantees. They are not tied to a single instrument, so they are set out once here and referred to from the domains above. An AI that treats them as reusable nodes will avoid re-deriving them in each domain.

### G.1 Ownership and control (the two-limb test)

Foreign investment analysis turns on two distinct attributes of an Indian entity: who owns it and who controls it.

Ownership: the extent of equity held by persons resident outside India, calculated on a fully diluted basis where applicable

Control: the right to appoint a majority of directors, or to control management or policy decisions, whether through shareholding, management rights, shareholders' agreements, or voting arrangements.

Inference: Control can exist without majority ownership. A non-resident holding a minority stake may nonetheless control an entity where it has the relevant rights to appoint a majority of directors or control management or policy decisions.

### G.2 Foreign-owned or controlled company (FOCC) and downstream investment

An Indian company is considered foreign-owned when persons resident outside India beneficially hold more than 50% of its equity instruments on a fully diluted basis. An LLP is considered foreign-owned when persons resident outside India contribute more than 50% of its capital and hold a majority of its profit share. An Indian company or LLP is foreign-controlled where control is vested in persons resident outside India.

When a FOCC invests in another Indian entity, that investment is a downstream investment and is treated as indirect foreign investment in the recipient. The governing provision is Rule 23 of the Non-Debt Instruments Rules, read with the Foreign Investment Master Direction.

Two consequences follow, and both are commonly missed:

The downstream investment must comply with the same entry route, sectoral cap, pricing guidelines, and performance conditions that would apply to direct FDI into the recipient's sector. The governing principle is that what cannot be done directly cannot be done indirectly.

A FOCC receives a dual treatment. For pricing purposes it is treated as a person resident outside India (its downstream deals must meet the fair-value pricing rules). For reporting purposes it is treated as a person resident in India. This split is deliberate and is a frequent source of error.

Inference: an Indian company that is more than 50% foreign-owned, investing in a second Indian company, is not doing a purely domestic transaction. It is making indirect foreign investment, and the second company must satisfy the FDI conditions for its sector. The status crystallises on the date the entity becomes a FOCC (for example, when a funding round pushes non-resident ownership past the threshold), and a reclassification filing (Form DI) is triggered.

### G.3 Total foreign investment

Total foreign investment in an Indian entity is the aggregate of direct foreign investment and indirect foreign investment, computed on a fully diluted basis. This aggregate is what is measured against a sectoral cap. An entity may be within its cap on direct investment alone yet breach it once indirect investment is added.

### G.4 Entry routes and the approval machinery

Every FDI proposal follows one of two routes:

Automatic route: no prior approval; the investor invests and reports afterward.

Government route: prior approval of the administrative ministry or department is required before the investment.

The approval machinery operates through the National Single Window System (which absorbed the earlier Foreign Investment Facilitation Portal), which routes an application to the competent ministry for the sector. Approval conditions can alter deal structure, so approval should be obtained before valuation and execution.

Inference: the route is a function of the sector and the cap. If the target's sector permits 100% under the automatic route and imposes no performance conditions, no approval is needed. If foreign investment in the sector exceeds the automatic threshold, or the sector requires approval, the Government route applies.

### G.5 Sectoral caps and performance conditions

Sectors fall into three groups: prohibited (no foreign investment, for example lottery, gambling, chit funds, and certain real-estate business); capped (foreign investment permitted up to a stated percentage, sometimes split between an automatic tranche and a Government tranche); and permitted to 100% under the automatic route. Some sectors additionally impose FDI-linked performance conditions (for example minimum capitalisation, lock-in, or local-sourcing norms). The specific caps and conditions are set by the Consolidated FDI Policy and the Non-Debt Instruments Rules and change frequently; they should be read from the live source.

### G.6 Pricing and valuation

Any issue or transfer of equity instruments across the resident and non-resident boundary must be priced against a fair value, not a figure negotiated between the parties. The governing provision is Rule 21 of the Non-Debt Instruments Rules.

The rule is asymmetric, and the asymmetry is the point:

Inbound (a resident issues or transfers to a non-resident): the price must be at or above fair value. This prevents a foreign party acquiring Indian assets at a discount.

Outbound (a non-resident transfers to a resident): the price must be at or below fair value. This prevents a foreign party exiting at an inflated price.

Fair value is determined for a listed company by SEBI pricing guidelines, and for an unlisted company by any internationally accepted pricing methodology applied on an arm's-length basis (for example discounted cash flow, net asset value, or market multiples), certified by an eligible professional (a Chartered Accountant, a SEBI-registered Category-I Merchant Banker, or a practising Cost Accountant; for share swaps, a Merchant Banker or a recognised foreign investment banker). The certificate has a limited validity period, so allotment must occur within it.

A distinct and critical rule governs exit: a non-resident holding equity may not be contractually guaranteed an assured return or a pre-agreed exit price above the fair value prevailing at the time of exit. Equity must carry genuine business risk. An arrangement that guarantees a fixed return is recharacterised as debt and becomes subject to the borrowing framework instead.

Inference: any cross-border share transaction requires a valuation certificate; the price is a floor when the money comes in and a ceiling when it goes out; and no put option or shareholders'-agreement clause may promise a foreign investor a fixed exit price above fair market value.

### G.7 Beneficial ownership and the land-border rule

Investment from an entity of, or a beneficial owner situated in, or a citizen of, a country sharing a land border with India (for example China, Pakistan, Bangladesh, Nepal, Bhutan, Myanmar, Afghanistan) requires Government approval regardless of sector or route. This is the "Press Note 3" rule. It applies a beneficial-ownership test, so the analysis looks through the immediate investor to the ultimate beneficial owner.

Inference: an investment routed through a Singapore holding company is not automatically clear. If the beneficial owner sits in a land-border country, the Government route applies despite the intermediate jurisdiction.

### G.8 Round-tripping and layering (outbound)

On the outbound side, the mirror concern is that Indian money invested abroad returns to India through layered structures. The Overseas Investment framework restricts a resident's foreign entity from creating a structure with more than two layers of subsidiaries, and scrutinises investment that flows back into India. This is the round-tripping and layering restriction.

Inference: an ODI structure in which the foreign entity invests or invests into India, resulting in more than two layers of subsidiaries, engages the round-tripping and layering restriction under the Overseas Investment framework and may be impermissible

## PART H. THE ENFORCEMENT ONTOLOGY

### H.1 The contravention

A contravention is any breach of the Act, a Rule, a Regulation, a notification, a direction, or a condition of an RBI authorisation. The breadth matters: a breach of a Master Direction or of a circular condition is itself a contravention, because both are directions under the Act.

### H.2 Two disposal routes

|  | Compounding | Adjudication |
|---|---|---|
| Nature | Voluntary admission and monetary settlement | Imposed following investigation |
| Body | RBI (for most matters); ED for some | Enforcement Directorate |
| Instrument | Foreign Exchange (Compounding Proceedings) Rules, 2024, and the Master Direction on Compounding of Contraventions | FEM (Adjudication Proceedings and Appeal) Rules, 2000 |
| Outcome | A settled sum, closing the matter | A penalty imposed by the adjudicating authority |
| Appeal | Not applicable | To the Special Director (Appeals), then the Appellate Tribunal for Foreign Exchange, then the High Court |

FEMA is civil. Penalties are monetary: up to three times the sum involved where the amount is quantifiable, or up to INR 2 lakh where it is not, with a further penalty of up to INR 5,000 per day for continuing default [verify: live source]. These figures sit in the Act itself and change rarely, but they are decision-critical to any enforcement assessment. Imprisonment arises only on failure to pay.

Compounding is the ordinary means of regularisation. A party that identifies a breach (for example, a late FC-GPR filing) applies voluntarily to the RBI, pays a compounding amount, and closes its exposure. Certain matters are outside compounding (for example, where the contravention involves serious concerns such as money laundering or national security, or is under ED investigation).

Inference: a company that filed its FDI report late and wishes to regularise it has a reporting contravention capable of voluntary compounding with the RBI under the Compounding Proceedings Rules, 2024 and the corresponding Master Direction. A show-cause notice issued by the ED alleging an unlawful transfer proceeds by adjudication under the Adjudication Rules, 2000, with appeal to the Appellate Tribunal.

### H.3 Supporting procedural instruments

Foreign Exchange (Authentication of Documents) Rules, 2000: authentication of documents in proceedings.

Appellate Tribunal for Foreign Exchange (Recruitment, Salary, Allowances and Conditions of Service) Rules, 2000: constitution of the Tribunal.

FEM (Encashment of Draft, Cheque, Instrument and Payment of Interest) Rules, 2000: a narrow procedural rule.

## PART I. THE REPORTING AND FORMS ONTOLOGY

Identifying the form often permits inference of the transaction, which is how a file is read quickly.

| Form or return | Portal | Indicates |
|---|---|---|
| FC-GPR | FIRMS | An Indian company issued shares to a non-resident (fresh FDI) |
| FC-TRS | FIRMS | A transfer of shares between resident and non-resident |
| Form DI | FIRMS | A downstream (indirect foreign) investment by a FOCC |
| LLP-I / LLP-II | FIRMS | Foreign investment into, or disinvestment from, an LLP |
| FLA return | FLAIR | The annual Foreign Liabilities and Assets return (entities with FDI or ODI) |
| Form ECB / ECB-2 | via AD bank | An external commercial borrowing (initial or monthly) |
| Form FC / APR | via AD bank | Overseas investment (initial financial commitment) or the Annual Performance Report |
| EDF | EDPMS | Export of goods or services (unified declaration) |
| IDPMS entries | IDPMS | Import-payment tracking |
| FETERS | RBI | Bank-level balance-of-payments reporting |

Inference: the presence of an FC-TRS in a file indicates a purchase or sale of Indian shares across the residency line, requiring confirmation that the Rule 21 pricing and the Non-Debt Instruments Rules were satisfied. The presence of a Form DI indicates a foreign-owned Indian company making a downstream investment, requiring confirmation that the recipient's sector cap and route were respected.

## PART J. CROSS-CUTTING INFERENCE RULES

These are the steps applied by an experienced practitioner as a matter of course. They are stated explicitly.

- Determine residency first. Before classifying any transaction, label both parties as PRII or PROI. Entity residency turns on the place of incorporation, not on ownership. A company incorporated abroad is a PROI; an Indian subsidiary of a foreign parent is a PRII.

- Then apply the ownership-and-control lens separately. An Indian company (a PRII) that is more than 50% foreign-owned or foreign-controlled is treated as foreign when it invests downstream. Residency and foreign-owned-or-controlled status are two different tests, and both matter.

- Classify the transaction. Does it move or alter capital across the border (a capital account transaction, prohibited by default), or does it pay for goods, services, or living expenses (a current account transaction, permitted by default)? For a current account item, look for a prohibition. For a capital account item, look for a permission.

- Allocate Rule against Regulation by subject.

- Treat the Master Direction as the manual, not the authority. Use it to establish procedure, but where it conflicts with the parent Rule or Regulation, the parent prevails. Note the update date.

- Route through the AD bank. Most transactions pass through an AD Category-I bank, which executes, screens for compliance, and files the report.

- Split the instrument by equity against debt. Non-debt (equity-type) instruments are governed by the Non-Debt Instruments Rules; debt instruments by the Debt Instruments Regulations.

- Price every cross-border share deal against fair value. The price is a floor for inbound investment and a ceiling for outbound transfer, certified by an eligible valuer. No foreign investor may be guaranteed a fixed exit price above fair market value; such a promise recharacterises the equity as debt.

- Count the whole financial commitment on the outbound side. For ODI, financial commitment includes equity, debt, and guarantees, not equity alone. Measuring only equity understates exposure against the net-worth ceiling.

- Distinguish ODI from OPI. ODI arises at 10% or more of a foreign entity, or on control; OPI is a smaller, non-controlling holding, typically in listed securities, with a separate reporting track.

- Resolve repatriability explicitly. Whether proceeds may leave India depends on the specific regulation and the account type (NRE funds are freely repatriable; NRO funds are capped).

- Treat a late or missing form as a contravention capable of compounding. Most FEMA issues in practice are reporting breaches, and the standard course is voluntary compounding with the RBI rather than litigation.

- Read DPIIT policy alongside FEMA. Sectoral caps and the Consolidated FDI Policy are issued by the Department for Promotion of Industry and Internal Trade; the Non-Debt Instruments Rules give them legal effect.

- Look through to the beneficial owner on inbound deals. An investment structured through a third jurisdiction still attracts the land-border approval rule if the ultimate beneficial owner sits in a land-border country.

- Treat the IFSC (GIFT City) as outside India for many FEMA purposes. A resident dealing with an IFSC unit may be conducting a transaction that FEMA treats as cross-border.

## PART K. INDEX: INSTRUMENT BY CATEGORY

Rules (Central Government)

- Foreign Exchange Management (Current Account Transactions) Rules, 2000

- Foreign Exchange Management (Encashment of Draft, Cheque, Instrument and Payment of Interest) Rules, 2000

- Foreign Exchange (Authentication of Documents) Rules, 2000

- Foreign Exchange Management (Adjudication Proceedings and Appeal) Rules, 2000

- Appellate Tribunal for Foreign Exchange (Recruitment, Salary, Allowances and Conditions of Service) Rules, 2000

- Foreign Exchange (Compounding Proceedings) Rules, 2024

- Foreign Exchange Management (Non-Debt Instruments) Rules, 2019

- Foreign Exchange Management (Overseas Investment) Rules, 2022

Regulations (RBI)

- Foreign Exchange Management (Authorised Persons) Regulations, 2026

- Foreign Exchange Management (Borrowing and Lending) Regulations, 2018

- Foreign Exchange Management (Cross Border Merger) Regulations, 2018

- Foreign Exchange Management (Crystallization of Inoperative Foreign Currency Deposits) Regulations, 2014

- Foreign Exchange Management (Debt Instruments) Regulations, 2019

- Foreign Exchange Management (Deposit) Regulations, 2016

- Foreign Exchange Management (Establishment in India of a Branch, Liaison or Project Office) Regulations, 2016

- Foreign Exchange Management (Export and Import of Currency) Regulations, 2015

- Foreign Exchange Management (Export and Import of Goods and Services) Regulations, 2026

- Foreign Exchange Management (Export of Goods and Services) Regulations, 2015 (being phased out)

- Foreign Exchange Management (Foreign Currency Accounts by a Person Resident in India) Regulations, 2015

- Foreign Exchange Management (Foreign Exchange Derivative Contracts) Regulations, 2000

- Foreign Exchange Management (Guarantees) Regulations, 2026

- Foreign Exchange Management (Insurance) Regulations, 2015

- Foreign Exchange Management (International Financial Services Centre) Regulations, 2015

- Foreign Exchange Management (Issue of Security in India by a Branch, Office or Agency of a Person Resident Outside India) Regulations, 2000

- Foreign Exchange Management (Manner of Receipt and Payment) Regulations, 2023

- Foreign Exchange Management (Margin for Derivative Contracts) Regulations, 2020

- Foreign Exchange Management (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019

- Foreign Exchange Management (Offshore Banking Units) Regulations, 2002

- Foreign Exchange Management (Overseas Investment) Regulations, 2022

- Foreign Exchange Management (Permissible Capital Account Transactions) Regulations, 2000

- Foreign Exchange Management (Possession and Retention of Foreign Currency) Regulations, 2015

- Foreign Exchange Management (Realisation, Repatriation and Surrender of Foreign Exchange) Regulations, 2015

- Foreign Exchange Management (Regularization of Assets Held Abroad by a Person Resident in India) Regulations, 2015

- Foreign Exchange Management (Remittance of Assets) Regulations, 2016

- Foreign Exchange Management (Withdrawal of General Permission to Overseas Corporate Bodies) Regulations, 2003

- Foreign Exchange Management (Acquisition and Transfer of Immovable Property Outside India) Regulations, 2015

Master Directions (RBI)

- Master Direction - Compounding of Contraventions under FEMA, 1999

- Master Direction - Overseas Investment

- Master Direction - External Commercial Borrowings, Trade Credits and Structured Obligations

- Master Direction - Foreign Investment in India

- Master Direction - Money Transfer Service Scheme (MTSS)

- Master Direction - Insurance

- Master Direction - Establishment of Branch Office, Liaison Office or Project Office by Foreign Entities

- Master Direction - Direct Investment by Residents in Joint Venture or Wholly Owned Subsidiary Abroad

- Master Direction - Borrowing and Lending in Indian Rupee between Residents and NRIs or PIOs

- Master Direction - Liberalised Remittance Scheme (LRS)

- Master Direction - Other Remittance Facilities

- Master Direction - Acquisition or Transfer of Immovable Property under FEMA

- Master Direction - Remittance of Assets

- Master Direction - Deposits and Accounts

- Master Direction - Import of Goods and Services

- Master Direction - Reporting under FEMA, 1999

- Master Direction - Miscellaneous

- Master Direction - Opening and Maintenance of Vostro Accounts of Non-resident Exchange Houses

- Master Direction - Export of Goods and Services

- Master Direction - Money Changing Activities

Adjacent instruments (read with FEMA but not made under it)

- DPIIT Consolidated FDI Policy and Press Notes

- Enforcement Directorate procedure

- RBI FAQs

- A.P. (DIR Series) circulars

## PART L. HOW THE DETAIL LAYER IS TO BE USED

Part M records the mechanics of the principal instruments: the shape of each test, gate, and formula. It applies the figure rule stated at the outset. Where a number decides transaction structure or the answer (a route-flipping threshold, a classification threshold, a realisation window, a statutory penalty), it is stated in the text with a "[verify: live source]" marker, because a reader cannot resolve the question without it. Where a number is purely operational and volatile (a full sectoral cap table, an exact all-in-cost spread, a fee schedule), the layer describes its shape and points to the source rather than reproducing it. The live sources are the RBI Legal Framework pages (Rules, Regulations), the RBI Master Directions page, the current A.P. (DIR Series) circulars, and, for sectoral caps, the DPIIT Consolidated FDI Policy and Press Notes.

## PART M. DETAIL LAYER: MECHANICS OF THE PRINCIPAL INSTRUMENTS

### M.1 FDI under the Non-Debt Instruments Rules, 2019

Route determination: identify the target's sector; read the sectoral cap and route from the Consolidated FDI Policy [verify: live source]. If the sector permits 100% under the automatic route with no performance conditions, no prior approval is needed. Otherwise the Government route applies to the portion above the automatic threshold, or to the whole where the sector is approval-only. Unless specifically prohibited, FDI is allowed 100%

Prohibited sectors: certain sectors admit no foreign investment [verify: live source for the current list, which typically includes lottery and gambling, chit funds, Nidhi companies, real-estate business (as distinct from construction-development), and manufacturing of tobacco products].

Pricing (Rule 21): floor for inbound, ceiling for outbound; listed by SEBI guidelines, unlisted by an internationally accepted methodology on an arm's-length basis; certified by an eligible professional; valuation certificate valid for 90 days [verify: live source], so allotment must occur within that window. No assured exit return above fair value (see G.6).

Performance conditions: some sectors impose minimum capitalisation, lock-in, or sourcing norms [verify: live source].

Reporting: FC-GPR for issue to a non-resident (within 30 days of allotment); FC-TRS for transfer across the residency line (within 60 days of transfer or remittance); LLP forms for LLPs; Form DI for downstream investment (within 30 days of the downstream allotment) [verify: live source for all windows], on FIRMS. These windows are decision-critical because a missed window is itself a contravention that must be compounded.

### M.2 Overseas investment under the OI Rules and Regulations, 2022

Classification: ODI where the resident acquires 10% or more of a foreign entity, or acquires control, or invests in an unlisted foreign entity; OPI otherwise (a smaller, non-controlling holding, typically in listed securities or foreign funds).

Financial commitment: the aggregate of equity, debt, and non-fund exposure (guarantees, and pledge or charge). It excludes OPI. It is capped at 400% of the resident entity's net worth [verify: live source], computed on the investing entity's own net worth (the practice of aggregating group net worth was discontinued in 2022). This ceiling is decision-critical: commitment within it is available under the automatic route; commitment beyond it requires approval.

Route: most ODI is automatic if conditions are met. Approval is required for restricted jurisdictions, where the investor is otherwise ineligible, or where financial commitment exceeds USD 1 billion (or equivalent) in a financial year even though within the 400% ceiling [verify: live source for both thresholds].

Conditions and bars: the foreign entity must carry on bona fide business activity, and this is a continuing obligation, not a one-time declaration. A resident who is a wilful defaulter, has an account classified as a non-performing asset, or is under investigation by a financial regulator or an investigative agency must obtain a No Objection Certificate before making a financial commitment.

Round-tripping and layering: a structure must not exceed the permitted number of subsidiary layers, and investment that flows back to India is scrutinised (see G.8).

Reporting: Form FC for the financial commitment; Annual Performance Report each year for each foreign entity; late filing is regularised through a Late Submission Fee computed on a formula tied to the amount and the period of delay [verify: live source for the formula and rates].

### M.3 External commercial borrowings under the Borrowing and Lending Regulations, 2018

Eligibility: the borrower must be an eligible borrower and the lender a recognised lender, both defined by the framework [verify: live source for the current lists].

All-in-cost: the total cost of the borrowing (interest, fees, and expenses, expressed as a spread over a benchmark reference rate) must not exceed the all-in-cost ceiling [verify: live source for the benchmark and the permitted spread].

Minimum average maturity: the borrowing must carry at least a stated minimum average maturity, which varies by category and end-use [verify: live source].

End-use: certain uses are prohibited (a negative list, for example on-lending or real-estate speculation, subject to exceptions) [verify: live source].

Hedging and other conditions: certain borrowers must hedge currency exposure; a Loan Registration Number must be obtained before drawdown.

Security and guarantees: domestic and cross-border security and guarantees are permitted subject to conditions. Reporting: Form ECB before drawdown, Form ECB-2 monthly. The 2026 amendment adds an untraceable-borrower mechanism for entities failing ongoing reporting or KYC.

### M.4 Trade under the Export and Import Regulations, 2026

Realisation and repatriation: export proceeds must be realised and repatriated within 15 months from shipment (goods) or invoice (services), or within 18 months where invoiced or settled in rupees [verify: live source for both periods]. Warehouse exports run the period from the date of sale. These windows are answer-deciding: proceeds outstanding beyond them are a contravention.

Declaration: exports are declared on the unified Export Declaration Form (EDF), which replaced the earlier separate forms.

Monitoring-system reconciliation: AD banks credit or debit accounts only after verifying the transaction and updating or closing the entry in EDPMS (exports) or IDPMS (imports). For small-value transactions up to INR 10 lakh (or foreign-currency equivalent) [verify: live source], entries may be closed on the trader's self-declaration, including quarterly bulk closure. The threshold decides which compliance path applies: self-declaration below it, full AD verification above it.

Advance payments: exporters may receive advances subject to conditions; where an import against an advance does not materialise, the importer must repatriate the advance, and failure to do so (or an unmarked IDPMS entry) restricts future advance import payments to those backed by an unconditional and irrevocable letter of credit or bank guarantee.

Write-off, reduction, and set-off: AD banks may permit reduction or non-realisation of export value on satisfactory reasons, and may permit set-off of export receivables against import payables, subject to bona fides.

Third-party and merchanting: third-party receipts and payments are permitted subject to conditions; merchanting trade transactions are subject to a maximum time gap between the outward and inward remittance, extendable by the AD bank on reasonable grounds [verify: live source for the time gap].

AD governance: AD banks must maintain internal policies and standard operating procedures covering approvals, documentation, timelines, and grievance redressal, and exercise the wider discretion the 2026 regime confers.

### M.5 Foreign investment: entry routes, caps, downstream (cross-reference)

The mechanics of entry routes (G.4), sectoral caps and performance conditions (G.5), pricing (G.6), the land-border rule (G.7), and downstream investment by a FOCC (G.2) are set out in Part G because they are shared across domains. In application: identify the sector and cap; identify the route; test the investor for the land-border rule and beneficial ownership; if the Indian investor is itself a FOCC, apply the downstream conditions; price under Rule 21; report on the correct form.

### M.6 Immovable property (cross-reference F.7)

Permitted acquirers and property: NRIs and OCIs may acquire residential and commercial property; they may not acquire agricultural land, farmhouses, or plantation property (except by inheritance). Foreign nationals of non-Indian origin resident outside India are, in general, not permitted to acquire property other than by inheritance or with approval; a resident foreign national follows the resident rules.

Repatriation of sale proceeds: capped by the number of residential properties and conditioned on the mode of the original acquisition (foreign exchange through banking channels, or NRE or FCNR funds) [verify: live source for the cap].

### M.7 Deposits and accounts (cross-reference F.6)

Account types and their attributes: NRE (rupee, foreign-source, freely repatriable); NRO (rupee, India-source, repatriation capped); FCNR(B) (foreign currency, insulated from rupee movement); SNRR (special non-resident rupee, for specific business purposes); EEFC (a resident exporter's account for retaining a portion of foreign-exchange earnings). Eligibility, permitted credits and debits, and repatriability differ by type and are set by the Deposit Regulations and the Deposits and Accounts Master Direction [verify: live source].

### M.8 Compounding (cross-reference H.2)

Mechanism: a voluntary application to the RBI admitting a contravention; the RBI computes a compounding amount by reference to a published matrix tied to the nature and amount of the contravention and the period of default [verify: live source for the matrix]; on payment, the matter closes. Voluntary approach before detection generally attracts more favourable treatment. Compounding is unavailable where the matter involves serious concerns or is under ED investigation.

### M.9 Manner of receipt and payment (cross-reference F.5)

The Manner of Receipt and Payment Regulations, 2023 prescribe the permitted currencies and channels for cross-border receipts and payments, including the Asian Clearing Union mechanism for trade with member countries, and rupee settlement through Vostro accounts. All trade settlement must conform to these Regulations, which sit underneath the trade, remittance, and investment domains.

Currency note: FEMA's subordinate law is amended frequently. In 2026 alone, the Authorised Persons, Guarantees, Export and Import, and ECB instruments were replaced or amended. Figures that decide structure or outcome are stated in the text so the ontology can resolve a question, but every one carries a "[verify: live source]" marker and none should be relied upon without checking the current position. Every instrument listed here should likewise be treated as current only as of the date of drafting. The live sources are the RBI Legal Framework pages (Rules and Regulations), the RBI Master Directions page, the current A.P. (DIR Series) circulars, and the DPIIT Consolidated FDI Policy and Press Notes.
