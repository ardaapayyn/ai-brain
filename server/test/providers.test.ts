import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OllamaProvider } from '../src/llm/ollama.js';
import { OpenAICompatProvider } from '../src/llm/openai.js';
import { LLMRouter } from '../src/llm/router.js';
import type { ToolSpec } from '../src/llm/types.js';

const tools: ToolSpec[] = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

function serve(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      handler(req, raw ? JSON.parse(raw) : undefined, res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() }));
  });
}

test('Ollama provider: streams tokens, parses structured tool calls, maps messages', async () => {
  let seen: any;
  const s = await serve((req, body, res) => {
    seen = body;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Checking ' } }) + '\n');
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'the file.' } }) + '\n');
    res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] } }) + '\n');
    res.end(JSON.stringify({ done: true, prompt_eval_count: 100, eval_count: 20 }) + '\n');
  });
  const p = new OllamaProvider('ollama', { type: 'ollama', baseUrl: s.url, model: 'qwen3-coder:30b', contextTokens: 16384 });
  const tokens: string[] = [];
  const r = await p.chat({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'read_file', arguments: { path: 'b' } }] },
      { role: 'tool', toolCallId: 'x', name: 'read_file', content: 'data' },
    ],
    tools,
    onToken: (t) => tokens.push(t),
  });
  s.close();
  assert.equal(r.content, 'Checking the file.');
  assert.deepEqual(tokens, ['Checking ', 'the file.']);
  assert.equal(r.toolCalls[0].name, 'read_file');
  assert.deepEqual(r.toolCalls[0].arguments, { path: 'a.ts' });
  assert.equal(r.usage?.promptTokens, 100);
  assert.equal(seen.options.num_ctx, 16384);
  assert.equal(seen.tools[0].function.name, 'read_file');
  assert.deepEqual(seen.messages[2].tool_calls[0].function.arguments, { path: 'b' });
  assert.equal(seen.messages[3].tool_name, 'read_file');
});

test('Ollama provider: text tool calls are recovered', async () => {
  const s = await serve((_req, _b, res) => {
    res.end(JSON.stringify({ message: { content: '<tool_call>{"name":"read_file","arguments":{"path":"z"}}</tool_call>' }, done: true }) + '\n');
  });
  const p = new OllamaProvider('ollama', { type: 'ollama', baseUrl: s.url, model: 'm' });
  const r = await p.chat({ messages: [{ role: 'user', content: 'x' }], tools });
  s.close();
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.content, '');
});

test('OpenAI-compatible provider: SSE deltas and fragmented tool-call arguments', async () => {
  let seen: any;
  const s = await serve((_req, body, res) => {
    seen = body;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    send({ choices: [{ delta: { content: 'Ok' } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x.py"}' } }] } }] });
    send({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    res.end('data: [DONE]\n\n');
  });
  const p = new OpenAICompatProvider('llama-cpp', { type: 'openai', baseUrl: s.url + '/v1', model: 'local' });
  const r = await p.chat({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'k', name: 'read_file', arguments: { path: 'q' } }] },
      { role: 'tool', toolCallId: 'k', name: 'read_file', content: 'r' },
    ],
    tools,
  });
  s.close();
  assert.equal(r.content, 'Ok');
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: { path: 'x.py' } }]);
  assert.equal(seen.messages[1].tool_calls[0].function.arguments, '{"path":"q"}');
  assert.equal(seen.messages[2].tool_call_id, 'k');
  assert.equal(r.usage?.completionTokens, 3);
});

test('Router falls back when the active provider is unreachable', async () => {
  const s = await serve((_req, _b, res) => res.end(JSON.stringify({ message: { content: 'from fallback' }, done: true }) + '\n'));
  const router = new LLMRouter({
    active: 'primary',
    fallbacks: ['backup'],
    providers: {
      primary: { type: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'x' },
      backup: { type: 'ollama', baseUrl: s.url, model: 'y' },
    },
  });
  const r = await router.chat({ messages: [{ role: 'user', content: 'hi' }] });
  s.close();
  assert.equal(r.content, 'from fallback');
  assert.equal(router.lastServedBy, 'backup');
});

test('Ollama provider: model pull streams progress and surfaces errors', async () => {
  const s = await serve((_req, body, res) => {
    if (body.model === 'bad') {
      res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n');
      return;
    }
    res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
    res.write(JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) + '\n');
    res.end(JSON.stringify({ status: 'success' }) + '\n');
  });
  const p = new OllamaProvider('ollama', { type: 'ollama', baseUrl: s.url, model: 'm' });
  const seen: any[] = [];
  await p.pull('qwen3:8b', (x) => seen.push(x));
  assert.deepEqual(seen.map((x) => x.status), ['pulling manifest', 'downloading', 'success']);
  assert.equal(seen[1].completed, 50);
  await assert.rejects(p.pull('bad', () => {}), /does not exist/);
  s.close();
});

test('hardware recommendation matches the reference PC', async () => {
  const { recommend } = await import('../src/system.js');
  const r = recommend(64, 8);
  assert.equal(r.main, 'qwen3-coder:30b');
  assert.equal(r.fast, 'qwen3:8b');
  assert.equal(r.contextTokens, 32768);
  assert.equal(recommend(16, 4).main, 'qwen3:8b');
  assert.equal(recommend(8, 0).main, 'qwen3:4b');
});

test('Ollama: think flag only for switchable models, same num_ctx for warm-up and chat', async () => {
  const bodies: any[] = [];
  const s = await serve((req, body, res) => {
    bodies.push({ url: req.url, body });
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    res.end(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n');
  });
  const fast = new OllamaProvider('fast', { type: 'ollama', baseUrl: s.url, model: 'qwen3:8b', contextTokens: 16384, think: false });
  const coder = new OllamaProvider('main', { type: 'ollama', baseUrl: s.url, model: 'qwen3-coder:30b', contextTokens: 32768, think: false });
  await fast.warmup([{ role: 'system', content: 'sys' }], tools);
  await fast.chat({ messages: [{ role: 'user', content: 'hi' }], tools });
  await coder.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(bodies[0].body.think, false);
  assert.equal(bodies[0].body.options.num_predict, 1);
  assert.equal(bodies[0].body.options.num_ctx, bodies[1].body.options.num_ctx);
  assert.equal(bodies[1].body.think, false);
  assert.equal(bodies[2].body.think, undefined); // qwen3-coder has no thinking switch
  assert.equal(await fast.isLoaded(), true);
  assert.equal(await coder.isLoaded(), false);
  s.close();
});
