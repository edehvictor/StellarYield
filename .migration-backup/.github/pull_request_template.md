## Description
<!-- Describe your changes in detail -->
Fixes # (issue number)

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Verification Commands
<!-- Check the boxes after you run the verification commands -->
- [ ] `npm run lint` / `npm run test` (Frontend/Backend)
- [ ] `cargo fmt` / `cargo clippy` / `cargo test` (Smart Contracts)

### Contract Security (if `contracts/` changed)
- [ ] Storage schema changes documented or migration provided
- [ ] All entry points have authorization checks
- [ ] Arithmetic uses checked operations
- [ ] New entry points have unit tests including unauthorized callers
- [ ] No new admin roles without governance proposal

## UI Snapshot Checklist

**If your PR modifies the frontend UI:**
- [ ] Screenshots provided for Desktop (1024px+)
- [ ] Screenshots provided for Mobile (375px)
- [ ] Screenshots provided for Tablet (768px) — optional if layout is identical to desktop
- [ ] No visual changes (checked only if UI is unchanged; explain briefly)

**For no visual changes example:**
> This PR refactors API logic in the dashboard without changing the rendered output.

**Snapshot tips:**
- Use Chrome DevTools (F12) → Toggle device toolbar to test responsive sizes
- Include hover, focus, and active states if applicable
- Test the Vercel Preview link in the checks section (most representative)
- Ensure text contrast is high and interactive elements are properly sized

**Learn more:** See [docs/contributor-guide.md — UI Snapshots & Visual Review Checklist](../docs/contributor-guide.md#ui-snapshots--visual-review-checklist)

## Screenshots (if applicable)
<!-- Drag-and-drop or paste screenshots here -->
<!-- Example format: 
### Desktop (1024px)
![](url or drag-drop image)

### Mobile (375px)
![](url or drag-drop image)
-->

## Additional Notes
<!-- Any additional context, trade-offs, or decisions worth noting -->

## Checklist
- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
