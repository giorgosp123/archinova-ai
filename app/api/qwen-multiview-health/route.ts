import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return NextResponse.json({ ok: false, error: "missing env" }, { status: 503 });

  const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4bQAAAAASUVORK5CYII=";
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "@cf/qwen/qwen3.8-27b",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "You are receiving two image parts. Reply exactly MULTIVIEW_OK if the request is valid." },
          { type: "image_url", image_url: { url: tinyPng } },
          { type: "image_url", image_url: { url: tinyPng } }
        ]
      }],
      temperature: 0,
      reasoning_effort: "low",
      max_completion_tokens: 40,
      chat_template_kwargs: { enable_thinking: false }
    })
  });

  const data = await response.json().catch(() => ({}));
  return NextResponse.json({
    ok: response.ok,
    status: response.status,
    finishReason: data?.choices?.[0]?.finish_reason,
    content: data?.choices?.[0]?.message?.content || null,
    error: data?.errors?.[0]?.message || data?.error || null
  }, { status: response.ok ? 200 : response.status });
}
