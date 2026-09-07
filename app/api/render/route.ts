import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedImageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function outputSize(ratio: string) {
  if (ratio === "1:1") return "1024x1024";
  return "1536x1024";
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "AI rendering is not configured yet. Add OPENAI_API_KEY in Vercel." },
        { status: 503 }
      );
    }

    const incoming = await request.formData();
    const image = incoming.get("image");
    const prompt = String(incoming.get("prompt") || "").trim();
    const style = String(incoming.get("style") || "Modern").trim();
    const ratio = String(incoming.get("ratio") || "16:9").trim();

    if (!(image instanceof File)) {
      return NextResponse.json({ error: "Upload an image first." }, { status: 400 });
    }

    if (!allowedImageTypes.has(image.type)) {
      return NextResponse.json(
        { error: "For AI rendering, use PNG, JPG or WEBP. PDF support comes next." },
        { status: 400 }
      );
    }

    if (image.size > 15 * 1024 * 1024) {
      return NextResponse.json({ error: "Image must be smaller than 15 MB." }, { status: 400 });
    }

    if (!prompt) {
      return NextResponse.json({ error: "Describe the result you want first." }, { status: 400 });
    }

    const architecturePrompt = [
      "Create a professional photorealistic architectural visualization using the uploaded image as the primary project reference.",
      "Preserve the important architectural geometry, massing, proportions, openings and recognizable design intent from the reference unless the user explicitly asks to change them.",
      "Treat plans, elevations and sketches as design information, not decorative texture.",
      `Architectural style: ${style}.`,
      `User direction: ${prompt}`,
      "Produce a polished client-presentation image with realistic materials, physically believable lighting, refined landscaping and architectural photography quality.",
      "Do not add labels, annotations, dimensions, logos, watermarks or written text to the render."
    ].join("\n");

    const body = new FormData();
    body.append("model", "gpt-image-2");
    body.append("image", image, image.name || "project.png");
    body.append("prompt", architecturePrompt);
    body.append("size", outputSize(ratio));
    body.append("quality", "medium");

    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || "The AI render could not be created.";
      console.error("OpenAI image edit error:", message);
      return NextResponse.json({ error: message }, { status: response.status });
    }

    const first = data?.data?.[0];
    const imageUrl = first?.b64_json
      ? `data:image/png;base64,${first.b64_json}`
      : first?.url || null;

    if (!imageUrl) {
      return NextResponse.json({ error: "The AI returned no image." }, { status: 502 });
    }

    return NextResponse.json({ image: imageUrl });
  } catch (error) {
    console.error("ArchiNova render error:", error);
    return NextResponse.json(
      { error: "Something went wrong while creating the render." },
      { status: 500 }
    );
  }
}
