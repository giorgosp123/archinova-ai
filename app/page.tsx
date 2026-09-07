"use client";

import Image from "next/image";
import { ChangeEvent, useMemo, useRef, useState } from "react";

const styles = ["Modern", "Minimal", "Mediterranean", "Luxury", "Industrial", "Scandinavian"];
const ratios = ["16:9", "4:3", "1:1"];

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [prompt, setPrompt] = useState(
    "Modern two-storey villa with warm natural stone, large glass openings, landscaped garden and soft sunset lighting. Photorealistic architectural visualization."
  );
  const [style, setStyle] = useState("Modern");
  const [ratio, setRatio] = useState("16:9");
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");

  const promptCount = useMemo(() => prompt.trim().length, [prompt]);

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);
    setFileName(file.name);
    setResultUrl("");
    setError("");

    if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl("");
    }
  }

  async function generateConcept() {
    if (!selectedFile || !prompt.trim()) return;

    setGenerating(true);
    setResultUrl("");
    setError("");

    try {
      const body = new FormData();
      body.append("image", selectedFile);
      body.append("prompt", prompt.trim());
      body.append("style", style);
      body.append("ratio", ratio);

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
    <main>
      <header className="nav-shell">
        <nav className="nav container">
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

          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#studio">Studio</a>
            <a href="#features">Features</a>
          </div>

          <a className="nav-cta" href="#studio">Open Studio</a>
        </nav>
      </header>

      <section className="hero container" id="top">
        <div className="hero-copy">
          <span className="eyebrow">AI architectural visualization</span>
          <h1>
            From plan
            <span> to vision.</span>
          </h1>
          <p>
            Turn plans, sketches and reference images into presentation-ready architectural concepts in minutes.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#studio">Create a render</a>
            <a className="text-button" href="#how">See how it works <span>↗</span></a>
          </div>
          <div className="hero-proof">
            <span>Plans</span><i />
            <span>Sketches</span><i />
            <span>References</span><i />
            <span>AI renders</span>
          </div>
        </div>

        <div className="hero-visual" aria-label="Architectural concept preview">
          <div className="visual-grid" />
          <div className="building building-back" />
          <div className="building building-main">
            <div className="glass glass-a" />
            <div className="glass glass-b" />
            <div className="terrace" />
          </div>
          <div className="pool" />
          <div className="visual-badge">
            <span className="pulse" />
            AI concept preview
          </div>
          <div className="visual-caption">
            <span>Villa 01</span>
            <strong>Warm minimalism</strong>
          </div>
        </div>
      </section>

      <section className="how-section" id="how">
        <div className="container">
          <div className="section-heading compact-heading">
            <span className="section-kicker">Simple workflow</span>
            <h2>Three steps. No 3D detour.</h2>
          </div>
          <div className="steps-grid">
            <article className="step-card">
              <span className="step-number">01</span>
              <h3>Upload</h3>
              <p>Add a plan, elevation, sketch or reference image.</p>
            </article>
            <article className="step-card">
              <span className="step-number">02</span>
              <h3>Describe</h3>
              <p>Tell ArchiNova the materials, atmosphere, style and lighting you want.</p>
            </article>
            <article className="step-card">
              <span className="step-number">03</span>
              <h3>Visualize</h3>
              <p>Create polished concept visuals ready for a client presentation.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="studio-section" id="studio">
        <div className="container studio-wrap">
          <div className="section-heading studio-heading">
            <span className="section-kicker">ArchiNova Studio</span>
            <h2>Build the scene you have in mind.</h2>
            <p>Upload an architectural image, describe the direction and let the rendering pipeline create a presentation-ready concept.</p>
          </div>

          <div className="studio-grid">
            <div className="control-panel">
              <div className="panel-block">
                <div className="panel-label-row">
                  <label>1. Project input</label>
                  {fileName && <span className="success-pill">Ready</span>}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleFile}
                  hidden
                />

                <button
                  type="button"
                  className={`upload-zone ${previewUrl ? "has-preview" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                  style={previewUrl ? { backgroundImage: `linear-gradient(rgba(9,13,12,.36),rgba(9,13,12,.5)), url(${previewUrl})` } : undefined}
                >
                  <span className="upload-icon">＋</span>
                  <strong>{fileName || "Upload a plan or sketch"}</strong>
                  <small>{fileName ? "Tap to replace file" : "PNG, JPG or WEBP · PDF comes next"}</small>
                </button>
              </div>

              <div className="panel-block">
                <div className="panel-label-row">
                  <label htmlFor="prompt">2. Describe your vision</label>
                  <span>{promptCount} chars</span>
                </div>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Describe materials, mood, light, landscape, furniture..."
                  rows={6}
                />
              </div>

              <div className="panel-block">
                <label>3. Architectural style</label>
                <div className="chip-grid">
                  {styles.map((item) => (
                    <button
                      type="button"
                      key={item}
                      className={style === item ? "chip active" : "chip"}
                      onClick={() => setStyle(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div className="split-controls">
                <div className="panel-block small-block">
                  <label>Aspect ratio</label>
                  <div className="ratio-row">
                    {ratios.map((item) => (
                      <button
                        type="button"
                        key={item}
                        className={ratio === item ? "ratio active" : "ratio"}
                        onClick={() => setRatio(item)}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="panel-block small-block render-count">
                  <label>Output</label>
                  <strong>1 AI render</strong>
                  <small>Medium quality</small>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  style={{
                    marginBottom: 16,
                    padding: "12px 14px",
                    border: "1px solid rgba(255,140,120,.35)",
                    background: "rgba(255,100,80,.08)",
                    color: "#ffd0c8",
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="button"
                className="generate-button"
                onClick={generateConcept}
                disabled={generating || !prompt.trim() || !selectedFile}
              >
                {generating ? <><span className="spinner" /> Rendering with AI...</> : <>Generate concept <span>✦</span></>}
              </button>
            </div>

            <div className="result-panel">
              <div className="result-topbar">
                <div>
                  <span className="result-dot" />
                  <strong>Render canvas</strong>
                </div>
                <span>{ratio} · {style}</span>
              </div>

              {!resultUrl ? (
                <div className="empty-result">
                  <div className="mini-plan" aria-hidden="true">
                    <span className="wall wall-a" />
                    <span className="wall wall-b" />
                    <span className="wall wall-c" />
                    <span className="wall wall-d" />
                  </div>
                  <strong>{generating ? "ArchiNova is building your render" : "Your AI render will appear here"}</strong>
                  <p>{generating ? "Keep this page open while the image is being generated." : "Upload an image, choose your direction and generate the concept."}</p>
                </div>
              ) : (
                <div style={{ padding: 16 }}>
                  <div
                    style={{
                      position: "relative",
                      width: "100%",
                      aspectRatio: ratio === "1:1" ? "1 / 1" : ratio === "4:3" ? "4 / 3" : "16 / 9",
                      overflow: "hidden",
                      background: "#111614",
                    }}
                  >
                    <Image
                      src={resultUrl}
                      alt={`${style} architectural AI render`}
                      fill
                      unoptimized
                      style={{ objectFit: "contain" }}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 14 }}>
                    <div style={{ display: "grid", gap: 3 }}>
                      <small style={{ color: "#8f9a94" }}>ARCHINOVA AI RENDER</small>
                      <strong>{style} concept</strong>
                    </div>
                    <a
                      href={resultUrl}
                      download={`archinova-${style.toLowerCase()}-render.png`}
                      className="nav-cta"
                    >
                      Download
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="features-section" id="features">
        <div className="container features-grid">
          <div className="section-heading feature-copy">
            <span className="section-kicker">Built for design work</span>
            <h2>Less rendering friction. More creative direction.</h2>
            <p>ArchiNova is being designed as a focused visualization workspace, not a generic image generator.</p>
          </div>
          <div className="feature-list">
            <article><span>01</span><div><strong>Reference-aware workflow</strong><p>Keep the project grounded in your plan, sketch and visual references.</p></div></article>
            <article><span>02</span><div><strong>Architectural presets</strong><p>Control style, mood, ratio and presentation direction without prompt gymnastics.</p></div></article>
            <article><span>03</span><div><strong>Project history</strong><p>Next phase: save concepts, variations and presentation sets per client project.</p></div></article>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="container footer-inner">
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
