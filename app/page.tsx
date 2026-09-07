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

const revisionExamples = [
  "Use warmer natural materials",
  "Make the facade more minimal",
  "Increase the glass openings",
  "Reduce the landscaping",
  "Change the lighting to daylight",
  "Add refined luxury details",
];

type Version = {
  id: string;
  image: string;
  label: string;
  note: string;
};

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

async function dataUrlToPreparedFile(dataUrl: string) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const file = new File([blob], "archinova-current-render.png", {
    type: blob.type || "image/png",
    lastModified: Date.now(),
  });
  return prepareReferenceImage(file, 0);
}

function shortRevision(text: string) {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 34 ? `${clean.slice(0, 34)}…` : clean;
}

export default function Home() {
  const [files, setFiles] = useState<Array<File | null>>([null, null, null, null]);
  const [previews, setPreviews] = useState<string[]>(["", "", "", ""]);
  const [prompt, setPrompt] = useState(promptExamples[0]);
  const [style, setStyle] = useState("Modern");
  const [ratio, setRatio] = useState("16:9");
  const [renderType, setRenderType] = useState("Exterior");
  const [preserveDesign, setPreserveDesign] = useState(true);
  const [busyMode, setBusyMode] = useState<"" | "generate" | "edit">("");
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const promptCount = useMemo(() => prompt.trim().length, [prompt]);
  const referenceCount = files.filter(Boolean).length;
  const currentVersion = versions.find((version) => version.id === selectedVersionId) || null;
  const isBusy = busyMode !== "";

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

    setError("");
  }

  async function appendPreparedReferences(body: FormData, startIndex = 0, maxCount = 4) {
    const chosenReferences = files
      .map((file, slotIndex) => ({ file, slotIndex }))
      .filter((item): item is { file: File; slotIndex: number } => item.file instanceof File)
      .slice(0, maxCount);

    const prepared = await Promise.all(
      chosenReferences.map(({ file }, index) => prepareReferenceImage(file, index + startIndex))
    );

    prepared.forEach((file, index) => {
      const slotIndex = chosenReferences[index].slotIndex;
      const imageIndex = startIndex + index;
      body.append(`image_${imageIndex}`, file);
      body.append(`role_${imageIndex}`, referenceSlots[slotIndex].label);
    });
  }

  function addVersion(image: string, note: string) {
    const nextNumber = versions.length + 1;
    const id = crypto.randomUUID();
    const version: Version = {
      id,
      image,
      label: `V${nextNumber}`,
      note,
    };

    setVersions((current) => [...current, version]);
    setSelectedVersionId(id);
    setResultUrl(image);
  }

  async function generateRender(regenerate = false) {
    if (!files[0] || !prompt.trim() || isBusy) return;

    setBusyMode("generate");
    setError("");

    try {
      const body = new FormData();
      await appendPreparedReferences(body, 0, 4);

      body.append("mode", "generate");
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

      addVersion(data.image, regenerate ? "New alternative" : "Initial render");
      setRevisionPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while creating the render.");
    } finally {
      setBusyMode("");
    }
  }

  async function applyRevision() {
    if (!currentVersion || !revisionPrompt.trim() || isBusy) return;

    setBusyMode("edit");
    setError("");

    try {
      const body = new FormData();
      const currentRender = await dataUrlToPreparedFile(currentVersion.image);
      body.append("image_0", currentRender);
      body.append("role_0", "Current render");

      // Keep up to three original references alongside the current render.
      await appendPreparedReferences(body, 1, 3);

      body.append("mode", "edit");
      body.append("prompt", prompt.trim());
      body.append("revisionPrompt", revisionPrompt.trim());
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
        throw new Error(data?.error || "The requested changes could not be applied.");
      }

      addVersion(data.image, shortRevision(revisionPrompt));
      setRevisionPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while applying the changes.");
    } finally {
      setBusyMode("");
    }
  }

  function selectVersion(version: Version) {
    setSelectedVersionId(version.id);
    setResultUrl(version.image);
    setRevisionPrompt("");
    setError("");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="ArchiNova AI home">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span>
          </a>
          <a className="topbar-action" href="#studio">Open Studio</a>
        </div>
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <span className="eyebrow">AI architectural visualization</span>
          <h1>Design. Render. Refine.</h1>
          <p>Turn your project references into a client-ready visual, then revise the same render with simple instructions.</p>
          <div className="intro-actions">
            <a className="primary-action" href="#studio">Start a project</a>
            <span className="intro-note">Built for iterative design work</span>
          </div>
        </div>
        <div className="intro-card" aria-hidden="true">
          <div className="intro-grid" />
          <div className="intro-plan">
            <span className="plan-line line-a" /><span className="plan-line line-b" />
            <span className="plan-line line-c" /><span className="plan-line line-d" />
          </div>
          <div className="intro-arrow">→</div>
          <div className="intro-building">
            <span className="building-window bw-a" /><span className="building-window bw-b" />
          </div>
          <span className="intro-badge">Plan → Render → Refine</span>
        </div>
      </section>

      <section className="studio" id="studio">
        <div className="studio-head">
          <div>
            <span className="eyebrow light">ArchiNova Studio</span>
            <h2>Your architectural workspace</h2>
          </div>
          <p>Create the first render, review it, then keep refining without losing earlier versions.</p>
        </div>

        <div className="workspace">
          <div className="controls-card">
            <section className="control-section">
              <div className="section-row">
                <div><span className="step-pill">1</span><h3>Add references</h3></div>
                <span className="section-meta">{referenceCount}/4 added</span>
              </div>
              <p className="section-help">Use the main design first. Add facade, style or extra references only when useful.</p>

              <div className="reference-grid">
                {referenceSlots.map((slot, index) => (
                  <div className={`reference-slot ${files[index] ? "filled" : ""}`} key={slot.label}>
                    <label className="reference-upload">
                      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleReference(index, event)} hidden />
                      {previews[index] ? (
                        <span className="reference-preview" style={{ backgroundImage: `url(${previews[index]})` }} />
                      ) : (
                        <span className="reference-plus">+</span>
                      )}
                      <span className="reference-copy">
                        <strong>{slot.label}{slot.required ? " *" : ""}</strong>
                        <small>{files[index]?.name || slot.hint}</small>
                      </span>
                    </label>
                    {files[index] && (
                      <button className="remove-reference" type="button" onClick={() => removeReference(index)} aria-label={`Remove ${slot.label}`}>×</button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="control-section">
              <div className="section-row">
                <div><span className="step-pill">2</span><h3>Describe the result</h3></div>
                <span className="section-meta">{promptCount} chars</span>
              </div>
              <textarea className="prompt-box" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Materials, atmosphere, lighting, landscape..." rows={5} />
              <div className="example-row">
                {promptExamples.map((example, index) => (
                  <button key={example} type="button" onClick={() => setPrompt(example)}>Example {index + 1}</button>
                ))}
              </div>
            </section>

            <section className="control-section compact-section">
              <div className="section-row"><div><span className="step-pill">3</span><h3>Choose the look</h3></div></div>

              <label className="field-label">Render type</label>
              <div className="segmented-row three">
                {renderTypes.map((item) => (
                  <button type="button" key={item} className={renderType === item ? "active" : ""} onClick={() => setRenderType(item)}>{item}</button>
                ))}
              </div>

              <label className="field-label">Style</label>
              <div className="style-grid">
                {styles.map((item) => (
                  <button type="button" key={item} className={style === item ? "active" : ""} onClick={() => setStyle(item)}>{item}</button>
                ))}
              </div>

              <div className="settings-row">
                <div className="setting-block">
                  <label className="field-label">Format</label>
                  <div className="segmented-row">
                    {ratios.map((item) => (
                      <button type="button" key={item} className={ratio === item ? "active" : ""} onClick={() => setRatio(item)}>{item}</button>
                    ))}
                  </div>
                </div>

                <label className="preserve-toggle">
                  <span><strong>Preserve design</strong><small>Keep geometry and identity closer</small></span>
                  <input type="checkbox" checked={preserveDesign} onChange={(event) => setPreserveDesign(event.target.checked)} />
                  <i aria-hidden="true" />
                </label>
              </div>
            </section>

            {error && <div className="error-box" role="alert">{error}</div>}

            <button type="button" className="generate-button" onClick={() => generateRender(false)} disabled={isBusy || !files[0] || !prompt.trim()}>
              {busyMode === "generate" ? <><span className="spinner" /> Creating render...</> : <>Generate render <span>✦</span></>}
            </button>
            {!files[0] && <p className="button-hint">Add your main design reference to start.</p>}
          </div>

          <div className="result-card professional-result">
            <div className="result-bar">
              <div><span className="status-dot" /><strong>Design review</strong></div>
              <span>{versions.length ? `${versions.length} version${versions.length === 1 ? "" : "s"}` : `${ratio} · ${style}`}</span>
            </div>

            {!resultUrl ? (
              <div className={`result-empty ${busyMode === "generate" ? "is-loading" : ""}`}>
                <div className="empty-icon">✦</div>
                <strong>{busyMode === "generate" ? "Creating your first render" : "Your project starts here"}</strong>
                <p>{busyMode === "generate" ? "Keep this page open for a moment." : "Generate a render, then ask ArchiNova for corrections and revisions."}</p>
              </div>
            ) : (
              <div className="result-content">
                <div className="result-image-wrap" style={{ aspectRatio: ratio === "1:1" ? "1 / 1" : ratio === "4:3" ? "4 / 3" : "16 / 9" }}>
                  <Image src={resultUrl} alt={`${style} ${renderType.toLowerCase()} architectural AI render`} fill unoptimized style={{ objectFit: "contain" }} />
                  {currentVersion && <span className="version-badge">{currentVersion.label}</span>}
                </div>

                <div className="result-actions">
                  <div>
                    <small>SELECTED VERSION</small>
                    <strong>{currentVersion ? `${currentVersion.label} · ${currentVersion.note}` : `${style} ${renderType.toLowerCase()}`}</strong>
                  </div>
                  <div className="result-buttons">
                    <button type="button" className="secondary-action" onClick={() => generateRender(true)} disabled={isBusy}>New alternative</button>
                    <a href={resultUrl} download={`archinova-${currentVersion?.label.toLowerCase() || "render"}.png`} className="download-action">Download</a>
                  </div>
                </div>

                <section className="revision-panel">
                  <div className="revision-heading">
                    <div><span className="revision-kicker">AI revision</span><h3>What would you like to change?</h3></div>
                    <span className={`preserve-status ${preserveDesign ? "on" : ""}`}>{preserveDesign ? "Design locked" : "Creative mode"}</span>
                  </div>

                  <textarea
                    className="revision-input"
                    value={revisionPrompt}
                    onChange={(event) => setRevisionPrompt(event.target.value)}
                    placeholder="Example: keep the same house and camera angle, make the stone darker and reduce the landscaping..."
                    rows={4}
                  />

                  <div className="revision-chips">
                    {revisionExamples.map((example) => (
                      <button type="button" key={example} onClick={() => setRevisionPrompt(example)}>{example}</button>
                    ))}
                  </div>

                  <button type="button" className="apply-revision" onClick={applyRevision} disabled={isBusy || !revisionPrompt.trim() || !currentVersion}>
                    {busyMode === "edit" ? <><span className="spinner" /> Applying changes...</> : <>Apply changes <span>↗</span></>}
                  </button>
                  <p className="revision-note">ArchiNova uses the selected render plus your original references to create the next version.</p>
                </section>

                {versions.length > 0 && (
                  <section className="version-history">
                    <div className="history-heading">
                      <div><span className="revision-kicker">Project history</span><h3>Versions</h3></div>
                      <span>{versions.length} saved this session</span>
                    </div>
                    <div className="version-strip">
                      {versions.map((version) => (
                        <button type="button" key={version.id} className={`version-card ${selectedVersionId === version.id ? "active" : ""}`} onClick={() => selectVersion(version)}>
                          <span className="version-thumb"><Image src={version.image} alt={version.label} fill unoptimized style={{ objectFit: "cover" }} /></span>
                          <span className="version-copy"><strong>{version.label}</strong><small>{version.note}</small></span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="tips-section">
        <div className="tips-copy"><span className="eyebrow">Professional workflow</span><h2>Keep refining instead of starting over.</h2></div>
        <div className="tips-grid">
          <div><span>01</span><strong>Generate the base design</strong><p>Ground the first render with a clear plan, elevation or sketch.</p></div>
          <div><span>02</span><strong>Give precise corrections</strong><p>Ask for material, facade, lighting or landscaping changes in plain language.</p></div>
          <div><span>03</span><strong>Compare versions</strong><p>Every revision stays available during the session so you can return to the stronger direction.</p></div>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <div className="brand footer-brand"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span></div>
          <p>From plan to vision.</p><span>© 2026 ArchiNova AI</span>
        </div>
      </footer>

      <style>{`
        .professional-result { min-width: 0; }
        .version-badge { position:absolute; top:14px; left:14px; z-index:2; padding:7px 10px; border-radius:999px; background:rgba(12,17,14,.78); color:#fff; font-size:11px; font-weight:800; backdrop-filter:blur(10px); }
        .revision-panel { margin: 0 16px 16px; padding: 18px; border:1px solid rgba(255,255,255,.1); border-radius:18px; background:#111814; }
        .revision-heading,.history-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        .revision-heading h3,.history-heading h3 { margin:4px 0 0; color:#fff; font-size:16px; }
        .revision-kicker { color:#8d9992; font-size:9px; font-weight:850; letter-spacing:.13em; text-transform:uppercase; }
        .preserve-status { padding:6px 9px; border-radius:999px; background:rgba(255,255,255,.06); color:#89948e; font-size:10px; font-weight:800; white-space:nowrap; }
        .preserve-status.on { background:rgba(183,255,90,.1); color:#b7ff5a; }
        .revision-input { width:100%; min-height:104px; margin-top:14px; padding:14px; resize:vertical; border:1px solid rgba(255,255,255,.13); border-radius:14px; outline:none; background:#18211c; color:#fff; line-height:1.5; }
        .revision-input:focus { border-color:rgba(183,255,90,.45); box-shadow:0 0 0 3px rgba(183,255,90,.06); }
        .revision-input::placeholder { color:#68736d; }
        .revision-chips { display:flex; gap:7px; flex-wrap:wrap; margin-top:10px; }
        .revision-chips button { border:1px solid rgba(255,255,255,.1); border-radius:999px; padding:7px 10px; background:#1c2721; color:#aab4ae; font-size:10px; cursor:pointer; }
        .revision-chips button:hover { border-color:rgba(183,255,90,.3); color:#d7e0da; }
        .apply-revision { width:100%; min-height:46px; margin-top:14px; border:0; border-radius:999px; background:#b7ff5a; color:#101512; font-weight:850; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; }
        .apply-revision:disabled { opacity:.42; cursor:not-allowed; }
        .revision-note { margin:9px 0 0; color:#727e77; font-size:10px; line-height:1.45; text-align:center; }
        .version-history { margin:0 16px 18px; padding-top:16px; border-top:1px solid rgba(255,255,255,.09); }
        .history-heading > span { color:#748079; font-size:10px; }
        .version-strip { display:flex; gap:9px; margin-top:12px; overflow-x:auto; padding:1px 1px 8px; scrollbar-width:thin; }
        .version-card { flex:0 0 150px; min-width:0; padding:7px; border:1px solid rgba(255,255,255,.09); border-radius:14px; background:#131b17; color:#fff; cursor:pointer; text-align:left; }
        .version-card.active { border-color:rgba(183,255,90,.58); box-shadow:0 0 0 2px rgba(183,255,90,.07); }
        .version-thumb { position:relative; display:block; width:100%; aspect-ratio:16/10; overflow:hidden; border-radius:9px; background:#0c110e; }
        .version-copy { display:grid; gap:2px; padding:8px 3px 2px; min-width:0; }
        .version-copy strong { font-size:11px; }
        .version-copy small { color:#7f8b85; font-size:9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        @media (max-width: 720px) {
          .revision-panel { margin:0 10px 12px; padding:14px; }
          .version-history { margin:0 10px 14px; }
          .revision-heading { align-items:center; }
          .revision-heading h3 { font-size:15px; }
          .preserve-status { font-size:9px; }
          .version-card { flex-basis:132px; }
        }
      `}</style>
    </main>
  );
}
