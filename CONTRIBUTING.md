# Contributing

Thanks for helping keep the R6 Siege Randomizer up to date. This guide has two layers: the five-minute checklists first, then the details. The illustrated version, with step-by-step help for GitHub in the browser, is at **https://jojaweb.com/r6random/docs/contributing.html**. A complete example (adding Noor) is at https://jojaweb.com/r6random/docs/example-noor.html.

Anyone can open a pull request. The maintainer reviews and merges, and publishes new content packs. Nothing reaches players until the maintainer tags a release.

---

## The five-minute version

### Add an operator

- [ ] Read the operator's page on ubisoft.com and the season's patch notes.
- [ ] Create a branch `add-<id>`, then run `npm run new -- operator <id>`.
- [ ] Fill in `name`, `side`, `roles`, `armor`, `speed`, `released`, `ability` and `loadout`.
- [ ] Every weapon and gadget id exists in `data/`. Add missing ones first.
- [ ] Add `icons/operators/<id>.svg` and `icons/abilities/<ability-id>.svg`.
- [ ] `npm run validate` shows no errors.
- [ ] Open a pull request titled `Add Noor (Y11S3)` with a link to the source.

### Fix a loadout

- [ ] Find the change in the official patch notes and copy the link.
- [ ] Edit `data/operators/<id>.json`: add or remove ids in `primary`, `secondary` or `gadgets`.
- [ ] Validate (locally, or let the check on the pull request do it).
- [ ] Title: `Fix Buck loadout` or `Apply Y11S3.2 loadout changes`.

### Add a weapon or gadget

- [ ] Check it does not already exist under another id.
- [ ] `npm run new -- weapon <id>` or `npm run new -- gadget <id>`.
- [ ] Weapon: set `name`, `slot` and `class`; add `attachments` only where it differs from its class.
- [ ] Gadget: set `name.en` and `side`.
- [ ] Add the icon, reference the id from at least one operator, validate, open the pull request.

### Add a translation

- [ ] Run `npm run validate -- --translations` and pick a warning.
- [ ] Add `de`, `fr` or `lb` next to `en`, using the game's wording in that language.

### Report something without editing

- In the app: Settings → Report a problem → GitHub issue (or Email).
- On GitHub: Issues → New issue → **Wrong loadout** or **Missing operator, weapon or gadget**.

---

## Setup

Small changes (one loadout, a name, a translation) work in the GitHub web editor: open the file, click the pencil, commit, and GitHub opens a fork and pull request for you. The `validate` check runs on the pull request.

For anything with new files or icons, work locally:

```sh
git clone https://github.com/<you>/r6random-content.git
cd r6random-content
git remote add upstream https://github.com/JayRasp/r6random-content.git
npm ci                      # Node.js 22 or newer
git switch -c add-noor      # one branch per pull request
```

Each data file starts with a `"$schema"` line, so editors such as Visual Studio Code complete field names and underline mistakes while you type.

## Commands

| Command | Use |
| --- | --- |
| `npm run validate` | All checks. Errors must be fixed; warnings are information. |
| `npm run validate -- --translations` | Also lists every text without a German, French or Luxembourgish version. |
| `npm run new -- operator <id>` | New file from `templates/` (also `weapon`, `gadget`). Never overwrites. |
| `npm run build -- --version 2026.09.0` | Optional: builds the pack into `dist/` so you can inspect the result. |
| `npm run changelog -- --base content-2026.03.0` | Optional: the change list the next release will show. |
| `npm run preview` | Optional: serves `dist/` on port 8080. |

`dist/`, `node_modules/` and `keys/` are ignored by git. Never commit them.

## Files and fields

### Operator: `data/operators/<id>.json`

```json
{
  "$schema": "../../schema/operator.schema.json",
  "id": "noor",
  "name": "Noor",
  "side": "defense",
  "type": "standard",
  "roles": ["anti-entry", "crowd-control"],
  "armor": 2,
  "speed": 2,
  "released": "Y11S3",
  "ability": {
    "id": "horus-lance-launcher",
    "name": { "en": "Horus Lance Launcher" }
  },
  "loadout": {
    "primary": ["commando-9", "alda-5-56"],
    "secondary": ["1911-tacops", "bailiff-410"],
    "gadgets": ["deployable-shield", "barbed-wire"]
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Same as the file name. Never changes after release. |
| `name` | yes | Exactly as in the game, with accents (Capitão, Jäger). Not translated. |
| `side` | yes | `attack` or `defense`. |
| `type` | no | `standard` (default) or `gadgetKit` (Striker, Sentry only). |
| `roles` | yes | 1 to 3 of: `anti-entry`, `anti-gadget`, `breach`, `crowd-control`, `front-line`, `intel`, `map-control`, `support`, `trapper`. |
| `armor`, `speed` | yes | 1, 2 or 3. |
| `released` | yes | Season of release, for example `Y11S3`. Launch operators: `Y1S0`. |
| `ability.id` | yes | Slug of the English ability name without any part in brackets. Unique. Names the icon file. |
| `ability.name` | yes | `{ "en": … }`; `de`, `fr`, `lb` optional. |
| `loadout.primary` / `secondary` | yes | Weapon ids with the matching `slot`. At least one each. |
| `loadout.gadgets` | yes | Gadget ids of the same side. At least one. |
| `loadout.gadgetPicks` | no | Default 1. Gadget kits: 2, with more gadgets in the pool than picks. |
| `aliases` | no | Earlier ids, only after an id change. |
| `legacyId` | no | Only in operators that existed before app 2.0.0. Never add or change it. |

There is no icon field. Icons are found by convention: `icons/operators/<id>.*` and `icons/abilities/<ability-id>.*`.

### Weapon: `data/weapons/<id>.json`

```json
{
  "$schema": "../../schema/weapon.schema.json",
  "id": "commando-9",
  "name": "Commando 9",
  "slot": "primary",
  "class": "assault-rifle",
  "attachments": {
    "sight": { "remove": ["magnified-a", "magnified-b", "magnified-c"] }
  }
}
```

`class` is one of `assault-rifle`, `smg`, `lmg`, `marksman-rifle`, `shotgun`, `slug-shotgun`, `shield`, `handgun`, `machine-pistol`, `hand-cannon`. It decides the default attachments in `data/attachments/classes.json`.

`attachments` is optional and lists only differences, per slot (`sight`, `barrel`, `grip`, `underbarrel`):

| Override | Effect | Example |
| --- | --- | --- |
| `remove` | Takes ids out of the class default. | Commando 9: no magnified sights |
| `add` | Adds ids to the class default. | DP27: `"add": ["reflex-d"]` |
| `replace` | The slot has exactly these ids; `[]` means none. | Bailiff 410: `"sight": { "replace": [] }` |

Every attachment id must exist in `data/attachments/attachments.json` with the matching slot. A change that affects a whole class goes into `classes.json` instead.

### Gadget: `data/gadgets/<id>.json`

```json
{
  "$schema": "../../schema/gadget.schema.json",
  "id": "frag-grenade",
  "name": { "en": "Frag Grenade" },
  "side": "attack"
}
```

Only general gadgets that several operators can carry. An operator's unique ability belongs in the operator file. Translations are optional: add `"de"`, `"fr"` or `"lb"` next to `"en"`, for example `"de": "Splittergranate"`.

### Ids

Lowercase letters a to z, digits and single hyphens. Made from the English name: lowercase, drop accents (ä → a, ø → o), replace every run of other characters with one hyphen, trim hyphens at the ends.

| Name | Id |
| --- | --- |
| Jäger | `jager` |
| ALDA 5.56 | `alda-5-56` |
| .44 Mag Semi-Auto | `44-mag-semi-auto` |
| SK 4-12 (Skeleton Key) | `sk-4-12` |

File names match ids exactly, including case: `Noor.json` fails on the Linux machine that runs the checks.

## Icons

| Rule | Requirement |
| --- | --- |
| Format | SVG preferred. PNG or WebP when no vector version exists. JPEG is not accepted. |
| Size | PNG/WebP at least 256 × 256 px. SVG needs a `viewBox`. |
| Shape | Square. |
| Background | Transparent. No filled square or full-size rectangle behind the artwork. |
| File size | 512 KB or less. |
| Content | SVG without scripts, external links or embedded images. Convert text to paths. |
| Name | `icons/<kind>/<id>.svg` (or `.png`, `.webp`), one file per id. |
| Style | Operators: the emblem style of the existing set. Abilities, weapons, gadgets: white artwork, no badge. Weapons in side view, muzzle to the right, centred with transparent space above and below. |

`npm run validate` checks everything except the style. The build turns every icon into a 256 px WebP whose file name contains a content hash, so a replaced icon always reaches players.

**Sources and credit.** Operator icons follow [marcopixel/r6operators](https://github.com/marcopixel/r6operators) (MIT); if the icon exists there, use it and say so in the pull request. Abilities, weapons and gadgets are redrawn from the game's icons as clean white shapes. Your own drawings are welcome; say so in the pull request. Do not submit icons from sites that do not allow reuse. Artwork that shows Rainbow Six Siege content belongs to Ubisoft; see [LICENSE](LICENSE).

## Translations

English is required for every text players read; German (`de`), French (`fr`) and Luxembourgish (`lb`) are optional. Missing ones are warnings, and the app shows English instead. Use the wording the game uses in that language. Luxembourgish is not a game language: write it in the official spelling, including the n-rule. Operator names, weapon names and season labels are never translated.

## Renames and removals

- **Renamed in the game:** change `name`, keep `id`. Players' presets store ids.
- **An id must change** (rare, for example a misspelt id): rename the file, change `id`, update every reference and add the old id to `aliases`.
- **Removed from the game:** delete the data file and its icon, and remove the id from every loadout (validate lists each one). There is no "deprecated" flag. The changelog records the removal by itself, and players' presets keep the id in case it returns.

## What the checks report

Every message names the file and the field, and most come with a `Fix:` line. On a pull request, the same messages appear next to the changed files.

```
data/operators/noor.json
  error    loadout.primary[1]: "alda-556" is not a known weapon. Did you mean "alda-5-56"?
           Fix: Use a file name from data/weapons/ (without .json), or add the weapon first: npm run new -- weapon alda-556
  error    side: "defence" is not allowed. Did you mean "defense"?
           Fix: Use one of: attack, defense.
  error    loadout.gadgets[1]: "claymore" is an attack gadget, but Noor is on defense.
           Fix: Pick a defense gadget. The defense gadgets are: barbed-wire, bulletproof-camera, …

icons/operators/noor.png
  error    The background is not transparent: the corner pixels are filled.
           Fix: Remove the background and export with transparency. The app draws its own background.
```

| Kind of message | Usual cause |
| --- | --- |
| `Not valid JSON … (line 18, column 3)` | A missing or extra comma, or a missing quote, near that line. |
| `missing the field "released"` | A required field is missing. |
| `unknown field "armour". Did you mean "armor"?` | A typo in a field name. |
| `"defence" is not allowed` | A value outside the allowed list; the `Fix:` line lists them. |
| `is not a valid id` | Capitals, spaces or accents in an id; the fix suggests the slug. |
| `is not a known weapon` / `gadget` | The id has no file in `data/`. |
| `is a secondary weapon, but it is listed as primary` | Wrong loadout list, or wrong `slot` in the weapon file. |
| `The file name and the id differ` | `noor.json` must contain `"id": "noor"`. |
| `No icon for the operator "noor"` | The icon is missing or named differently. |
| `has no de, fr, lb translation` (warning) | Optional translation missing. |

## Testing on a phone (optional)

Builds from your computer are not signed, so only a debug build of the app accepts them. If you have one: `npm run build -- --version 2026.09.1`, then `npm run preview`, then in the app tap the content version in About 7 times and set Content source to the "phone (Wi-Fi)" address the preview prints. Use a version higher than the one on the phone. Otherwise, ask in the pull request and the maintainer tests it during review.

## Pull requests

- One topic per pull request. Short imperative title: `Add Noor (Y11S3)`, `Fix Buck loadout`, `Add Luxembourgish gadget names`.
- Link the source for every data change: operator page, patch notes, or a screenshot of the loadout screen. When patch notes and the game disagree, the game wins.
- Fill in the checklist from the template.
- Draft pull requests are fine for work in progress.

After you open it, the `validate` check runs. The maintainer reviews, may ask for changes, and merges. Your change reaches players with the next release. A new season is released on season day once it is live; operators whose data arrives later follow within a few days.

## Licence of contributions

By opening a pull request you agree that your contribution is published under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), like the rest of the repository (icons: see [LICENSE](LICENSE)).

Questions: open an issue or write to contact@jojaweb.lu.
