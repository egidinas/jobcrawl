# Methods and measurements

How Match me, the statements and the Atlas work, and what was measured while they were built. The numbers come from the reference
board of the aerospace profile: 10,235 roles with meaning vectors, embedded with EmbeddingGemma 2 (256 numbers kept, see
`docs/ARCHITECTURE.md`). Each table says what it measured and what it does not show.

## Reproducing the numbers

The simulation behind the rating and exploration tables (the reference implementation's `eval_taste.mjs`) is **not part of this
repository**, so these tables cannot be regenerated from here yet. What the repository does provide, and what the numbers depend on:

* the role vectors: `jobcrawl embed` (needs the model, `scripts/fetch_model.py`);
* the statements and their AUC: `jobcrawl publish` prints one line per statement (`prefs: <id> AUC ...`) and writes `match/match-prefs.json`;
* the neighbours and near-duplicates: `jobcrawl publish` (`role-nb.bin`, `role-graph.json`);
* the atlas layout and its group counts: `jobcrawl map` (the log prints the representatives and the regions and neighbourhoods).

The demo (`demo/site`) runs the same steps on a 1,051-role subset, so its statement AUCs and group counts differ from the reference
board's; `demo/README.md` lists them.

## 1. Rating: how a visitor finds roles without a CV

**Set-up of the simulation.** A simulated visitor has one to three hidden areas of interest (seed roles that are not near each other).
A role appeals by its closeness to the nearest seed; the visitor's good roles are its top 1 % (about 100 roles). The visitor sees a
spread of 12 roles, then four rounds of 20 results, and marks the good roles (up) and half of the clearly unappealing ones (down).
Measured per round: precision at 20 (the share of good roles in the 20) and coverage (the share of the hidden areas with at least one
good role in the 20).

This is optimistic in one way (the visitor's taste lives in the same space as the ranking, and marks are never wrong) and pessimistic
in another (no CV, no keywords, no statements unless stated). It shows whether the mechanics work, not how well a real person will be
served.

**Rating alone (no CV, no statements).**

| areas | method | round 1 | round 2 | round 3 | round 4 | coverage round 4 |
|---|---|---|---|---|---|---|
| 1 | random | 1 % | 1 % | 1 % | 1 % | 21 % |
| 1 | one averaged taste vector | 3 % | 12 % | 17 % | 21 % | 53 % |
| 1 | areas (the design in the browser) | 6 % | 13 % | 18 % | 23 % | 63 % |
| 2 | one averaged taste vector | 5 % | 10 % | 14 % | 16 % | 25 % |
| 2 | areas | 5 % | 13 % | 17 to 18 % | 19 % | 30 % |
| 3 | one averaged taste vector | 4 % | 8 % | 15 % | 16 % | 18 % |
| 3 | areas (with company coupling) | 4 % | 11 % | 15 % | 16 % | 18 % |

* Ratings work: from 1 % (chance) to about 20 % good roles in four rounds.
* Separate areas beat one averaged vector, most clearly in coverage. The gain is modest. With three interests both methods stall.
* Company coupling does not change these numbers. That is expected, because the simulated taste has no employer component.
* **The weak point is the cold start.** A spread of 12 from 10,000 roles rarely contains one of the visitor's top 1 %, so most visitors
  have nothing to like for the first round or two.

**Pre-shaping (before any rating).**

| areas | added | round 1 | round 2 | round 4 | coverage round 1 to 4 |
|---|---|---|---|---|---|
| 1 | nothing | 5 % | 12 % | 23 % | 28 to 65 % |
| 1 | board field chips | 6 % | 11 % | 22 % | 35 to 63 % |
| 1 | statements | 17 % | 37 % | 41 % | 77 to 96 % |
| 1 | CV | 86 % | 64 % | 34 % | 100 to 99 % |
| 2 | statements | 12 % | 28 % | 31 % | 33 to 46 % |
| 2 | CV | 60 % | 68 % | 39 % | 100 to 75 % |
| 3 | statements | 6 % | 17 % | 25 % | 16 to 25 % |
| 3 | CV | 47 % | 72 % | 40 % | 98 to 69 % |

* **A CV is by far the strongest start**, but the simulation flatters it: the simulated CV sits between the visitor's areas with as much
  noise as signal, in the same space as the roles. A real CV is read by the model and describes the past rather than the wish. Precision
  falls in later rounds because the best roles have already been shown (each role is shown once).
* **Statements help a lot for one interest and still clearly for two.** The simulated answers agree with where the visitor's areas
  lie, rounded to the five positions, so this is an upper bound for honest answers.
* **Field chips do not help** (and slightly hurt with two or three interests). The board's field tags are broad, and a person's interests
  cut across them. They still narrow what the visitor sees, which may matter for trust more than for ranking.
* With a CV, coverage drops over the rounds: once ratings pile up in one interest, that area dominates the 20 places.

**Exploration (4 of 20 places for roles far from everything rated).** It raises coverage a little for two or three interests (two areas:
31 to 35 %, three areas: 16 to 20 % by round 4). It lowers precision for a single interest (23 to 15 %). It is therefore an option in the
panel, off by default. The Atlas is the main exploration tool.

**Starting personas.** Twelve starting points for visitors without a CV (`personas` in the profile). Each is the centre of the board roles
whose titles match it, so it always fits the current board. Its pull starts at 0.8 (a liked role counts 1) and halves for every six
marks; an explored lens area in the Atlas counts a quarter of a mark. After about 30 marks it is gone.

| areas | start | round 1 | round 2 | round 4 | coverage round 1 to 4 |
|---|---|---|---|---|---|
| 1 | nothing | 5 % | 12 % | 24 % | 28 to 66 % |
| 1 | persona | 16 % | 29 % | 34 % | 76 to 90 % |
| 1 | persona and statements | 20 % | 32 % | 42 % | 71 to 95 % |
| 2 | nothing | 4 % | 12 % | 17 % | 13 to 28 % |
| 2 | persona | 18 % | 28 % | 29 % | 39 to 45 % |

A persona roughly triples the first round for visitors without a CV. A CV is still far stronger in the simulation (86 % in round 1), with
the caveats above.

**Open.** Real visitors' ratings are the only true test of all of this. The cold start without a CV or statements stays slow. Ideas: a
first spread drawn from the visitor's region and level filters (already applied), or a short "this or that" between two roles from
opposite ends of each statement.

## 2. Statements: directions for Match me and the Atlas

Each statement is a direction in the meaning space, from the words roles use about themselves (the title and the first 3,000
characters of the description), checked on held-out roles. A role belongs to a pole when it uses at least two of its words and none of
the other pole's. The direction is the difference of the two groups' mean vectors, computed on one half of the roles and checked on the
other half (the AUC: how often a held-out role of pole A projects further along the direction than one of pole B). Statements below an
AUC of 0.75 are not published (`jobcrawl/index/prefs.py`).

| statement | AUC (held-out) | caveat |
|---|---|---|
| independent work to clear guidelines and processes | 0.82 | correlates with hands-on (-0.64): the "guidelines" end is partly technicians and inspection roles |
| hands-on (lab, hardware, integration) to desk work (analysis, models, software) | 0.86 | the hands-on end leans toward production and technician roles |
| new things (research, prototypes) to delivery (production, operations) | 0.95 | correlates with independent work (0.51) |
| with customers and partners to inside the technical team | 0.98 | |
| defence and security to civil, commercial and science | 0.94 | |

A "leading people to expert work" statement was built and removed: too few roles state it, and the ends did not read as the statement.
The AUC only shows that the direction separates roles that use the words; the ends were also checked by reading sample titles. A
statement answer tilts scores by at most plus or minus 0.05 per statement: enough to reorder within an area, not enough to override
what a person rated.

In the demo's subset the defence statement falls below the minimum number of roles per pole and is not published; the other four are.

## 3. Language and employers

**Language.** 44 % of the roles in Germany are written in German, but for English queries only 21 % of the top 30 (roles in Germany) were
German postings. The three language directions (German, French and Spanish minus English, made orthonormal) are removed from all stored
vectors and from a visitor's CV in the browser (`jobcrawl/text/langfix.py`). Scores are also shifted per language so each language's top
5 % lines up with the English top 5 %. For 12 English queries: 21 % German postings in the top 30 before, 28 % with the directions removed,
33 % with the calibration as well. The top results stay on topic (for "thermal vacuum test engineer": AIT, thermal and test-stand roles in
both languages).

**Employers.** A quarter of a role's 15 nearest roles came from the same employer (0.4 % by chance): one employer's postings share
wording. For the map, 80 % of each employer's average direction is removed (`map.signature`, only for employers with three or more roles).
Matching keeps it, because the employer coupling there is meant to be explicit and adjustable; this can be revisited with real ratings.

## 4. Work text: what the model reads

The first recipe used the role section only where a description could be split into sections (64 % of roles); the rest were embedded
from the top, often a company introduction or a template header. `jobcrawl/text/work_text.py` now drops any sentence an employer repeats
in three or more of its postings (when it is in a fifth of them), template lines and intro or benefit paragraphs, in every language. All
roles were re-embedded (10,022 of them had enough work text). Measured: the same-employer share among a role's 15 nearest fell from 26 %
to 22 % after the change, and the agreement with the declared role functions (NMI) from 0.423 to 0.430. English queries brought 35 %
German postings into the top 30 of roles in Germany (was 33 %). The employer effect is smaller but not gone: an employer's roles are often
genuinely similar work.

## 5. Grouping

Agreement (NMI) between the groups and the 17 role functions the reference board declares, on 8,667 roles. The declared functions are
the reference board's own labels, which this repository does not contain; the NMI therefore cannot be recomputed from here.

| method | groups | NMI |
|---|---|---|
| cosine neighbour graph and Leiden | 48 to 78 | 0.42 |
| shared-neighbour (SNN) weights | 73 to 103 | 0.41 |
| mutual-neighbour emphasis | 65 to 99 | 0.40 to 0.41 |
| employer signature removed (a = 0.8) | 43 to 74 | 0.44 |

SNN and mutual kNN, the usual remedies for "hub" points in high dimensions, did not help here; removing the employer signature did.

## 6. The Atlas layout

`jobcrawl/map/atlas.py`, in order:

1. Language directions removed from the vectors (above).
2. Employer signature removed (above).
3. A graph: every role linked to its k = 15 nearest roles by meaning.
4. Groups: Leiden community detection on the representatives, at two resolutions (regions and neighbourhoods; the counts are searched to about n^0.35 regions and three times as many neighbourhoods).
5. Representatives: at most `map.reps` (3) roles per employer and neighbourhood, so big employers neither fill a corner nor name the
   groups. The other roles sit next to their representative and show on request. In the final version 8,230 of the 10,235 roles are
   representatives; an earlier version had fewer, and lumped all employers without a company page together. That was fixed.
6. Placement: UMAP on the representatives (45 neighbours for the layout, `map.layout_k`, minimum distance 0.25), then a relaxation:
   * a radial redistribution that keeps each point's direction and evens the density ring by ring (plain UMAP gives a disc with a dense
     core: the density from centre to edge was 4.2 : 4.9 : 1.1 : 0.1 : 0.01);
   * a short-range push between points closer than a minimum distance.
   Measured on 4,000 roles against plain UMAP: rank correlation between the arrangement of groups and their true distances 0.52 to 0.59;
   nearest neighbours kept 25 to 18 %, the cost of the even disc.
7. Names: each group is named by its most distinctive title words (class-based TF-IDF), its leading board fields, and the statements it
   leans to. A labels file (`map.labels_file`) overrides the name of any group it can match (at least 40 % of its sample roles).
8. Links: for the finer groups, the share of neighbour links that cross from one group to another.

**Wrapping.** The share of each role's 15 nearest roles that stay among its 15 nearest on the map (3,000 roles): flat 26 %, torus (wraps both
ways) 25 %, sphere 8 %. Wrapping does not keep neighbourhoods better, so the map stays flat.

**Regional maps.** The bavaria, germany, europe and worldwide scopes each have their own layout and groups (11, 13, 17 and 23 regions in
the reference). A smaller area then spreads over the whole map instead of shrinking into a corner of the world map. A scope gets its own
map from `map.min_scope` (600) roles on, and the whole field always has the worldwide map. The demo has the bavaria map and the worldwide
map, which here hold the same roles.

## 7. Matching with keywords and vectors together

A role's score combines the keyword index (`jobcrawl/index/match_index.py`: BM25-style weights over the title, three times per word, and the
first 3,000 characters of the description) with the vector similarity. The keyword half expands query words through the profile's glossary
(each word also searches its counterpart at 0.7 weight). The statements and the visitor's ratings tilt the score as described in section 1.
Without vectors the keyword half is the whole score.
