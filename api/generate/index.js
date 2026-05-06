const Anthropic = require("@anthropic-ai/sdk");

module.exports = async function (context, req) {
  if (req.method !== "POST") {
    context.res = { status: 405, body: "Method Not Allowed" };
    return;
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt) {
      context.res = { status: 400, body: "Missing prompt" };
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: "ANTHROPIC_API_KEY environment variable is not set" },
      };
      return;
    }

    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 5000,
      messages: [{ role: "user", content: prompt }],
    });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { text: msg.content[0].text },
    };
  } catch (err) {
    context.log.error("generate error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message },
    };
  }
};
