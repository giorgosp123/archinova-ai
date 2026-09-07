"use client";

import { ChangeEvent, useMemo, useRef, useState } from "react";

const styles = ["Modern", "Minimal", "Mediterranean", "Luxury", "Industrial", "Scandinavian"];
const ratios = ["16:9", "4:3", "1:1"];

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [prompt, setPrompt] = useState(
    "Modern two-storey villa with warm natural stone, large glass openings, landscaped garden and soft sunset lighting. Photorealistic architectural visualization."
  );
  const [style, setStyle] = useState("Modern");
  const [ratio, setRatio] = useState("16:9");
  const [generating, setGenerating] = useState(false);
  const [showResult, setShowResult] = useState(false);

  const promptCount = useMemo(() => prompt.trim().length, [prompt]);

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setShowResult(false);

    if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl("");
    }
  }

  function generateDemo() {
    setGenerating(true);
    setShowResult(false);
    window.setTimeout(() => {
      setGenerating(false);
      setShowResult(true);
    }, 900);
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
              <p>Add a floor plan, elevation, sketch or reference image.</p>
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
            <p>This first version already includes the full front-end workflow. The real AI engine comes next.</p>
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
                  accept="image/*,.pdf"
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
                  <small>{fileName ? "Tap to replace file" : "JPG, PNG or PDF"}</small>
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
                  <label>Outputs</label>
                  <strong>4 variations</strong>
                  <small>Presentation set</small>
                </div>
              </div>

              <button
                type="button"
                className="generate-button"
                onClick={generateDemo}
                disabled={generating || !prompt.trim()}
              >
                {generating ? <><span className="spinner" /> Building concept...</> : <>Generate concept <span>✦</span></>}
              </button>
            </div>

            <div className="result-panel">
              <div className="result-topbar">
                <div>
                  <span className="result-dot" />
                  <strong>Preview canvas</strong>
                </div>
                <span>{ratio} · {style}</span>
              </div>

              {!showResult ? (
                <div className="empty-result">
                  <div className="mini-plan" aria-hidden="true">
                    <span className="wall wall-a" />
                    <span className="wall wall-b" />
                    <span className="wall wall-c" />
                    <span className="wall wall-d" />
                  </div>
                  <strong>Your concept will appear here</strong>
                  <p>Choose your input and direction, then generate a demo concept.</p>
                </div>
              ) : (
                <div className="demo-result">
                  <div className="demo-sky" />
                  <div className="demo-house-back" />
                  <div className="demo-house-front">
                    <span className="demo-window window-one" />
                    <span className="demo-window window-two" />
                    <span className="demo-window window-three" />
                  </div>
                  <div className="demo-deck" />
                  <div className="demo-water" />
                  <div className="demo-tree tree-one" />
                  <div className="demo-tree tree-two" />
                  <div className="demo-label">
                    <span>DEMO CONCEPT</span>
                    <strong>{style} residence</strong>
                    <small>AI generation API not connected yet</small>
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
