import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedImageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function outputDimensions(ratio: string) {
  if (ratio === "1:1") return { width: 1024, height: 1024 };
  if (ratio === "4:3") return { width: 1024, height: 768 };
  return { width: 1024, height: 576 };
}

function cloudflareErrorMessage(data: unknown) {
  if (!data || typeof data !== "object") return "The AI render could not be created.";

  const record = data as {
    errors?: Array<{ message?: string }>;
    error?: string | { message?: string };
  };

  if (Array.isArray(record.errors) && record.errors[0]?.message) {
    return record.errors[0].message;
  }

  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object" && record.error.message) {
    return record.error.message;
  }

  return "The AI render could not be created.";
}

export async function POST(request: Request) {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return NextResponse.json(
        {
          error:
            "AI rendering is not configured yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Vercel.",
        },
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

    if (image.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "Image must be smaller than 8 MB." }, { status: 400 });
    }

    if (!prompt) {
      return NextResponse.json({ error: "Describe the result you want first." }, { status: 400 });
    }

    const architecturePrompt = [
      "Use input image 0 as the primary architectural reference.",
      "Create a professional photorealistic architectural visualization from the reference.",
      "Preserve the recognizable massing, geometry, proportions, openings, floor relationships and main design intent unless the user explicitly asks to alter them.",
      "Treat plans, elevations and sketches as architectural information, not as decorative texture.",
      `Architectural style: ${style}.`,
      `User direction: ${prompt}`,
      "Use realistic architectural materials, physically believable lighting, refined landscaping and premium architectural photography quality.",
      "Do not add labels, dimensions, logos, watermarks or written text."
    ].join("\n");

    const { width, height } = outputDimensions(ratio);
    const body = new FormData();
    body.append("prompt", architecturePrompt);
    body.append("input_image_0", image, image.name || "reference.jpg");
    body.append("width", String(width));
    body.append("height", String(height));
    body.append("guidance", "4.5");

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId
    )}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body,
    });

    const responseType = response.headers.get("content-type") || "";

    if (!response.ok) {
      let message = "The AI render could not be created.";

      try {
        if (responseType.includes("application/json")) {
          const errorData = await response.json();
          message = cloudflareErrorMessage(errorData);
        } else {
          const text = await response.text();
          if (text.trim()) message = text.slice(0, 500);
        }
      } catch {
        // Keep the friendly fallback error above.
      }

      console.error("Cloudflare Workers AI error:", message);
      return NextResponse.json({ error: message }, { status: response.status });
    }

    if (responseType.startsWith("image/")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const mime = responseType.split(";")[0] || "image/png";
      return NextResponse.json({
        image: `data:${mime};base64,${bytes.toString("base64")}`,
        provider: "cloudflare",
      });
    }

    const data = await response.json();
    const result = data?.result ?? data;
    const encodedImage =
      result?.image ||
      result?.b64_json ||
      result?.data?.[0]?.b64_json ||
      result?.data?.[0]?.image ||
      null;

    if (!encodedImage || typeof encodedImage !== "string") {
      console.error("Unexpected Cloudflare Workers AI response:", data);
      return NextResponse.json({ error: "The AI returned no image." }, { status: 502 });
    }

    const imageUrl = encodedImage.startsWith("data:image/")
      ? encodedImage
      : `data:image/png;base64,${encodedImage}`;

    return NextResponse.json({ image: imageUrl, provider: "cloudflare" });
  } catch (error) {
    console.error("ArchiNova render error:", error);
    return NextResponse.json(
      { error: "Something went wrong while creating the render." },
      { status: 500 }
    );
  }
}
