# Storyline Studio — CloudKit setup

Build 27 keeps IndexedDB as the local working store and mirrors Storyline data to the signed-in user's private CloudKit database.

## CloudKit records

- `StorylineLibrary`: one JSON asset containing manuscripts plus revision items and saved voice-note audio.
- `StorylineProgress`: a small JSON record containing per-book reading positions. This can sync frequently without re-uploading the manuscript asset.

The private database is used; Storyline does not use the public database for manuscript data.

## Apple-side setup

1. Create or choose an iCloud/CloudKit container for Storyline in the Apple Developer tools.
2. In the development environment, create these record types in CloudKit Database:\n   - `StorylineLibrary`: `payload` (Asset), `updatedAt` (Date/Time), `deviceID` (String), `schemaVersion` (Int(64)).\n   - `StorylineProgress`: `payload` (String), `updatedAt` (Date/Time), `deviceID` (String), `schemaVersion` (Int(64)).
3. Enable CloudKit web services and create an API token for the container.
4. Restrict the token's allowed origin to the deployed Storyline website.
5. Put the container identifier and browser API token in `cloudkit-config.js`, set the correct environment, and change `enabled` to `true`.
6. Test in development before deploying the CloudKit schema to production. After production deployment, set `environment` to `production`.

Do not place a server-to-server private key in this repository. CloudKit JS user authentication uses the browser API token plus Apple's sign-in flow.
