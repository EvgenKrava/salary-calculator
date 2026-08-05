# Lambda bundles

Terraform packages pre-built JS bundles rather than building during apply, so `plan` output
is stable and apply does not depend on a working toolchain.

Run before every `terraform plan` / `apply`:

```bash
./infra/build/build.sh
```

Outputs:

| Bundle | Source | Lambda |
|---|---|---|
| `packages/api/dist/api.js` | `packages/api/src/handler.ts` | API (behind API Gateway) |
| `packages/api/dist/migrate.js` | `packages/api/src/migrationHandler.ts` | schema migration (manual invoke) |
| `packages/extraction/dist/extract.js` | the extraction package | document extraction (S3-triggered) |

The AWS SDK v3 is excluded from the bundles — the Node 20 Lambda runtime provides it.
