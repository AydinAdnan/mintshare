import { lazy, startTransition, Suspense, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { parseControlMessage } from "@fileshare/protocol";

const signalUrl = import.meta.env.VITE_SIGNAL_URL || "ws://localhost:3001";
const chunkSize = 64 * 1024;
const maxBufferedAmount = 4 * 1024 * 1024;
const TransferScene = lazy(() => import("./TransferScene.jsx").then((module) => ({ default: module.TransferScene })));

function createRtcConfig() {
  const turnUrls = import.meta.env.VITE_TURN_URLS
    ? import.meta.env.VITE_TURN_URLS.split(",").map((value) => value.trim()).filter(Boolean)
    : [];

  const iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];

  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
  }

  return { iceServers };
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatRate(bytesPerSecond) {
  if (!bytesPerSecond) {
    return "0 B/s";
  }

  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "--";
  }

  if (seconds < 60) {
    return `${Math.ceil(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function createFileDescriptor(file) {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified,
    file,
  };
}

function toDownloadName(relativePath) {
  return relativePath.split("/").filter(Boolean).join("-");
}

export function App() {
  const [mode, setMode] = useState("sender");
  const [status, setStatus] = useState("Idle");
  const [code, setCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [messages, setMessages] = useState([]);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [incomingManifest, setIncomingManifest] = useState(null);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [stats, setStats] = useState({
    totalBytes: 0,
    transferredBytes: 0,
    bytesPerSecond: 0,
    etaSeconds: null,
    currentFileName: "",
    phase: "idle",
  });

  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const controlChannelRef = useRef(null);
  const filesChannelRef = useRef(null);
  const roomCodeRef = useRef("");
  const pendingCandidatesRef = useRef([]);
  const filesRef = useRef([]);
  const transferIdRef = useRef("");
  const manifestSentRef = useRef(false);
  const transferActiveRef = useRef(false);
  const receiveStateRef = useRef({
    transferId: "",
    currentFileId: null,
    currentFileMeta: null,
    chunks: new Map(),
    receivedBytes: 0,
    startedAt: 0,
    lastCheckpointAt: 0,
    lastCheckpointBytes: 0,
  });

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const incomingCode = hash.get("join");
    if (incomingCode) {
      setMode("receiver");
      setJoinCode(incomingCode.toUpperCase());
    }
  }, []);

  useEffect(() => {
    filesRef.current = selectedFiles;
  }, [selectedFiles]);

  function appendMessage(message) {
    setMessages((current) => [message, ...current].slice(0, 8));
  }

  function resetRealtimeState() {
    manifestSentRef.current = false;
    transferActiveRef.current = false;
    transferIdRef.current = "";
    setIncomingManifest(null);
    setStats({
      totalBytes: 0,
      transferredBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      currentFileName: "",
      phase: "idle",
    });
  }

  function closeConnection() {
    if (controlChannelRef.current) {
      controlChannelRef.current.close();
      controlChannelRef.current = null;
    }
    if (filesChannelRef.current) {
      filesChannelRef.current.close();
      filesChannelRef.current = null;
    }
    if (peerRef.current) {
      peerRef.current.close();
      peerRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    pendingCandidatesRef.current = [];
    roomCodeRef.current = "";
    setConnectionState("disconnected");
    resetRealtimeState();
  }

  function sendSignal(type, payload) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    socketRef.current.send(JSON.stringify({ type, payload }));
  }

  function sendControlMessage(type, payload) {
    const channel = controlChannelRef.current;
    if (!channel || channel.readyState !== "open") {
      return;
    }

    channel.send(JSON.stringify({ type, payload }));
  }

  async function waitForBuffer(channel) {
    if (channel.bufferedAmount <= maxBufferedAmount) {
      return;
    }

    await new Promise((resolve) => {
      const handleLowBuffer = () => {
        channel.removeEventListener("bufferedamountlow", handleLowBuffer);
        resolve();
      };

      channel.addEventListener("bufferedamountlow", handleLowBuffer);
    });
  }

  function flushPendingCandidates() {
    if (!peerRef.current || !peerRef.current.remoteDescription) {
      return;
    }

    const pending = [...pendingCandidatesRef.current];
    pendingCandidatesRef.current = [];
    pending.forEach((candidate) => {
      peerRef.current.addIceCandidate(candidate).catch(() => {
        appendMessage("ICE candidate rejected");
      });
    });
  }

  function updateTransferStats(nextTransferredBytes, nextTotalBytes, startedAt, fileName) {
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const bytesPerSecond = nextTransferredBytes / elapsedSeconds;
    const remainingBytes = Math.max(nextTotalBytes - nextTransferredBytes, 0);
    const etaSeconds = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;

    startTransition(() => {
      setStats((current) => ({
        ...current,
        totalBytes: nextTotalBytes,
        transferredBytes: nextTransferredBytes,
        bytesPerSecond,
        etaSeconds,
        currentFileName: fileName || current.currentFileName,
      }));
    });
  }

  function upsertReceivedFile(nextFile) {
    setReceivedFiles((current) => {
      const existingIndex = current.findIndex((file) => file.id === nextFile.id);
      if (existingIndex === -1) {
        return [...current, nextFile];
      }

      const clone = [...current];
      clone[existingIndex] = { ...clone[existingIndex], ...nextFile };
      return clone;
    });
  }

  function handleControlChannelMessage(rawMessage) {
    try {
      const message = parseControlMessage(JSON.parse(rawMessage.data));
      appendMessage(message.type);

      if (message.type === "transfer:manifest") {
        setIncomingManifest(message.payload);
        setReceivedFiles(
          message.payload.files.map((file) => ({
            ...file,
            receivedBytes: 0,
            status: "pending",
            blob: null,
            downloadUrl: "",
          })),
        );
        setStatus("Transfer offer received. Accept to start download.");
        setStats((current) => ({
          ...current,
          totalBytes: message.payload.totalBytes,
          transferredBytes: 0,
          phase: "offered",
        }));
        return;
      }

      if (message.type === "transfer:accept") {
        setStatus("Receiver accepted. Starting transfer.");
        void sendSelectedFiles(message.payload.transferId);
        return;
      }

      if (message.type === "file:start") {
        receiveStateRef.current.currentFileId = message.payload.id;
        receiveStateRef.current.currentFileMeta = message.payload;
        receiveStateRef.current.chunks.set(message.payload.id, []);
        upsertReceivedFile({
          id: message.payload.id,
          name: message.payload.name,
          relativePath: message.payload.relativePath,
          mimeType: message.payload.mimeType,
          size: message.payload.size,
          lastModified: message.payload.lastModified,
          receivedBytes: 0,
          status: "receiving",
        });
        setStatus(`Receiving ${message.payload.name}`);
        setStats((current) => ({
          ...current,
          currentFileName: message.payload.name,
          phase: "receiving",
        }));
        return;
      }

      if (message.type === "file:end") {
        const currentReceive = receiveStateRef.current;
        const fileMeta = currentReceive.currentFileMeta;
        const chunks = currentReceive.chunks.get(message.payload.fileId) || [];
        const blob = new Blob(chunks, { type: fileMeta?.mimeType || "application/octet-stream" });
        const downloadUrl = URL.createObjectURL(blob);
        upsertReceivedFile({
          id: message.payload.fileId,
          blob,
          downloadUrl,
          status: "complete",
          receivedBytes: fileMeta?.size || blob.size,
        });
        currentReceive.currentFileId = null;
        currentReceive.currentFileMeta = null;
        setStatus(`${fileMeta?.name || "File"} ready to download.`);
        return;
      }

      if (message.type === "transfer:complete") {
        setStatus("Transfer complete.");
        setStats((current) => ({ ...current, phase: "complete", etaSeconds: 0 }));
        return;
      }

      if (message.type === "transfer:error") {
        setStatus(message.payload.message);
        setStats((current) => ({ ...current, phase: "error" }));
      }
    } catch (error) {
      appendMessage(error.message || "Invalid control message");
    }
  }

  function handleDataChannelMessage(event) {
    if (!(event.data instanceof ArrayBuffer)) {
      return;
    }

    const currentReceive = receiveStateRef.current;
    if (!currentReceive.currentFileId || !currentReceive.currentFileMeta) {
      return;
    }

    const chunks = currentReceive.chunks.get(currentReceive.currentFileId) || [];
    chunks.push(event.data);
    currentReceive.chunks.set(currentReceive.currentFileId, chunks);
    currentReceive.receivedBytes += event.data.byteLength;

    const now = Date.now();
    const elapsedSeconds = Math.max((now - currentReceive.startedAt) / 1000, 0.001);
    const bytesPerSecond = currentReceive.receivedBytes / elapsedSeconds;
    const remainingBytes = Math.max(stats.totalBytes - currentReceive.receivedBytes, 0);
    const etaSeconds = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;

    if (now - currentReceive.lastCheckpointAt > 200) {
      currentReceive.lastCheckpointAt = now;
      currentReceive.lastCheckpointBytes = currentReceive.receivedBytes;

      upsertReceivedFile({
        id: currentReceive.currentFileId,
        receivedBytes: (chunks.reduce((total, chunk) => total + chunk.byteLength, 0)),
        status: "receiving",
      });
      setStats((current) => ({
        ...current,
        transferredBytes: currentReceive.receivedBytes,
        bytesPerSecond,
        etaSeconds,
        phase: "receiving",
      }));
    }
  }

  function wireControlChannel(channel) {
    controlChannelRef.current = channel;
    channel.onopen = () => {
      setStatus("Control channel ready.");
      appendMessage("control:open");
      if (mode === "sender" && filesRef.current.length > 0) {
        shareSelectedFiles();
      }
    };
    channel.onmessage = handleControlChannelMessage;
  }

  function wireFilesChannel(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 1024 * 1024;
    filesChannelRef.current = channel;
    channel.onopen = () => {
      appendMessage("files:open");
      setConnectionState("connected");
      receiveStateRef.current.startedAt = Date.now();
      receiveStateRef.current.lastCheckpointAt = Date.now();
      if (mode === "sender" && filesRef.current.length > 0) {
        shareSelectedFiles();
      }
    };
    channel.onmessage = handleDataChannelMessage;
  }

  function setupPeerConnection(isInitiator) {
    if (peerRef.current) {
      return peerRef.current;
    }

    const peer = new RTCPeerConnection(createRtcConfig());
    peerRef.current = peer;

    peer.onicecandidate = (event) => {
      if (event.candidate && roomCodeRef.current) {
        sendSignal("signal:ice-candidate", {
          code: roomCodeRef.current,
          candidate: event.candidate,
        });
      }
    };

    peer.onconnectionstatechange = () => {
      setConnectionState(peer.connectionState);
      if (peer.connectionState === "failed") {
        setStatus("Peer connection failed.");
      }
    };

    if (isInitiator) {
      wireControlChannel(peer.createDataChannel("control", { ordered: true }));
      wireFilesChannel(peer.createDataChannel("files", { ordered: true }));
    } else {
      peer.ondatachannel = (event) => {
        if (event.channel.label === "control") {
          wireControlChannel(event.channel);
          return;
        }

        if (event.channel.label === "files") {
          wireFilesChannel(event.channel);
        }
      };
    }

    return peer;
  }

  async function createOffer() {
    const peer = setupPeerConnection(true);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    sendSignal("signal:offer", { code: roomCodeRef.current, sdp: offer });
    setStatus("Waiting for receiver handshake.");
  }

  async function handleSignalingMessage(message) {
    appendMessage(message.type);

    if (message.type === "room:created") {
      roomCodeRef.current = message.payload.code;
      setCode(message.payload.code);
      setStatus("Room created. Share the code or QR.");
      return;
    }

    if (message.type === "room:ready") {
      setStatus("Receiver joined. Opening peer connection.");
      await createOffer();
      return;
    }

    if (message.type === "room:joined") {
      roomCodeRef.current = message.payload.code;
      setCode(message.payload.code);
      setupPeerConnection(false);
      setStatus("Joined room. Waiting for sender offer.");
      return;
    }

    if (message.type === "signal:offer") {
      const peer = setupPeerConnection(false);
      await peer.setRemoteDescription(new RTCSessionDescription(message.payload.sdp));
      flushPendingCandidates();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      sendSignal("signal:answer", { code: roomCodeRef.current, sdp: answer });
      setStatus("Connected to sender. Waiting for transfer manifest.");
      return;
    }

    if (message.type === "signal:answer") {
      await peerRef.current?.setRemoteDescription(new RTCSessionDescription(message.payload.sdp));
      flushPendingCandidates();
      setStatus("Peer handshake complete.");
      return;
    }

    if (message.type === "signal:ice-candidate") {
      const candidate = new RTCIceCandidate(message.payload.candidate);
      if (peerRef.current?.remoteDescription) {
        await peerRef.current.addIceCandidate(candidate);
      } else {
        pendingCandidatesRef.current.push(candidate);
      }
      return;
    }

    if (message.type === "room:error") {
      setStatus(message.payload.message);
      return;
    }

    if (message.type === "room:peer-left") {
      setStatus("Peer disconnected.");
      setConnectionState("disconnected");
    }
  }

  function connectSocket(nextMode) {
    closeConnection();
    resetRealtimeState();
    setMode(nextMode);

    const socket = new WebSocket(signalUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (nextMode === "sender") {
        setStatus("Creating room...");
        socket.send(JSON.stringify({ type: "room:create", payload: { role: "sender" } }));
      } else {
        setStatus("Joining room...");
        socket.send(
          JSON.stringify({
            type: "room:join",
            payload: { code: joinCode.trim().toUpperCase(), role: "receiver" },
          }),
        );
      }
    });
    socket.addEventListener("message", (event) => {
      void handleSignalingMessage(JSON.parse(event.data));
    });
    socket.addEventListener("close", () => {
      appendMessage("socket:closed");
    });
  }

  function shareSelectedFiles() {
    if (manifestSentRef.current || mode !== "sender") {
      return;
    }

    if (controlChannelRef.current?.readyState !== "open" || filesRef.current.length === 0) {
      return;
    }

    const transferId = crypto.randomUUID();
    transferIdRef.current = transferId;
    manifestSentRef.current = true;

    const manifest = {
      transferId,
      totalBytes: filesRef.current.reduce((total, file) => total + file.size, 0),
      files: filesRef.current.map(({ file, ...metadata }) => metadata),
    };

    sendControlMessage("transfer:manifest", manifest);
    setStatus("Transfer manifest sent. Waiting for receiver approval.");
    setStats((current) => ({
      ...current,
      totalBytes: manifest.totalBytes,
      transferredBytes: 0,
      phase: "offered",
    }));
  }

  async function sendSelectedFiles(transferId) {
    if (transferActiveRef.current || filesChannelRef.current?.readyState !== "open") {
      return;
    }

    transferActiveRef.current = true;
    const channel = filesChannelRef.current;
    const startedAt = Date.now();
    const totalBytes = filesRef.current.reduce((total, file) => total + file.size, 0);
    let transferredBytes = 0;

    setStats((current) => ({ ...current, phase: "sending", totalBytes }));

    try {
      for (const fileDescriptor of filesRef.current) {
        sendControlMessage("file:start", {
          transferId,
          id: fileDescriptor.id,
          name: fileDescriptor.name,
          relativePath: fileDescriptor.relativePath,
          mimeType: fileDescriptor.mimeType,
          size: fileDescriptor.size,
          lastModified: fileDescriptor.lastModified,
        });

        for (let offset = 0; offset < fileDescriptor.size; offset += chunkSize) {
          const chunk = await fileDescriptor.file.slice(offset, offset + chunkSize).arrayBuffer();
          channel.send(chunk);
          transferredBytes += chunk.byteLength;
          updateTransferStats(transferredBytes, totalBytes, startedAt, fileDescriptor.name);
          await waitForBuffer(channel);
        }

        sendControlMessage("file:end", { transferId, fileId: fileDescriptor.id });
      }

      sendControlMessage("transfer:complete", { transferId });
      setStatus("All files sent.");
      setStats((current) => ({ ...current, phase: "complete", etaSeconds: 0 }));
    } catch (error) {
      sendControlMessage("transfer:error", { transferId, message: error.message || "Transfer failed" });
      setStatus(error.message || "Transfer failed");
      setStats((current) => ({ ...current, phase: "error" }));
    } finally {
      transferActiveRef.current = false;
    }
  }

  function handleFileSelection(event) {
    const nextFiles = Array.from(event.target.files || []).map(createFileDescriptor);
    setSelectedFiles(nextFiles);
    manifestSentRef.current = false;
    setStatus(nextFiles.length > 0 ? `${nextFiles.length} item(s) ready to share.` : "Idle");
    if (mode === "sender" && controlChannelRef.current?.readyState === "open") {
      shareSelectedFiles();
    }
  }

  function acceptTransfer() {
    if (!incomingManifest) {
      return;
    }

    receiveStateRef.current.transferId = incomingManifest.transferId;
    receiveStateRef.current.receivedBytes = 0;
    receiveStateRef.current.startedAt = Date.now();
    receiveStateRef.current.lastCheckpointAt = Date.now();
    sendControlMessage("transfer:accept", { transferId: incomingManifest.transferId });
    setStatus("Transfer accepted. Waiting for file stream.");
    setStats((current) => ({ ...current, phase: "receiving" }));
  }

  async function downloadAllAsZip() {
    const completedFiles = receivedFiles.filter((file) => file.status === "complete" && file.blob);
    if (completedFiles.length === 0) {
      return;
    }

    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    completedFiles.forEach((file) => {
      archive.file(file.relativePath, file.blob);
    });

    setStatus("Building zip archive...");
    const blob = await archive.generateAsync({ type: "blob" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `file-share-${code || joinCode || "transfer"}.zip`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
    setStatus("Zip archive downloaded.");
  }

  const qrValue = code ? `${window.location.origin}/#join=${code}` : "";
  const progressRatio = stats.totalBytes > 0 ? stats.transferredBytes / stats.totalBytes : 0;
  const completedDownloads = receivedFiles.filter((file) => file.status === "complete");

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Browser-to-browser transfer</p>
          <h1>Send files directly with no accounts and no cloud upload.</h1>
          <p className="lede">
            JavaScript-only implementation with WebRTC room setup, chunked transfer flow,
            QR join, individual downloads, zip export, and a lightweight Three.js scene.
          </p>
        </div>
        <Suspense fallback={<div className="scene-shell scene-fallback" aria-hidden="true" />}>
          <TransferScene active={stats.phase === "sending" || stats.phase === "receiving"} progress={progressRatio} />
        </Suspense>
      </section>

      <section className="panel-grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Start sharing</h2>
            <button type="button" onClick={() => setMode("sender")} className={mode === "sender" ? "active" : ""}>
              Sender
            </button>
          </div>
          <p>Pick files or a folder, then create a six-character code and QR.</p>
          <div className="picker-row">
            <label className="picker-button">
              <span>Select files</span>
              <input type="file" multiple onChange={handleFileSelection} />
            </label>
            <label className="picker-button">
              <span>Select folder</span>
              <input type="file" multiple webkitdirectory="" onChange={handleFileSelection} />
            </label>
          </div>
          <button type="button" onClick={() => connectSocket("sender")}>Create room</button>
          {code ? <p className="code-pill">{code}</p> : null}
          {qrValue ? <QRCodeSVG value={qrValue} size={144} bgColor="transparent" fgColor="#f3efe6" /> : null}
          <div className="file-list">
            {selectedFiles.map((file) => (
              <div key={file.id} className="file-row">
                <span>{file.relativePath}</span>
                <strong>{formatBytes(file.size)}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h2>Join transfer</h2>
            <button type="button" onClick={() => setMode("receiver")} className={mode === "receiver" ? "active" : ""}>
              Receiver
            </button>
          </div>
          <label htmlFor="join-code">Share code</label>
          <input
            id="join-code"
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
            maxLength={6}
            placeholder="ABC123"
          />
          <button type="button" onClick={() => connectSocket("receiver")}>Join room</button>
          {incomingManifest ? (
            <>
              <div className="manifest-summary">
                <strong>{incomingManifest.files.length} item(s)</strong>
                <span>{formatBytes(incomingManifest.totalBytes)}</span>
              </div>
              <button type="button" onClick={acceptTransfer}>Accept transfer</button>
            </>
          ) : null}
          <div className="file-list receiver-list">
            {receivedFiles.map((file) => (
              <div key={file.id} className="file-row stacked">
                <div>
                  <span>{file.relativePath}</span>
                  <small>
                    {formatBytes(file.receivedBytes || 0)} / {formatBytes(file.size)}
                  </small>
                </div>
                {file.downloadUrl ? (
                  <a href={file.downloadUrl} download={toDownloadName(file.relativePath)} className="download-link">
                    Download
                  </a>
                ) : (
                  <strong>{file.status}</strong>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={downloadAllAsZip} disabled={completedDownloads.length === 0}>
            Download all as zip
          </button>
        </article>
      </section>

      <section className="status-panel">
        <h2>Status</h2>
        <p>{status}</p>
        <div className="stats-grid">
          <div>
            <span>Connection</span>
            <strong>{connectionState}</strong>
          </div>
          <div>
            <span>Transferred</span>
            <strong>{formatBytes(stats.transferredBytes)} / {formatBytes(stats.totalBytes)}</strong>
          </div>
          <div>
            <span>Speed</span>
            <strong>{formatRate(stats.bytesPerSecond)}</strong>
          </div>
          <div>
            <span>ETA</span>
            <strong>{formatEta(stats.etaSeconds)}</strong>
          </div>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.max(progressRatio * 100, 2)}%` }} />
        </div>
        <div className="message-list">
          {messages.map((message, index) => (
            <span key={`${message}-${index}`}>{message}</span>
          ))}
        </div>
        <button type="button" className="ghost-button" onClick={closeConnection}>
          Reset connection
        </button>
      </section>
    </main>
  );
}
