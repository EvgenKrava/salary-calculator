// Placeholder so Terraform can package the extraction Lambda before
// packages/extraction is built. Replaced by the real bundle via infra/build/build.sh.
exports.handler = async () => {
  throw new Error('extraction bundle not built — run infra/build/build.sh');
};
