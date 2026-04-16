# Releasing pi-oracle

This repository is installable through pi directly from git. The standard release flow is therefore a tagged git release.

## Preconditions

- `gh auth status` succeeds.
- `npm install` has been run.
- Oracle browser mode and pi are configured well enough for the integration checks.
- The working tree is clean before tagging.

## Release Steps

1. Update the package version in `package.json` if the release should carry a new package version.
2. Run the full validation bundle:

   ```bash
   npm run release:check
   ```

   This now includes:
   - `npm run validate:wrapper:preview`
   - `npm run validate:wrapper:error`
   - `npm run validate:wrapper:retrieve`
   - `npm run validate:wrapper:background`

3. Review the pending diff and commit it:

   ```bash
   git status --short
   git add .
   git commit -m "Prepare vX.Y.Z"
   ```

4. Create and push the annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "Release X.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

5. Publish the GitHub Release:

   ```bash
   gh release create vX.Y.Z --title 'vX.Y.Z' --notes 'Release notes here'
   ```

6. Verify the pinned install path from pi:

   ```bash
   pi install git:github.com/lulucatdev/pi-oracle@vX.Y.Z
   ```

## Notes

- `pi update` refreshes unpinned git installs such as `git:github.com/lulucatdev/pi-oracle`.
- Pinned installs such as `git:github.com/lulucatdev/pi-oracle@vX.Y.Z` are intentionally skipped by `pi update`.
- `.pi/` and `node_modules/` are ignored by git and should remain untracked.
- `.pi/oracle/` stores local Oracle result bodies and metadata; treat it as ephemeral runtime state, not release content.
