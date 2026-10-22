/**
 * Telegram Bot API stand-in for tests.
 *
 * Serves the handful of methods the gate transport calls, records what was sent, and lets a test queue a
 * callback query as if a button had been tapped. `getUpdates` honours the offset the way Telegram does, so
 * a test can prove the transport never re-reads a tap.
 */

import http from "node:http";

export function createTelegramFake({ token = "1234567:AA-test-token" } = {}) {
  const calls = [];
  const messages = [];
  const edits = [];
  const callbacks = [];
  const toasts = [];
  let nextMessageId = 100;
  let nextUpdateId = 1;
  let failNext = null;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const [method, arg] = req.url.split("/").reverse();
      const payload = body ? JSON.parse(body) : {};
      calls.push({ method, payload });

      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };

      if (failNext) {
        const failure = failNext;
        failNext = null;
        return json(failure.status ?? 502, { ok: false, description: failure.description });
      }

      switch (method) {
        case "getMe":
          return json(200, { ok: true, result: { id: 777, username: "laidback_reviewer_bot" } });
        case "sendMessage": {
          const message = {
            message_id: nextMessageId++,
            chat: { id: Number(payload.chat_id), type: "private" },
            text: payload.text,
            parse_mode: payload.parse_mode,
            disable_notification: payload.disable_notification ?? false,
            reply_markup: payload.reply_markup ?? null,
          };
          messages.push(message);
          return json(200, { ok: true, result: message });
        }
        case "editMessageText": {
          const message = messages.find((entry) => entry.message_id === payload.message_id);
          if (!message) return json(400, { ok: false, description: "message to edit is not found" });
          message.text = payload.text;
          if (payload.reply_markup) message.reply_markup = payload.reply_markup;
          edits.push({ message_id: payload.message_id, text: payload.text, reply_markup: payload.reply_markup });
          return json(200, { ok: true, result: message });
        }
        case "answerCallbackQuery": {
          toasts.push({ callback_query_id: payload.callback_query_id, text: payload.text ?? "" });
          return json(200, { ok: true, result: true });
        }
        case "getUpdates": {
          const offset = Number(payload.offset ?? 0);
          const pending = callbacks.filter((update) => update.update_id >= offset);
          return json(200, { ok: true, result: pending });
        }
        default:
          return json(400, { ok: false, description: `unsupported method ${method}` });
      }
    });
  });

  return {
    token,
    get apiBase() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    calls,
    messages,
    edits,
    toasts,
    start() {
      return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(this.apiBase)));
    },
    close() {
      // undici holds the connection open, which would keep the test process alive after the run.
      server.closeAllConnections?.();
      server.close();
    },
    /** Queue a button tap. `chatId` and `messageId` default to the last posted gate message. */
    tap(data, { from = { id: 4242, username: "decider" }, chatId, messageId } = {}) {
      const last = messages[messages.length - 1];
      const update = {
        update_id: nextUpdateId++,
        callback_query: {
          id: `cb${nextUpdateId}`,
          from,
          message: {
            message_id: messageId ?? last?.message_id ?? 1,
            chat: { id: chatId ?? last?.chat?.id ?? 4242 },
            text: last?.text ?? "",
          },
          data,
        },
      };
      callbacks.push(update);
      return update;
    },
    failNextWith(description, status) {
      failNext = { description, status };
    },
  };
}
