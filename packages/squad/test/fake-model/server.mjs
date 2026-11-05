// A fake model API for the docker conversation test, run inside the runner container. It answers the
// Anthropic Messages API and the OpenAI Responses API with one short streamed reply, and writes one
// line per request to /log/requests.log: the API and how many history items came in. Not a capture:
// it stands in for a provider, because a test never uses a real login.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const log = (s) => appendFileSync("/log/requests.log", `${s}\n`);

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {}
    if (req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens")) {
      const n = (j.messages ?? []).length;
      log(`anthropic ${n}`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage: { input_tokens: n * 100, output_tokens: 1 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: `saw ${n}` } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: n } });
      ev("message_stop", {});
      return res.end();
    }
    if (req.url.startsWith("/v1/responses")) {
      const n = Array.isArray(j.input) ? j.input.length : 0;
      log(`openai ${n}`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (d) => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: `saw ${n}`, annotations: [] }] };
      ev({ type: "response.created", response: { id: "resp_1" } });
      ev({ type: "response.output_item.done", output_index: 0, item });
      ev({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: n * 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: n, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: n * 101 } } });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
}).listen(18999, "127.0.0.1");
