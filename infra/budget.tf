/**
 * Spend guardrail.
 *
 * The stack is designed to cost ~$1–2/month at this usage (see cost.md), but "designed to"
 * is not "verified to": a misconfigured Aurora min_capacity, a Lambda retry storm, or an
 * S3 event loop can all run up a bill quietly. This budget makes that loud instead.
 *
 * A budget is not a spending *limit* — AWS does not offer a hard cap on account spend. It
 * notifies. Combined with the design choices (Aurora scale-to-zero, no NAT gateway, bounded
 * log retention, CloudFront PriceClass_100), the intent is that the alarm never fires; if it
 * does, something is wrong and worth investigating the same day.
 */

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project_name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Warn at 50% of budget on ACTUAL spend — early enough to act mid-month.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  # Warn at 100% of ACTUAL spend.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  # FORECASTED is the one that catches a runaway early: AWS projects month-end spend from the
  # current burn rate, so a resource left running on day 2 alerts on day 2 rather than on day
  # 28 when the money is already spent.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
}
