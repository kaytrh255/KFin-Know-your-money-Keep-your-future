# Staging deployment — verification run 2026-10-17 (second pass)

HEAD: `d3bc6aa` on `arena/bfaf5019-kfin-know-your-money-keep-your`, PR #10
(draft, open). This run continued from `839d006`, whose deployment path is
recorded in [`2026-10-17-STAGING-DEPLOYMENT.md`](2026-10-17-STAGING-DEPLOYMENT.md).
It adds the missing acceptance proof: registration and sign-in on the deployed
URL, executed in CI and locally.

**No staging host exists yet.** No VM, DNS record, certificate or GitHub
Environment was created or assumed, and nothing was published to GHCR (the
publish job only runs on `workflow_dispatch`).

## Change in this run

`d3bc6aa` — `test(staging): prove registration and sign-in on the deployed URL`

- `scripts/smoke/staging-smoke.mjs`: `STAGING_INVITATION_CODE` registers a fresh
  user, signs it in, checks the `__Host-` cookie flags and performs an
  authenticated read. The invitation code is never printed.
- `.github/workflows/staging.yml`: the rehearsal mints one invitation with
  `kfin_operator` inside the stack and passes it to the smoke test; the deploy
  job does the same on the host (`/opt/kfin-staging/operator.env`, code masked
  in the run log) before the public-URL smoke test. Deploy runs skip it when
  `verify_register_login` is false.
- `deploy/staging/README.md`, `docs/operations/STAGING-DEPLOYMENT.md`: document
  the operator credential and what a passing journey proves.

## Executed in CI

| Run | Workflow | Commit | Result |
| --- | --- | --- | --- |
| `39034139401` | Staging | `d3bc6aa` | **success** — rehearsal incl. "Mint a rehearsal invitation" and "Run the staging smoke test over HTTPS"; publish and deploy skipped (pull request) |
| `39034139411` | Financial foundation CI | `d3bc6aa` | **success** — `verify` and `image` |

The rehearsal steps that ran: database, least-privilege roles, image build from
the commit, migrations as `kfin_migrator`, stack behind Caddy with its internal
CA, HTTPS wait, invitation minted as `kfin_operator`, smoke test with
`STAGING_CA_FILE` and the invitation code, teardown. A passing smoke step means
`auth.registration`, `auth.registration-login`,
`auth.registration-session-cookie` and `auth.registration-read` all returned
pass; the script exits non-zero on the first failure. The JSON report is not
retrievable here (GitHub's Actions log endpoints are blocked from this
sandbox), so the evidence is the step result rather than its stdout.

This is registration and sign-in through a real TLS edge, a real Caddy
container, the production image and a real PostgreSQL — but on a disposable
runner, not on an owner host.

## Executed locally

- Production artifact rebuilt from `d3bc6aa` (`production artifact ready …
  commit 839d006e8`; source unchanged since `839d006` for the app itself).
- `scripts/smoke/staging-smoke.mjs` against the artifact behind a TLS proxy with
  a CA passed to `STAGING_CA_FILE`: 16 reported checks — **15 executed and all
  passed**, 1 skipped (`auth.session`, because no pre-existing credentials were
  supplied). The four registration checks added here were
  `auth.registration` 202, `auth.registration-login` 200,
  `auth.registration-session-cookie` pass and `auth.registration-read` 200.
- The same production artifact, started as it would be on staging
  (`NODE_ENV=production`, `STAGING_MODE=true`, `EMAIL_DELIVERY_ADAPTER=none`,
  `AUTH_COOKIE_SECURE=true`), answered directly:
  `POST /api/v1/auth/register` → **202**, `POST /api/v1/auth/login` → **200**
  with `__Host-kfin_session; Path=/; SameSite=Lax; HttpOnly; Secure` and
  `kfin_csrf; SameSite=Strict; Secure`, `GET /api/v1/auth/me` → **200** with the
  registered address.
- `corepack pnpm run check` → exit 0: evidence 17/17, config 29/29, vitest 752
  passed / 150 skipped (integration files without a database).

## Is there a staging HTTPS URL?

**No.** `gh api .../environments` reports `total_count: 0`: the repository has
no `staging` environment, so no SSH host, DNS name, certificate or database
credential exists for a deploy. The workflow cannot reach a real host until the
owner supplies them.

For a live look at the product, a throwaway preview of the same production
artifact is running in this session at
`https://3000-<sandbox-id>.e2b.app` (open it in a new tab, not the embedded
frame, because the session cookie is `SameSite=Lax` and a third-party iframe
would not send it). It is **not** staging: it is ephemeral, uses the sandbox
database, has no Caddy, no managed certificate lifecycle and no deploy history.
It exists only to let a human click through the same registration and sign-in
that the checks above exercise.

## Remaining blockers, in order

1. **A host.** A Linux VM (2 vCPU / 2–4 GB) with Docker ≥ 24 and Compose ≥ 2.17,
   TCP 22/80/443 open, and a non-root deploy user in the `docker` group.
2. **DNS.** `A`/`AAAA` for the staging hostname pointing at that VM; Caddy
   issues the Let's Encrypt certificate on the first HTTPS request.
3. **GitHub Environment `staging`** with `STAGING_HOST`, `STAGING_USER`,
   `STAGING_SSH_KEY`, `STAGING_KNOWN_HOSTS`, `STAGING_SITE_ADDRESS`,
   `STAGING_TLS_ARGS`, `STAGING_AUTH_SECRET`,
   `STAGING_FINANCIAL_PREVIEW_SIGNING_KEY`, `STAGING_DB_ADMIN_PASSWORD`,
   `KFIN_APP_PASSWORD`, `KFIN_MIGRATOR_PASSWORD`, `KFIN_OPERATOR_PASSWORD`.
4. **One dispatch with `provision_roles = true`** on the default branch (the
   workflow must exist there for `workflow_dispatch`). It creates the three
   roles, migrates, deploys, mints the invitation and runs the smoke test.
5. Only after those: `workflow_dispatch` publishes
   `ghcr.io/kaytrh255/kfin-runtime:sha-<commit>` and the run reports the
   staging URL and the registration/sign-in result.

None of these can be completed from inside the repository or this sandbox.
