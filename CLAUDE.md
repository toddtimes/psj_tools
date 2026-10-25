Read README.md first. Its "Rules that must not break" section is the contract for this repo: no external resources, no inline script/style/handlers, escape all PDF-derived text, no report files in the repo, check parsed figures against report totals, no network requests.

- Only `site/` is published. Repo-level files (README, configs, `scripts/`) are not.
- Run `npm run lint` before every commit; Cloudflare refuses to deploy when it fails.
- Every push to `main` deploys, so each commit must leave the site working on its own. In particular, never commit a CSP change before the pages comply with it.
- Report PDFs contain customer names and addresses. Never commit, attach or paste one; test with real reports kept outside the repo, or synthetic ones.
