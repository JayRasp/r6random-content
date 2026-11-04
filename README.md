# R6 Siege Randomizer content

Operator, weapon and gadget data for the [R6 Siege Randomizer](https://play.google.com/store/apps/details?id=lu.jojaweb.rainbow6siegerandomizer) Android app.

The app loads this data from **https://content.jojaweb.com/v1/manifest.json**. New operators, loadout fixes and new weapons therefore reach players without an app update. Anyone can suggest a change with a pull request; the maintainer reviews it and publishes a new content pack.

Full documentation: **https://jojaweb.com/r6random/docs/**

## How the app uses this repository

1. Once a day, on the first start of the day, the app asks for `v1/manifest.json` (a conditional request with `If-None-Match`). Most days the answer is "not modified" and nothing else happens.
2. When there is a newer manifest, the app checks its Ed25519 signature (`manifest.json.sig`) against the public key built into the app. An unsigned or altered manifest is ignored.
3. The app downloads the pack (`v1/packs/<version>.json`) and only the images it does not have yet. Every file is checked against the sha256 listed in the signed manifest.
4. Depending on the player's settings, the app asks first or installs the update with an undo option. The previous pack is kept, so "Revert to previous content" works offline.

Players can turn automatic updates off, limit them to Wi-Fi, or switch to offline mode (no network requests at all). Every app release also bundles a pinned pack, so a fresh install works without a connection.

## What is in here

```
data/
  operators/<id>.json         one file per operator
  weapons/<id>.json           one file per weapon
  gadgets/<id>.json           general gadgets (frag grenade, barbed wire …)
  attachments/classes.json    attachment defaults per weapon class
  attachments/attachments.json  all attachments (sight, barrel, grip, underbarrel)
  roles.json                  role names in English, German, French, Luxembourgish
  meta.json                   label and release note for the next pack
  messages.json               messages shown to players
icons/
  operators/ abilities/ weapons/ gadgets/   <id>.svg (preferred), .png or .webp
schema/                       JSON Schema for every file above, plus manifest and pack
scripts/                      validate, build, changelog, new, preview, keygen, sign
templates/                    starting points for npm run new
.github/                      checks, publishing, issue forms
```

## Quick start

You need [Node.js](https://nodejs.org/) 22 or newer and git.

```sh
git clone https://github.com/JayRasp/r6random-content.git
cd r6random-content
npm ci
npm run validate
```

To add an operator:

```sh
npm run new -- operator noor          # creates data/operators/noor.json
# edit the file, add icons/operators/noor.svg and icons/abilities/<ability id>.svg
npm run validate                      # fix anything it reports
```

Then open a pull request. Small fixes (one loadout entry, a name) also work directly in the GitHub web editor; the checks run on the pull request either way.

[CONTRIBUTING.md](CONTRIBUTING.md) has the full guide.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the four dependencies (ajv, ajv-formats, sharp, svgo). |
| `npm run validate` | Checks schemas, references between files, icons and translations. Errors fail, warnings do not. |
| `npm run new -- operator <id>` | Creates a new operator file from the template (also `weapon`, `gadget`). |
| `npm run build -- --version 2026.09.0 --label Y11S3.0` | Writes the pack, images and manifest to `dist/`. |
| `npm run changelog -- --base content-2026.03.0` | Lists what changed since a release tag. |
| `npm run preview` | Serves `dist/` on http://localhost:8080 for testing with a debug build of the app. |
| `npm run keygen` | Creates the signing key pair (maintainer only, once). |
| `npm run sign -- dist/v1/manifest.json` | Signs the manifest (maintainer and publish workflow only). |

## Publishing

Only the maintainer publishes. After pull requests are merged into `main`, the maintainer pushes a tag such as `content-2026.09.0`. The publish workflow then waits for the maintainer's approval, builds the pack, signs the manifest and deploys it to GitHub Pages at content.jojaweb.com. Every player gets the new pack on their next daily check.

## Reporting problems

- In the app: Settings → Report a problem (pre-fills the app and content version).
- [Open an issue](https://github.com/JayRasp/r6random-content/issues/new/choose). Issues are public.
- Email: contact@jojaweb.lu

## Licence

Data, schemas, scripts and documentation: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The icon artwork is not covered by that licence; see [LICENSE](LICENSE) for details and credits.

Tom Clancy's Rainbow Six Siege is a trademark of Ubisoft Entertainment. This project is not affiliated with or endorsed by Ubisoft.
