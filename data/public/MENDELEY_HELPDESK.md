# Public end-to-end corpus

Wordless uses version 2 of **Help Desk Tickets** by Mohammad Abdellatif for the
public, degraded-evidence replay fixture.

- DOI: <https://doi.org/10.17632/btm76zndnt.2>
- Published: 2025-05-30
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Source period: January 2016 through March 2023

The source contains anonymized ticket records, 360 curated ticket
conversations, and 747 assignee-turn appraisals covering 360 issues. The
help-desk manager scored 603 turns on a 1–5 scale; 144 records carry zero and
are treated as unscored because the dataset defines 1 as the lowest score and
5 as the highest.

The public export does not contain linked account, billing, or order state.
Wordless therefore reports this corpus as degraded evidence and does not blend
it into exported-state headline findings. The source manager scores validate
general work quality, thoroughness, and responsiveness; they are not treated
as resolution-intent judgments.

Raw files are not committed. `scripts/download_public_corpus.py` downloads the
pinned version to `.wordless/public/mendeley-helpdesk-v2/` and verifies every
published SHA-256 digest before use. Wordless does not claim the dataset author
or publisher endorses this project.

