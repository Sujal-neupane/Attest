/**
 * A local server that speaks the Messages API.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The stub-client tests in extract.test.js prove the LOGIC is right — what
 * happens on an invented figure, a refusal, an exhausted loop. They cannot
 * prove the SDK is being CALLED correctly, because they replace the SDK.
 *
 * Pointing the real `@anthropic-ai/sdk` at this server closes that gap without
 * a key and without cost: the request is built by the real client, serialised
 * over real HTTP, and the response is parsed by the real response types. A
 * malformed tool definition or a misnamed parameter fails here.
 *
 * What it does NOT prove: that Claude behaves as the prompt intends. Nothing
 * short of a live call proves that, and this file does not pretend otherwise —
 * it records the requests it received so a test can assert on the shape we
 * send, which is the part that is ours to get right.
 */

const http = require('node:http');

/**
 * @param {Array<Function|object>} script  one entry per expected request; a
 *        function receives the parsed request body and returns the response
 */
function createMockAnthropic(script) {
  const requests = [];
  let index = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ path: req.url, headers: req.headers, body: parsed });

      const entry = script[Math.min(index, script.length - 1)];
      index++;

      const response = typeof entry === 'function' ? entry(parsed, requests.length) : entry;

      if (response?.__status && response.__status >= 400) {
        res.writeHead(response.__status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: response.error }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(withDefaults(response)));
    });
  });

  return {
    server,
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Fill in the envelope fields every Message carries, so tests state only what matters. */
function withDefaults(message) {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...message,
  };
}

/** An assistant turn asking for one tool. */
function toolUse(name, input = {}, id = `toolu_${name}`) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

/** A final turn carrying structured output. */
function structured(object) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(object) }],
  };
}

module.exports = { createMockAnthropic, toolUse, structured, withDefaults };
