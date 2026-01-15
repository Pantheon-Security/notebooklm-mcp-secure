# Release Checklist

## 1. Dependency Audit & Update

- [ ] Run `npm outdated` - check for outdated packages
- [ ] Run `npm audit` - check for security vulnerabilities
- [ ] Update critical dependencies:
  - [ ] `@modelcontextprotocol/sdk` - check [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) for latest
  - [ ] `patchright` - browser automation
  - [ ] Other security-related packages
- [ ] Run `npm audit fix` if vulnerabilities found
- [ ] Test build after updates: `npm run build`

## 2. Pre-Release Verification

- [ ] Run `npm run build` - verify no TypeScript errors
- [ ] Run `npm test` (if tests exist)
- [ ] Manual test critical features if major changes

## 3. Version Bump

- [ ] Determine version type:
  - `patch` (2026.1.x) - bug fixes, dependency updates
  - `minor` (2026.x.0) - new features, non-breaking
  - `major` (x.0.0) - breaking changes
- [ ] Run `npm version patch|minor|major --no-git-tag-version`
- [ ] Commit: `git add . && git commit -m "chore: bump version to X.X.X"`

## 4. Publish

- [ ] Push to GitHub: `git push origin main`
- [ ] Publish to npm: `npm publish --access public`
- [ ] Create GitHub release:
  ```bash
  gh release create vX.X.X --title "vX.X.X - Title" --notes "changelog"
  ```

## 5. Post-Release Verification

- [ ] Verify npm: `npm view @pan-sec/notebooklm-mcp version`
- [ ] Verify GitHub release exists
- [ ] Update README if new features/config added

## Quick Commands

```bash
# Full dependency check
npm outdated && npm audit

# Update specific package
npm install @modelcontextprotocol/sdk@latest --save

# Full release flow
npm run build && npm version patch --no-git-tag-version && git add . && git commit -m "chore: release" && git push && npm publish --access public
```
