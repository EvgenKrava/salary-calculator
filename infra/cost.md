# Running cost

**Target: under $10/month.** Prices are `us-east-1`, the configured default region, as of
August 2026. AWS pricing changes — treat these as the basis for the estimate, not a quote.

## Estimated monthly bill at expected usage

Expected usage: one coffee-shop chain, a handful of managers, two salary runs a month, a few
dozen document uploads, a static SPA of ~400 KB.

| Service | Config | Est. / month |
|---|---|---|
| **Aurora Serverless v2** | `min_capacity = 0` → pauses when idle | **~$0** ACU + ~$0.10 storage |
| **Lambda** (api, migrate, extraction) | on demand, no provisioned concurrency | **$0** (free tier: 1M req, 400k GB-s) |
| **API Gateway** (HTTP API) | on demand | **$0** (free tier: 1M req for 12 mo, then ~$1/M) |
| **CloudFront** | `PriceClass_100` | **$0** (perpetual free tier: 1 TB out, 10M req) |
| **S3** (frontend + documents) | few hundred MB | **~$0.02** |
| **Cognito** | no advanced security | **$0** (free tier: 50k MAU) |
| **Secrets Manager** | 1 secret (DB master password) | **$0.40** |
| **CloudWatch Logs** | 14-day retention | **~$0.10** |
| **Bedrock** (Claude Opus 5 vision) | ~30 documents/month | **~$1–3** |
| **Total** | | **~$2–4** |

The two variable line items are Bedrock and Aurora. Everything else is fixed and small.

## What keeps it there — do not undo these without re-checking the budget

1. **Aurora `min_capacity = 0`** (`variables.tf`, `database.tf`). This is the whole ballgame.
   At `0.5` the cluster bills ~0.5 ACU × 730 h × $0.12 ≈ **$44/month while completely idle** —
   over 4× the entire budget by itself. Cost of scale-to-zero: ~15 s resume on the first
   request after `db_seconds_until_auto_pause` (300 s) of inactivity.
2. **No NAT gateway.** Lambdas reach Aurora via the **RDS Data API**, so none is VPC-attached
   and no NAT is needed. A single NAT gateway is ~$32/month + data — it would triple the bill
   on its own. This is the main architectural reason the Data API was chosen, so putting a
   Lambda in the VPC is a budget decision, not just a networking one.
3. **`maximum_retry_attempts = 0`** on the extraction Lambda (`extraction.tf`). S3 invokes
   asynchronously, where AWS retries twice by default — 3× the Bedrock cost per failure, for
   no benefit, since the handler already records every failure as a reviewable row.
4. **`db_max_acu = 1`** caps the worst case. A runaway query pinned at max for a month is
   ~$88 rather than the ~$175 that 2 ACUs would allow. Not cheap, but bounded — and the
   forecast alarm fires long before month end.
5. **`CONFIDENCE_THRESHOLD` and no auto-reprocessing.** Each document is one Bedrock call.
   Re-extraction is a manual re-upload, so cost scales with documents, not with retries.
6. **14-day log retention.** Lambda log groups default to *never expire*; unbounded retention
   is a slow leak that grows forever.
7. **`PriceClass_100`** on CloudFront. The provider default (`PriceClass_All`) buys the most
   expensive edge locations for users who are all in Ukraine.

## The safety net

`budget.tf` creates an AWS Budget at `monthly_budget_usd` (default 10) with three
notifications: **50% actual**, **100% actual**, and **100% forecasted**. The forecast one
matters most — it projects month-end spend from the current burn rate, so a resource left
running on day 2 alerts on day 2, not on day 28.

**AWS Budgets notify; they do not cap.** There is no hard spend limit on an AWS account. The
budget is a smoke detector, not a circuit breaker.

`budget_alert_emails` has no default and is validated as non-empty — a budget nobody is
subscribed to is worse than none, because it looks like protection.

## Before the first real test

```bash
# 1. Confirm the cost-critical settings are what you think they are. Read them from the
#    plan rather than `terraform console`, which needs the backend initialised.
grep -A3 'variable "db_min_acu"'      variables.tf | grep default   # must be 0
grep -A3 'variable "db_max_acu"'      variables.tf | grep default   # 1
grep -A3 'variable "monthly_budget"'  variables.tf | grep default   # 10
grep -A3 'cloudfront_price_class'     variables.tf | grep default   # PriceClass_100
# ...and that terraform.tfvars has not overridden them back up:
grep -E 'db_min_acu|db_max_acu|monthly_budget_usd|price_class' terraform.tfvars

# 2. Review the plan for anything always-on. Expect ZERO of:
#    aws_nat_gateway, aws_eip, aws_db_instance (non-serverless),
#    aws_elasticache_*, aws_ec2_*, aws_lb / aws_alb
./infra/deploy.sh plan -out=tfplan
terraform show -json tfplan | grep -Eo '"type":"aws_(nat_gateway|eip|lb|alb|db_instance|instance)"' | sort -u

# 3. After apply, verify the cluster actually pauses. Leave it idle ~10 minutes, then:
aws rds describe-db-clusters --profile yevhenii \
  --db-cluster-identifier salary-calculator-db \
  --query 'DBClusters[0].{Capacity:ServerlessV2ScalingConfiguration,Status:Status}'

# 4. Check real spend after 48 hours — do not wait for the invoice.
aws ce get-cost-and-usage --profile yevhenii \
  --time-period Start=$(date -u -v-2d +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

## Teardown

Idle cost is near zero, so the stack can be left up between tests. To stop *all* charges:

```bash
./infra/deploy.sh destroy   # skip_final_snapshot = true, so no lingering snapshot cost
```

The bootstrap state bucket (`infra/bootstrap`) is separate and costs pennies; leave it.
