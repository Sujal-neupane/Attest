/**
 * The Anthropic client, and the honest handling of not having one.
 *
 * Extraction is the only part of Attest that needs an external service. It is
 * therefore the only part that can be unavailable for a reason the accountant
 * cannot fix — no key configured, no credit, the API down.
 *
 * That failure has to be legible. A document that fails extraction must say
 * "AI extraction is not configured on this deployment", not "internal error",
 * and it must not be retried three times over half an hour first: no amount of
 * waiting produces an API key.
 */

const env = require('./../../config/env');

class AiUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiUnavailableError';
    // Retrying cannot fix a missing key, so the worker marks it dead
    // immediately rather than burning the backoff schedule.
    this.permanent = true;
  }
}

let cached = null;

function isConfigured() {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Build the client, or explain why not.
 *
 * Deliberately does NOT fall back to the SDK's own environment resolution. The
 * app's configuration is validated in one place, and a key arriving through a
 * side channel the config layer never saw is exactly the kind of difference
 * that makes staging and production behave differently.
 */
function getClient() {
  if (cached) return cached;

  if (!isConfigured()) {
    throw new AiUnavailableError(
      'AI extraction is not configured on this deployment. Set ANTHROPIC_API_KEY ' +
        'to read invoices automatically, or upload a sales or purchase register ' +
        'as CSV instead — everything else in Attest works without it.',
    );
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const { betaZodTool, betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');

  cached = {
    client: new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      // Overridable so an integration test can point the real SDK at a local
      // server: it exercises the actual request shape rather than a stub.
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
      maxRetries: 2,
    }),
    betaZodTool,
    betaZodOutputFormat,
  };
  return cached;
}

/** Tests inject their own. */
function override(replacement) {
  cached = replacement;
}

module.exports = { getClient, isConfigured, override, AiUnavailableError };
