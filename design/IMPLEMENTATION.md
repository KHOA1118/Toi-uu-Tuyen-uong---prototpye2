# Approved SOPTIX visual redesign

Implemented the approved Figma layout in `frontend/index.html` and `frontend/style.css` only: compact header and KPI strip, map-first desktop workspace, independently scrolling operations panel, and stacked narrow-screen layout. Existing map layers, customer markers, controls, IDs, labels, and handlers are preserved.

## Verification (2026-10-04)

- Desktop 1440×900 and 1366×768: no page overflow; map and operations panel fit the viewport.
- Narrow viewport 390×844: map and operations stack without horizontal overflow (375px usable document width with scrollbar).
- Browser demo on port 8017 uses the existing candidate preview tool and `data/three_affected_local_candidate_16.json`; it does not replace the official fixture.
- Real demo detected the incident and applied three real LNS route updates. Browser console contained no warnings/errors.
- Demo completed at 150.0 simulated seconds: all six vehicles returned to depot, each serving four customers (24 total); displayed remaining-work travel-time saving was 80.6 seconds.
- Manual controls verified: before/after route view, zoom in/out/fit, customer selection, reset → start → pause → resume → reset. UI correctly showed paused, running, and ready at 0.0 seconds.
- Python: 92 tests run, 90 passed, 2 skipped.
- Node against official server 8016: 37 tests, 36 passed, 1 existing strict presentation failure. Seed 54 does not meet the visible-change/avoidance/distinct-detour contract. This remains a scenario limitation, not fixed by the visual redesign.
- Build passed: Python syntax, static assets, fixed map SHA256 and dist generation.
- All 73 static IDs and 14 static button elements match the saved pre-redesign baseline. No duplicate IDs.
- SHA256 comparison confirms all five frontend JavaScript files and `lns/core.py` unchanged from the start of this visual implementation.

Test output: `redesign-python-tests.log`, `redesign-node-tests.log`. Baseline evidence: `pre-redesign-hashes.json`, `pre-redesign-dom.json`.

No commit, push, fixture installation, scenario search, or backend change was performed for this redesign.
