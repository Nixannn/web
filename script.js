
// ── Config ──────────────────────────────────────────────
const FAVOURITES = {
  game:  "Your Game Here",
  movie: "Your Movie Here",
  show:  "Your Show Here"
};

// ── Fill favourites ──────────────────────────────────────
document.querySelector("#fav-game .fav-value").textContent  = FAVOURITES.game;
document.querySelector("#fav-movie .fav-value").textContent = FAVOURITES.movie;
document.querySelector("#fav-show .fav-value").textContent  = FAVOURITES.show;

// ── Video + Audio setup ──────────────────────────────────
const video   = document.getElementById("bg-video");
const btn     = document.getElementById("audio-btn");
const bars    = document.querySelectorAll(".bar");
const card    = document.getElementById("main-card");
const avatar  = document.getElementById("avatar-wrapper");
const orb1    = document.getElementById("orb1");
const orb2    = document.getElementById("orb2");
const orb3    = document.getElementById("orb3");
const canvas  = document.getElementById("visualizer");
const ctx     = canvas.getContext("2d");

let audioCtx, analyser, source, dataArray, animId;
let muted = true;
let audioReady = false;

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

async function setupAudio() {
  if (audioReady) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  dataArray = new Uint8Array(analyser.frequencyBinCount);

  source = audioCtx.createMediaElementSource(video);
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  audioReady = true;
  drawVisualizerLoop();
}

// ── Unmute button ────────────────────────────────────────
btn.addEventListener("click", async () => {
  await setupAudio();
  muted = !muted;
  video.muted = muted;
  btn.textContent = muted ? "unmute" : "mute";

  if (!muted && audioCtx.state === "suspended") {
    a

    let isModalOpen = false;
document.querySelectorAll('.play-btn').forEach(btn => {
  btn.addEventListener('click', () => {  // or 'mouseenter' if hover-triggered
    if (isModalOpen) return;
    isModalOpen = true;
    // Open your MP4 modal here
  });
});
// On modal close: isModalOpen = false;
