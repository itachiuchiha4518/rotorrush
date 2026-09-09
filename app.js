import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const sceneList = document.getElementById("sceneList");
const addSceneBtn = document.getElementById("addSceneBtn");
const audioInput = document.getElementById("audioInput");
const audioDrop = document.getElementById("audioDrop");
const audioDropTitle = document.getElementById("audioDropTitle");
const audioDropSub = document.getElementById("audioDropSub");
const audioPreview = document.getElementById("audioPreview");
const renderBtn = document.getElementById("renderBtn");
const statusText = document.getElementById("statusText");
const progressOuter = document.getElementById("progressOuter");
const progressInner = document.getElementById("progressInner");
const previewWrap = document.getElementById("previewWrap");
const previewVideo = document.getElementById("previewVideo");
const downloadLink = document.getElementById("downloadLink");
const styleSelect = document.getElementById("styleSelect");
const apiKeyInput = document.getElementById("apiKeyInput");

let audioFile = null;
let audioDuration = 0;
let sceneCount = 0;

const STYLE_PROMPTS = {
  chalkboard: "hand drawn chalk illustration on a dark green chalkboard, simple white chalk lines, minimal detail, educational diagram style, no text, no words, no letters",
  whiteboard: "bold black marker sketch on a white whiteboard, simple clean line drawing, minimal shading, educational explainer style, no text, no words, no letters",
  notebook: "pen and ink doodle sketch on lined notebook paper, hand drawn, simple, minimal cross hatching, no text, no words, no letters",
  flat: "simple flat vector illustration, minimal shapes, limited color palette, clean geometric style, no text, no words, no letters"
};

function fmtTime(s){
  if (isNaN(s)) return "0:00";
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60).toString().padStart(2,"0");
  return `${m}:${sec}`;
}

// ---------- Audio upload ----------
audioDrop.addEventListener("click", () => audioInput.click());
audioInput.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  audioFile = f;
  const url = URL.createObjectURL(f);
  audioPreview.src = url;
  audioPreview.style.display = "block";
  audioDrop.classList.add("has-file");
  audioDropTitle.textContent = f.name;
  audioDrop.querySelector(".dtitle").textContent = f.name;

  await new Promise((resolve) => {
    audioPreview.addEventListener("loadedmetadata", () => {
      audioDuration = audioPreview.duration;
      audioDropSub.textContent = `${fmtTime(audioDuration)} long — tap to replace`;
      resolve();
    }, { once: true });
  });
});

// ---------- Scenes ----------
function addScene(prefill){
  sceneCount++;
  const id = sceneCount;
  const el = document.createElement("div");
  el.className = "scene";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="scene-top">
      <span class="scene-label">scene ${id}</span>
      <button class="scene-del" type="button" aria-label="delete scene">&times;</button>
    </div>
    <div class="timerow">
      <div class="timefield">
        <label>Start (sec)</label>
        <input type="number" step="0.1" min="0" class="t-start" placeholder="0">
      </div>
      <div class="timefield">
        <label>End (sec)</label>
        <input type="number" step="0.1" min="0" class="t-end" placeholder="5">
      </div>
    </div>
    <textarea class="scene-desc" placeholder="e.g. a red sports car drifting around a mountain corner"></textarea>
    <div class="field-err">Fill in start, end, and a description — end must be after start.</div>
  `;
  el.querySelector(".scene-del").addEventListener("click", () => {
    el.remove();
    renumberScenes();
  });
  sceneList.appendChild(el);
}

function renumberScenes(){
  [...sceneList.children].forEach((el, i) => {
    el.querySelector(".scene-label").textContent = `scene ${i+1}`;
  });
}

addSceneBtn.addEventListener("click", () => addScene());
addScene();
addScene();

function readScenes(){
  const els = [...sceneList.children];
  const scenes = [];
  let firstBad = null;
  els.forEach((el) => {
    const start = parseFloat(el.querySelector(".t-start").value);
    const end = parseFloat(el.querySelector(".t-end").value);
    const desc = el.querySelector(".scene-desc").value.trim();
    const errEl = el.querySelector(".field-err");
    const bad = isNaN(start) || isNaN(end) || end <= start || !desc;
    errEl.style.display = bad ? "block" : "none";
    if (bad && !firstBad) firstBad = el;
    if (!bad) scenes.push({ start, end, desc });
  });
  scenes.sort((a,b) => a.start - b.start);
  return { scenes, firstBad };
}

// ---------- Render pipeline ----------
function setStatus(msg){ statusText.textContent = msg; }
function setProgress(pct){
  progressOuter.style.display = "block";
  progressInner.style.width = `${Math.max(0,Math.min(100,pct))}%`;
}

async function generateImage(prompt, seed){
  const styled = `${prompt}, ${STYLE_PROMPTS[styleSelect.value]}`;
  const key = apiKeyInput.value.trim();

  // Try the newer authenticated endpoint first if a key is provided.
  if (key){
    const url = `https://gen.pollinations.ai/image/${encodeURIComponent(styled)}?width=768&height=1344&seed=${seed}&nologo=true&model=flux&key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (res.ok){
      const blob = await res.blob();
      if (blob.size > 2000) return new Uint8Array(await blob.arrayBuffer());
    }
  }

  // Fall back to the legacy no-key endpoint.
  const legacyUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(styled)}?width=768&height=1344&seed=${seed}&nologo=true&model=flux`;
  const res2 = await fetch(legacyUrl);
  if (!res2.ok){
    throw new Error(`image service returned ${res2.status} — try adding a free key above`);
  }
  const blob2 = await res2.blob();
  if (blob2.size < 2000){
    throw new Error("image service returned an empty result — try adding a free key above");
  }
  return new Uint8Array(await blob2.arrayBuffer());
}

async function runRender(){
  const { scenes, firstBad } = readScenes();

  if (!audioFile){
    setStatus("Upload a voiceover file first.");
    audioDrop.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (firstBad){
    setStatus("Fix the highlighted scene before rendering.");
    firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (scenes.length === 0){
    setStatus("Add at least one scene.");
    return;
  }

  renderBtn.disabled = true;
  previewWrap.style.display = "none";
  setProgress(0);

  try{
    setStatus("Starting ffmpeg engine...");
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => { /* console.log(message) */ });
    const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });

    setStatus("Writing voiceover...");
    await ffmpeg.writeFile("voice.mp3", await fetchFile(audioFile));

    const total = scenes.length;
    const clipFiles = [];

    for (let i = 0; i < total; i++){
      const sc = scenes[i];
      const dur = Math.max(0.3, sc.end - sc.start);
      setStatus(`Generating image ${i+1} of ${total}...`);
      setProgress((i / total) * 70);

      let imgBytes;
      try{
        imgBytes = await generateImage(sc.desc, 1000 + i);
      }catch(e){
        setStatus(`Image ${i+1} failed, retrying...`);
        await new Promise(r => setTimeout(r, 1500));
        imgBytes = await generateImage(sc.desc, 2000 + i);
      }
      const imgName = `img${i}.jpg`;
      await ffmpeg.writeFile(imgName, imgBytes);

      const clipName = `clip${i}.mp4`;
      setStatus(`Building scene ${i+1} of ${total}...`);

      const zoomIn = i % 2 === 0;
      const fps = 30;
      const frames = Math.round(dur * fps);
      const zoomExpr = zoomIn
        ? `zoompan=z='min(zoom+0.0015,1.15)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=768x1344:fps=${fps}`
        : `zoompan=z='if(eq(on,1),1.15,max(zoom-0.0015,1.0))':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=768x1344:fps=${fps}`;

      await ffmpeg.exec([
        "-loop", "1",
        "-i", imgName,
        "-vf", `${zoomExpr},format=yuv420p`,
        "-t", String(dur),
        "-r", String(fps),
        "-an",
        clipName
      ]);
      clipFiles.push(clipName);
      await ffmpeg.deleteFile(imgName);
    }

    setStatus("Joining scenes...");
    setProgress(78);
    const listContent = clipFiles.map(f => `file '${f}'`).join("\n");
    await ffmpeg.writeFile("list.txt", listContent);
    await ffmpeg.exec([
      "-f", "concat", "-safe", "0",
      "-i", "list.txt",
      "-c", "copy",
      "silent.mp4"
    ]);

    setStatus("Adding voiceover...");
    setProgress(88);
    await ffmpeg.exec([
      "-i", "silent.mp4",
      "-i", "voice.mp3",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      "final.mp4"
    ]);

    setStatus("Finishing up...");
    setProgress(97);
    const data = await ffmpeg.readFile("final.mp4");
    const blob = new Blob([data.buffer], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);

    previewVideo.src = url;
    downloadLink.href = url;
    previewWrap.style.display = "block";
    setProgress(100);
    setStatus("Done. Preview below.");
    previewWrap.scrollIntoView({ behavior: "smooth", block: "center" });

  }catch(err){
    console.error(err);
    setStatus(`Something went wrong: ${err.message || err}. Try again — retrying usually works.`);
  }finally{
    renderBtn.disabled = false;
  }
}

renderBtn.addEventListener("click", runRender);
