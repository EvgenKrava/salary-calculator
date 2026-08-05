/**
 * Minimal stand-in for @aws-sdk/client-rds-data, used by bundle.test.ts.
 *
 * The Lambda runtime provides the real SDK, so the bundle externalizes it. To prove the
 * migrate handler runs to completion we need `client.send()` to succeed rather than attempt a
 * network call — this accepts every statement and records nothing.
 */
class RDSDataClient {
  constructor(config) {
    this.config = config;
  }
  async send() {
    return { numberOfRecordsUpdated: 0, records: [] };
  }
}

class ExecuteStatementCommand {
  constructor(input) {
    this.input = input;
  }
}

module.exports = { RDSDataClient, ExecuteStatementCommand };
