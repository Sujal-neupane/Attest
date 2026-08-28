/**
 * Which origins may call the API.
 *
 * This is tested because the bug it fixes is invisible to every tool used to
 * check a deployment. CORS_ORIGIN was set to `*` on a live service, the origin
 * list compared it by equality, no Access-Control-Allow-Origin header came
 * back, and every request from the frontend failed — while curl, the health
 * check, and all 337 other tests stayed green, because none of them are a
 * browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { corsOrigin } = require('../src/config/cors');

/** Run the cors callback synchronously and report allowed / refused. */
const ask = (configured, origin) => {
  let outcome;
  corsOrigin(configured)(origin, (err, allow) => {
    outcome = err ? { allowed: false, message: err.message } : { allowed: allow };
  });
  return outcome;
};

test('THE WILDCARD ACTUALLY ALLOWS THE REQUEST', () => {
  // The whole reason this file exists.
  assert.equal(ask('*', 'https://attest.vercel.app').allowed, true);
  assert.equal(ask('*', 'http://localhost:5173').allowed, true);
});

test('an exact origin is allowed and anything else is not', () => {
  const configured = 'https://attest.vercel.app';
  assert.equal(ask(configured, 'https://attest.vercel.app').allowed, true);
  assert.equal(ask(configured, 'https://attest.vercel.app.evil.com').allowed, false);
  assert.equal(ask(configured, 'https://not-attest.vercel.app').allowed, false);
});

test('a comma-separated list allows every entry', () => {
  const configured = 'http://localhost:5173, https://attest.vercel.app';
  assert.equal(ask(configured, 'http://localhost:5173').allowed, true);
  assert.equal(ask(configured, 'https://attest.vercel.app').allowed, true);
  assert.equal(ask(configured, 'https://elsewhere.com').allowed, false);
});

test('a wildcard subdomain matches one label, not a nested host', () => {
  const configured = 'https://*.vercel.app';

  // What Vercel gives a preview deployment.
  assert.equal(ask(configured, 'https://attest-git-main-sujal.vercel.app').allowed, true);

  // A nested host is somebody else's subdomain, not a preview of ours.
  assert.equal(ask(configured, 'https://evil.attest.vercel.app').allowed, false);
  assert.equal(ask(configured, 'https://vercel.app.evil.com').allowed, false);
});

test('the scheme is part of the match', () => {
  // Otherwise an http:// origin borrows the https:// entry, and the token in
  // the Authorization header crosses the network in the clear.
  assert.equal(ask('https://attest.vercel.app', 'http://attest.vercel.app').allowed, false);
  assert.equal(ask('https://*.vercel.app', 'http://attest.vercel.app').allowed, false);
});

test('a request with no Origin header is allowed through', () => {
  // curl, a server-to-server call, and Render's own health check all send no
  // Origin. CORS does not apply to them, and refusing would take the service
  // down at the health check.
  assert.equal(ask('https://attest.vercel.app', undefined).allowed, true);
});

test('a refusal names the origin and what is configured', () => {
  const { allowed, message } = ask('https://attest.vercel.app', 'https://elsewhere.com');

  assert.equal(allowed, false);
  // Someone reads this in a deploy log, under pressure, at the point where the
  // frontend is white and the console says only "CORS error".
  assert.match(message, /https:\/\/elsewhere\.com/);
  assert.match(message, /CORS_ORIGIN/);
  assert.match(message, /https:\/\/attest\.vercel\.app/);
});
