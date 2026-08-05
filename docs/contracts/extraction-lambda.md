# Extraction Lambda — deployment contract

Terraform (`infra/extraction.tf`) owns this function's AWS resources; the
`@salary/extraction` package owns its code. This file is the interface between them —
**change it in both plans or not at all.**

## Bundle

| | |
|---|---|
| Build command | `pnpm --filter @salary/extraction bundle` |
| Bundle path | `packages/extraction/dist/extract.js` |
| Lambda handler | `extract.handler` |
| Runtime | `nodejs20.x` |
| Timeout | 300s (vision on a multi-page PDF is slow) |
| Memory | 1024 MB |

## Trigger

An S3 `ObjectCreated:*` notification on the documents bucket, filtered to the `uploads/`
key prefix. The handler receives a standard `S3Event`.

Key convention the uploader must follow:

```
uploads/<docType>/<uuid>-<original-filename>
```

`<docType>` is `revenue` or `schedule` — it tells the extractor which schema to request
without a database round trip.

## Environment variables

| Name | Purpose |
|---|---|
| `AWS_REGION_NAME` | Region (`AWS_REGION` is reserved by the runtime and set automatically) |
| `DB_RESOURCE_ARN` | Aurora cluster ARN, for the RDS Data API |
| `DB_SECRET_ARN` | Secrets Manager ARN holding the DB credentials |
| `DB_NAME` | Database name |
| `DOCUMENTS_BUCKET` | The bucket the object was uploaded to |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key for the Anthropic SDK |
| `BEDROCK_MODEL_ID` | Defaults to `anthropic.claude-opus-5` |
| `CONFIDENCE_THRESHOLD` | At or above this, stage as approved; below, queue for review |

## IAM already granted

`s3:GetObject` on the documents bucket, `bedrock:InvokeModel` on `anthropic.*` models,
RDS Data API + Secrets Manager on the one cluster, and CloudWatch Logs. The handler needs
no other AWS permission — if it does, that is a contract change.

**The `bedrock:InvokeModel` grant is not what authorizes the Claude call today.** The handler
uses `AnthropicBedrockMantle` with the `AWS_BEARER_TOKEN_BEDROCK` API key, and a bearer token
carries its own identity — authorization is evaluated against the principal that *generated the
key*, not the Lambda's execution role. So the `anthropic.*` scoping in `infra/iam.tf` reads like
a least-privilege boundary but does not constrain this call path; it is kept as
defence-in-depth in case the handler ever moves to SigV4. To bound the real blast radius (the
token is a long-lived credential sitting in a Lambda env var), scope the permissions of the
identity used to run `aws bedrock create-api-key`.

## Expected behaviour

Write an `extraction_jobs` row for every invocation, including failures, so nothing is
silently dropped. A Bedrock refusal (`stop_reason: 'refusal'`) is a `rejected` job, not a
crash.
