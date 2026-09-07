"use client";

import Image from "next/image";
import { ChangeEvent, useMemo, useState } from "react";

const styles = ["Modern", "Minimal", "Mediterranean", "Luxury", "Industrial", "Scandinavian"];
const ratios = ["16:9", "4:3", "1:1"];
const renderTypes = ["Exterior", "Interior", "Concept"];

const referenceSlots = [
  { label: "Main design", hint: "Plan, elevation or sketch", required: true },
  { label: "Facade", hint: "Elevation or exterior reference", required: false },
  { label: "Style", hint: "Materials, mood or inspiration", required: false },
  { label: "Extra", hint: "Any useful project reference", required: false },
];

const promptExamples = [
  "Modern villa with natural stone, warm wood, large glass openings and soft sunset light.",
  "Minimal white residence with a calm garden, pool, clean concrete details and bright daylight.",
  "Luxury Mediterranean home with textured stone, warm plaster, arches and refined landscaping.",
];

async function prepareReferenceImage(file: File, index: number) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 500;
  const scale = Math.min(1, maxSide / bitmap.width, maxSide / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not prepare the reference image.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.92);
  });

  if (!blob) throw new Error("Could not prepare the reference image.");

  return new File([blob], `archinova-reference-${index + 1}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

export default function Home() {
  const [files, setFiles] = useState<Array<File | null>>([null, null, null, null]);
  const [previews, setPreviews] = useState<string[]>(["", "", "", ""]);
  const [prompt, setPrompt] = useState(promptExamples[0]);
  const [style, setStyle] = useState("Modern");
  const [ratio, setRatio] = useState("16:9");
  const [renderType, setRenderType] = useState("Exterior");
  const [preserveDesign, setPreserveDesign] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");

  const promptCount = useMemo(() => prompt.trim().length, [prompt]);
  const referenceCount = files.filter(Boolean).length;

  function handleReference(index: number, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setFiles((current) => {
      const next = [...current];
      next[index] = file;
      return next;
    });

    setPreviews((current) => {
      const next = [...current];
      if (next[index]) URL.revokeObjectURL(next[index]);
      next[index] = URL.createObjectURL(file);
      return next;
    });

    setResultUrl("");
    setError("");
  }

  function removeReference(index: number) {
    setFiles((current) => {
      const next = [...current];
      next[index] = null;
      return next;
    });

    setPreviews((current) => {
      const next = [...current];
      if (next[index]) URL.revokeObjectURL(next[index]);
      next[index] = "";
      return next;
    });

    setResultUrl("");
    setError("");
  }

  async function generateRender() {
    if (!files[0] || !prompt.trim()) return;

    setGenerating(true);
    setResultUrl("");
    setError("");

    try {
      const chosenReferences = files
        .map((file, slotIndex) => ({ file, slotIndex }))
        .filter((item): item is { file: File; slotIndex: number } => item.file instanceof File);

      const prepared = await Promise.all(
        chosenReferences.map(({ file }, index) => prepareReferenceImage(file, index))
      );

      const body = new FormData();
      prepared.forEach((file, index) => {
        const slotIndex = chosenReferences[index].slotIndex;
        body.append(`image_${index}`, file);
        body.append(`role_${index}`, referenceSlots[slotIndex].label);
      });

      body.append("prompt", prompt.trim());
      body.append("style", style);
      body.append("ratio", ratio);
      body.append("renderType", renderType);
      body.append("preserveDesign", String(preserveDesign));

      const response = await fetch("/api/render", {
        method: "POST",
        body,
      });

      const data = await response.json();

      if (!response.ok || !data?.image) {
        throw new Error(data?.error || "The render could not be created.");
      }

      setResultUrl(data.image);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while creating the render.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="ArchiNova AI home">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="brand-copy">
              <strong>ArchiNova</strong>
              <small>AI</small>
            </span>
          </a>
          <a className="topbar-action" href="#studio">Open Studio</a>
        </div>
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <span className="eyebrow">AI architectural visualization</span>
          <h1>Turn your design into a visual.</h1>
          <p>Upload your project references, describe the look, and generate a presentation-ready architectural image.</p>
          <div className="intro-actions">
            <a className="primary-action" href="#studio">Start a render</a>
            <span className="intro-note">No 3D setup required</span>
          </div>
        </div>
        <div className="intro-card" aria-hidden="true">
          <div className="intro-grid" />
          <div className="intro-plan">
            <span className="plan-line line-a" />
            <span className="plan-line line-b" />
            <span className="plan-line line-c" />
            <span className="plan-line line-d" />
          </div>
          <div className="intro-arrow">→</div>
          <div className="intro-building">
            <span className="building-window bw-a" />
            <span className="building-window bw-b" />
          </div>
          <span className="intro-badge">Plan → Render</span>
        </div>
      </section>

      <section className="studio" id="studio">
        <div className="studio-head">
          <div>
            <span className="eyebrow light">ArchiNova Studio</span>
            <h2>Create your render</h2>
          </div>
          <p>Three simple steps. Add references, describe the result, generate.</p>
        </div>

        <div className="workspace">
          <div className="controls-card">
            <section className="control-section">
              <div className="section-row">
                <div>
                  <span className="step-pill">1</span>
                  <h3>Add references</h3>
                </div>
                <span className="section-meta">{referenceCount}/4 added</span>
              </div>
              <p className="section-help">Start with your main plan, elevation or sketch. Add more only when they help.</p>

              <div className="reference-grid">
                {referenceSlots.map((slot, index) => (
                  <div className={`reference-slot ${files[index] ? "filled" : ""}`} key={slot.label}>
                    <label className="reference-upload">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) => handleReference(index, event)}
                        hidden
                      />
                      {previews[index] ? (
                        <span
                          className="reference-preview"
                          style={{ backgroundImage: `url(${previews[index]})` }}
                        />
                      ) : (
                        <span className="reference-plus">+</span>
                      )}
                      <span className="reference-copy">
                        <strong>{slot.label}{slot.required ? " *" : ""}</strong>
                        <small>{files[index]?.name || slot.hint}</small>
                      </span>
                    </label>
                    {files[index] && (
                      <button
                        className="remove-reference"
                        type="button"
                        onClick={() => removeReference(index)}
                        aria-label={`Remove ${slot.label}`}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="control-section">
              <div className="section-row">
                <div>
                  <span className="step-pill">2</span>
                  <h3>Describe the result</h3>
                </div>
                <span className="section-meta">{promptCount} chars</span>
              </div>

              <textarea
                className="prompt-box"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Example: modern stone villa, warm wood, large windows, sunset light..."
                rows={5}
              />

              <div className="example-row">
                {promptExamples.map((example, index) => (
                  <button key={example} type="button" onClick={() => setPrompt(example)}>
                    Example {index + 1}
                  </button>
                ))}
              </div>
            </section>

            <section className="control-section compact-section">
              <div className="section-row">
                <div>
                  <span className="step-pill">3</span>
                  <h3>Choose the look</h3>
                </div>
              </div>

              <label className="field-label">Render type</label>
              <div className="segmented-row three">
                {renderTypes.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={renderType === item ? "active" : ""}
                    onClick={() => setRenderType(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>

              <label className="field-label">Style</label>
              <div className="style-grid">
                {styles.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={style === item ? "active" : ""}
                    onClick={() => setStyle(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>

              <div className="settings-row">
                <div className="setting-block">
                  <label className="field-label">Format</label>
                  <div className="segmented-row">
                    {ratios.map((item) => (
                      <button
                        type="button"
                        key={item}
                        className={ratio === item ? "active" : ""}
                        onClick={() => setRatio(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="preserve-toggle">
                  <span>
                    <strong>Preserve design</strong>
                    <small>Keep closer to your main reference</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={preserveDesign}
                    onChange={(event) => setPreserveDesign(event.target.checked)}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>
            </section>

            {error && <div className="error-box" role="alert">{error}</div>}

            <button
              type="button"
              className="generate-button"
              onClick={generateRender}
              disabled={generating || !files[0] || !prompt.trim()}
            >
              {generating ? (
                <><span className="spinner" /> Creating your render...</>
              ) : (
                <>Generate render <span>✦</span></>
              )}
            </button>
            {!files[0] && <p className="button-hint">Add your main design reference to start.</p>}
          </div>

          <div className="result-card">
            <div className="result-bar">
              <div>
                <span className="status-dot" />
                <strong>Render</strong>
              </div>
              <span>{ratio} · {style}</span>
            </div>

            {!resultUrl ? (
              <div className={`result-empty ${generating ? "is-loading" : ""}`}>
                <div className="empty-icon">✦</div>
                <strong>{generating ? "Creating your image" : "Your render will appear here"}</strong>
                <p>{generating ? "Keep this page open for a moment." : "Add your project, choose the look, then generate."}</p>
              </div>
            ) : (
              <div className="result-content">
                <div
                  className="result-image-wrap"
                  style={{ aspectRatio: ratio === "1:1" ? "1 / 1" : ratio === "4:3" ? "4 / 3" : "16 / 9" }}
                >
                  <Image
                    src={resultUrl}
                    alt={`${style} ${renderType.toLowerCase()} architectural AI render`}
                    fill
                    unoptimized
                    style={{ objectFit: "contain" }}
                  />
                </div>

                <div className="result-actions">
                  <div>
                    <small>ARCHINOVA AI RENDER</small>
                    <strong>{style} {renderType.toLowerCase()}</strong>
                  </div>
                  <div className="result-buttons">
                    <button type="button" className="secondary-action" onClick={generateRender} disabled={generating}>
                      Regenerate
                    </button>
                    <a
                      href={resultUrl}
                      download={`archinova-${style.toLowerCase()}-${renderType.toLowerCase()}.png`}
                      className="download-action"
                    >
                      Download
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="tips-section">
        <div className="tips-copy">
          <span className="eyebrow">Better results</span>
          <h2>Give the AI useful design information.</h2>
        </div>
        <div className="tips-grid">
          <div><span>01</span><strong>Use a clear main reference</strong><p>A plan, elevation or sketch with readable geometry works best.</p></div>
          <div><span>02</span><strong>Add a facade when you have one</strong><p>It helps the render follow windows, materials and exterior character.</p></div>
          <div><span>03</span><strong>Describe light and materials</strong><p>Stone, wood, concrete, daylight, sunset and landscaping all guide the result.</p></div>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <div className="brand footer-brand">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span>
          </div>
          <p>From plan to vision.</p>
          <span>© 2026 ArchiNova AI</span>
        </div>
      </footer>
    </main>
  );
}
