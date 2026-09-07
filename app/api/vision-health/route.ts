import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return NextResponse.json({ ok: false, error: "missing config" }, { status: 503 });
  }

  // 16x16 white PNG. This verifies the same multimodal path used by analyze-view.
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGP8//8/AymAiSTVoxpGNQwpDQBVbQMdPVIhQwAAAABJRU5ErkJggg==";
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "@cf/google/gemma-4-26b-a4b-it",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with exactly: VISION_OK. Do not reason or explain." },
            { type: "image_url", image_url: { url: png } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 80,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  return NextResponse.json({
    ok: response.ok && typeof content === "string" && content.trim().length > 0,
    status: response.status,
    finishReason: data?.choices?.[0]?.finish_reason,
    content: typeof content === "string" ? content.slice(0, 120) : null,
    usage: data?.usage || null,
    messageKeys: Object.keys(data?.choices?.[0]?.message || {}),
    error: response.ok ? null : data?.errors?.[0]?.message || data?.error || "unknown",
  }, { status: response.ok ? 200 : response.status });
}
