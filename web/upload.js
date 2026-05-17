// TE NIMS · FOB — Upload tab
//
// Shows a QR code for mobile upload and a Browse button that feeds files
// into the existing chat composer attachment flow (same as drag-drop).
// No new server endpoints — reuses the existing image/doc attachment system.

import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";
import { addUploadArtifact } from "./artifacts.js";

// Track which mobile-upload files we've already surfaced as artifacts so the
// poller doesn't double-add on each tick.
const _seenMobileUploads = new Set();
let _uploadPollTimer = null;
const UPLOAD_POLL_MS = 4000;

function _guessMime(name) {
  const ext = (name || "").toLowerCase().split(".").pop();
  return ({
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
    json: "application/json", heic: "image/heic",
  })[ext] || "application/octet-stream";
}

async function _pollMobileUploads() {
  try {
    const res = await fetch("/uploads", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    for (const f of j.files || []) {
      if (_seenMobileUploads.has(f.id)) continue;
      _seenMobileUploads.add(f.id);
      try {
        addUploadArtifact({
          name: f.id,
          url:  f.url,                       // /session-upload/<name>
          mime: _guessMime(f.id),
          size: f.size || 0,
          source: "mobile",
        });
      } catch (e) {
        console.warn("[upload poll] artifact add failed:", e);
      }
    }
  } catch (e) {
    /* network blip — try again next tick */
  }
}

function _startUploadPolling() {
  if (_uploadPollTimer) return;
  // First tick immediately so any uploads that arrived before init() runs
  // (e.g. mobile already used the QR) are picked up; subsequent ticks
  // catch new arrivals. artifacts.js dedupes via sessionStorage.
  _pollMobileUploads();
  _uploadPollTimer = setInterval(_pollMobileUploads, UPLOAD_POLL_MS);
}

function _sessionId() {
  const c = document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith("svs_session="));
  return c ? c.split("=")[1] : null;
}

async function _renderQR() {
  const canvas = document.getElementById("upload-qr-canvas");
  const urlEl  = document.getElementById("upload-qr-url");
  if (!canvas) return;

  const sid = _sessionId();
  const url = sid
    ? `${window.location.origin}/upload-mobile?s=${sid}`
    : `${window.location.origin}/upload-mobile`;

  try {
    await QRCode.toCanvas(canvas, url, {
      width: 180, margin: 1,
      color: { dark: "#e8551a", light: "#0d0d0e" },
    });
  } catch (e) { console.warn("[upload] QR failed:", e); }
  if (urlEl) urlEl.textContent = url;
}

export function initUploadPanel() {
  // Re-render QR whenever the Upload tab is opened
  document.querySelector('.tab[data-tab="upload"]')
    ?.addEventListener("click", () => setTimeout(_renderQR, 50));

  // Poll the server for files arriving via /upload-file (mobile QR uploads)
  // and surface each one as an artifact in the Artifacts tab.
  _startUploadPolling();

  // Browse button → click the existing chat file-attach input
  document.getElementById("upload-browse-btn")
    ?.addEventListener("click", () => {
      // The existing chat composer has an img-attach or file attach input;
      // fall back to creating a temporary input if not present.
      const existing = document.getElementById("img-attach") || document.getElementById("doc-attach");
      if (existing) { existing.click(); return; }
      const tmp = document.createElement("input");
      tmp.type = "file";
      tmp.accept = "image/*,application/pdf,.txt,.json,.csv";
      tmp.multiple = true;
      tmp.addEventListener("change", () => {
        // Dispatch a synthetic drop event into the composer drop zone
        const dropZone = document.getElementById("composer");
        if (dropZone && tmp.files?.length) {
          const dt = new DataTransfer();
          [...tmp.files].forEach(f => dt.items.add(f));
          dropZone.dispatchEvent(Object.assign(new DragEvent("drop", { bubbles: true, cancelable: true }),
            { dataTransfer: dt }));
        }
      });
      tmp.click();
    });

  _renderQR();
}
