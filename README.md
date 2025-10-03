# Baseline Guard

A GitHub Action to enforce Web Platform Baseline compliance in your CI pipeline.

## Features
- Enforces `widely`, `newly`, or year-based (e.g., `2023`) Baseline targets.
- Scans CSS files using `doiuse` and JavaScript files for non-compliant APIs against `web-features` data.
- Generates an HTML report with actionable MDN links for violations.
- Fails CI builds on non-compliant features.

## Setup
```bash
npm install
npm run build