import { lazy, startTransition, Suspense, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { parseControlMessage } from "@fileshare/protocol";
import mintshareLogo from "./mintshare-logo.svg";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const signalUrl = import.meta.env.VITE_SIGNAL_URL || `ws://${window.location.hostname}:3001`;
const chunkSize = parsePositiveInt(import.meta.env.VITE_CHUNK_SIZE_BYTES, 256 * 1024);
const maxBufferedAmount = parsePositiveInt(import.meta.env.VITE_MAX_BUFFERED_AMOUNT_BYTES, 8 * 1024 * 1024);
const hasTurnConfigured = Boolean(import.meta.env.VITE_TURN_URLS?.trim());
const roomCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
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
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatRate(bytesPerSecond) {
  if (!bytesPerSecond) return "0 B/s";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
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

function sumFileSizes(files) {
  return files.reduce((total, file) => total + file.size, 0);
}

function toDownloadName(relativePath) {
  return relativePath.split("/").filter(Boolean).join("-");
}

function createArchiveName() {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
  return `MintShare_${suffix}.zip`;
}

function sanitizeRoomCode(value) {
  return value
    .toUpperCase()
    .split("")
    .filter((character) => roomCodeAlphabet.includes(character))
    .join("")
    .slice(0, 6);
}

function triggerBrowserDownload(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const CircularProgress = ({ progress }) => {
  const radius = 100;
  const stroke = 12;
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - progress * circumference;

  return (
    <div className="circular-progress">
      <svg height={radius * 2} width={radius * 2}>
        <circle
          stroke="rgba(255,255,255,0.05)"
          fill="transparent"
          strokeWidth={stroke}
          r={normalizedRadius}
          cx={radius}
          cy={radius}
        />
        <circle
          stroke="#ffffff"
          fill="transparent"
          strokeWidth={stroke}
          strokeDasharray={circumference + " " + circumference}
          style={{ strokeDashoffset, transition: "stroke-dashoffset 0.1s linear" }}
          strokeLinecap="round"
          r={normalizedRadius}
          cx={radius}
          cy={radius}
          transform={`rotate(-90 ${radius} ${radius})`}
        />
      </svg>
      <div className="progress-content">
        <h2>{Math.round(progress * 100)}%</h2>
      </div>
    </div>
  );
};

function FileSummaryList({ files, activeName = "", emptyLabel }) {
  if (!files.length) {
    return <p className="file-list-empty">{emptyLabel}</p>;
  }

  return (
    <div className="file-list">
      {files.map((file) => (
        <div key={file.id} className={`file-list-item${activeName && file.name === activeName ? " active" : ""}`}>
          <span className="file-list-name">{file.name}</span>
          <span className="file-list-size">{formatBytes(file.size)}</span>
        </div>
      ))}
    </div>
  );
}

function BrandHeader() {
  return (
    <div className="brand-header">
      <img src={mintshareLogo} alt="MintShare logo" className="brand-logo" />
      <div className="brand-copy">
        <span className="brand-name">MintShare</span>
        <span className="brand-tagline">Direct browser-to-browser file transfer</span>
      </div>
    </div>
  );
}

export function App() {
  const [uiStep, setUiStep] = useState("home"); // home, code, input, review, transferring, complete
  const [mode, setMode] = useState("sender");
  const [code, setCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [selectedReceiveIds, setSelectedReceiveIds] = useState([]);
  const [selectedDownloadIds, setSelectedDownloadIds] = useState([]);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [pairingMessage, setPairingMessage] = useState("");
  const [pairingError, setPairingError] = useState("");
  const [transferError, setTransferError] = useState("");
  const [errorMessages, setErrorMessages] = useState([]);
  const [stats, setStats] = useState({
    totalBytes: 0,
    transferredBytes: 0,
    bytesPerSecond: 0,
    etaSeconds: null,
    currentFileName: "",
  });

  const fileInputRef = useRef(null);
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
  const pendingManifestRef = useRef(null);
  const joinAttemptRef = useRef("");
  const intentionalCloseRef = useRef(false);
  const uiStepRef = useRef("home");
  const modeRef = useRef("sender");
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
    uiStepRef.current = uiStep;
  }, [uiStep]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.WebSocket) {
      setPairingError("This browser does not support secure pairing over WebSocket.");
      return;
    }
    if (!window.RTCPeerConnection) {
      setPairingError("This browser does not support direct browser-to-browser file transfer.");
    }
  }, []);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const incomingCode = sanitizeRoomCode(hash.get("join") || "");
    if (incomingCode) {
      setMode("receiver");
      setUiStep("input");
      setJoinCode(incomingCode);
      setPairingMessage("Connecting...");
      connectSocket("receiver", incomingCode);
    }
  }, []);

  useEffect(() => {
    if (uiStep !== "input") return;
    if (joinCode.length !== 6) return;
    if (joinAttemptRef.current === joinCode) return;

    joinAttemptRef.current = joinCode;
    setPairingError("");
    setPairingMessage("Connecting...");
    connectSocket("receiver", joinCode);
  }, [joinCode, uiStep]);

  useEffect(() => {
    filesRef.current = selectedFiles;
  }, [selectedFiles]);

  useEffect(() => {
    return () => {
      receivedFiles.forEach((file) => {
        if (file.downloadUrl) {
          URL.revokeObjectURL(file.downloadUrl);
        }
      });
    };
  }, [receivedFiles]);

  useEffect(() => {
    const handlePageHide = () => {
      closeConnection();
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  }, []);

  useEffect(() => {
    if (mode !== "receiver") return;
    const completeIds = receivedFiles.filter((file) => file.status === "complete" && file.downloadUrl).map((file) => file.id);
    setSelectedDownloadIds((current) => {
      const currentSet = new Set(current);
      let changed = current.length !== completeIds.length;
      if (!changed) {
        for (const id of completeIds) {
          if (!currentSet.has(id)) {
            changed = true;
            break;
          }
        }
      }
      return changed ? completeIds : current;
    });
  }, [mode, receivedFiles]);

  function resetRealtimeState() {
    manifestSentRef.current = false;
    transferActiveRef.current = false;
    transferIdRef.current = "";
    pendingManifestRef.current = null;
    setArchiveBusy(false);
    setSelectedReceiveIds([]);
    setTransferError("");
    setStats({
      totalBytes: 0,
      transferredBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      currentFileName: "",
    });
  }

  function closeConnection() {
    intentionalCloseRef.current = true;
    if (controlChannelRef.current) controlChannelRef.current.close();
    if (filesChannelRef.current) filesChannelRef.current.close();
    if (peerRef.current) peerRef.current.close();
    if (socketRef.current) socketRef.current.close();
    controlChannelRef.current = null;
    filesChannelRef.current = null;
    peerRef.current = null;
    socketRef.current = null;
    pendingCandidatesRef.current = [];
    roomCodeRef.current = "";
    joinAttemptRef.current = "";
    setCode("");
    resetRealtimeState();
    window.setTimeout(() => {
      intentionalCloseRef.current = false;
    }, 0);
  }

  function goHome() {
    receivedFiles.forEach((file) => {
      if (file.downloadUrl) {
        URL.revokeObjectURL(file.downloadUrl);
      }
    });
    closeConnection();
    setUiStep("home");
    setJoinCode("");
    setCode("");
    setSelectedFiles([]);
    setReceivedFiles([]);
    setSelectedReceiveIds([]);
    setSelectedDownloadIds([]);
    setPairingMessage("");
    setPairingError("");
    setTransferError("");
    setErrorMessages([]);
  }

  function addErrorMessage(message) {
    if (!message) return;
    setErrorMessages((current) => (current.includes(message) ? current : [...current, message]));
  }

  function clearErrors() {
    setErrorMessages([]);
    setPairingError("");
    setTransferError("");
  }

  function showPairingError(message, fallbackStep = null) {
    setPairingMessage("");
    setPairingError(message);
    addErrorMessage(message);
    if (fallbackStep) {
      setUiStep(fallbackStep);
    }
  }

  function showTransferError(message, fallbackStep = "home") {
    setTransferError(message);
    setPairingMessage("");
    addErrorMessage(message);
    if (fallbackStep) {
      setUiStep(fallbackStep);
    }
  }

  function cancelTransfer() {
    if (controlChannelRef.current?.readyState === "open" && transferIdRef.current) {
      sendControlMessage("transfer:error", {
        transferId: transferIdRef.current,
        message: modeRef.current === "sender" ? "The sender cancelled the transfer." : "The receiver cancelled the transfer.",
      });
    }

    closeConnection();
    addErrorMessage(modeRef.current === "sender" ? "You cancelled the transfer." : "You cancelled receiving the transfer.");
    setUiStep("home");
  }

  async function saveReceivedFile(file) {
    if (!file?.downloadUrl) {
      showTransferError("The received file is not ready to save yet.", uiStepRef.current);
      return;
    }

    try {
      triggerBrowserDownload(file.downloadUrl, toDownloadName(file.relativePath || file.name));
    } catch (error) {
      console.error(error);
      showTransferError("Your browser could not start the download. Try again.", uiStepRef.current);
    }
  }

  async function downloadSelectedFiles() {
    const filesToDownload = receivedFiles.filter((file) => selectedDownloadIds.includes(file.id) && file.downloadUrl);
    if (filesToDownload.length === 0) {
      showTransferError("Select at least one file to download.", uiStepRef.current);
      return;
    }

    for (const file of filesToDownload) {
      await saveReceivedFile(file);
    }
  }

  async function downloadSelectedAsZip() {
    const filesToZip = receivedFiles.filter((file) => selectedDownloadIds.includes(file.id) && file.blob);
    if (filesToZip.length === 0) {
      showTransferError("Select at least one file to download as a zip.", uiStepRef.current);
      return;
    }

    setArchiveBusy(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();

      filesToZip.forEach((file) => {
        zip.file(file.relativePath || file.name, file.blob);
      });

      const archiveBlob = await zip.generateAsync({ type: "blob" });
      const archiveUrl = URL.createObjectURL(archiveBlob);
      try {
        triggerBrowserDownload(archiveUrl, createArchiveName());
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(archiveUrl), 60_000);
      }
    } catch (error) {
      console.error(error);
      showTransferError("Could not prepare the zip archive.", uiStepRef.current);
    } finally {
      setArchiveBusy(false);
    }
  }

  function toggleDownloadSelection(fileId) {
    setSelectedDownloadIds((current) => (
      current.includes(fileId)
        ? current.filter((id) => id !== fileId)
        : [...current, fileId]
    ));
  }

  function toggleReceiveSelection(fileId) {
    setSelectedReceiveIds((current) => (
      current.includes(fileId)
        ? current.filter((id) => id !== fileId)
        : [...current, fileId]
    ));
  }

  function sendSignal(type, payload) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type, payload }));
      return true;
    }
    showPairingError("Pairing connection is not open. Please retry.", modeRef.current === "sender" ? "home" : "input");
    return false;
  }

  function sendControlMessage(type, payload) {
    if (controlChannelRef.current?.readyState === "open") {
      controlChannelRef.current.send(JSON.stringify({ type, payload }));
      return true;
    }
    showTransferError("Transfer channel is not open. Reconnect and try again.");
    return false;
  }

  async function waitForBuffer(channel) {
    if (channel.bufferedAmount <= maxBufferedAmount) return;
    await new Promise((resolve) => {
      const handleLowBuffer = () => {
        channel.removeEventListener("bufferedamountlow", handleLowBuffer);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", handleLowBuffer);
    });
  }

  function flushPendingCandidates() {
    if (!peerRef.current || !peerRef.current.remoteDescription) return;
    const pending = [...pendingCandidatesRef.current];
    pendingCandidatesRef.current = [];
    pending.forEach((candidate) => {
      peerRef.current.addIceCandidate(candidate).catch(() => {});
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
      if (existingIndex === -1) return [...current, nextFile];
      const clone = [...current];
      clone[existingIndex] = { ...clone[existingIndex], ...nextFile };
      return clone;
    });
  }

  function acceptTransfer(manifest, selectedFileIds) {
    const acceptedFiles = manifest.files.filter((file) => selectedFileIds.includes(file.id));

    if (acceptedFiles.length === 0) {
      showTransferError("Select at least one file to receive.", "review");
      return;
    }

    receiveStateRef.current.transferId = manifest.transferId;
    receiveStateRef.current.receivedBytes = 0;
    receiveStateRef.current.startedAt = Date.now();
    receiveStateRef.current.lastCheckpointAt = Date.now();
    transferIdRef.current = manifest.transferId;

    setReceivedFiles(
      acceptedFiles.map((file) => ({
        ...file,
        receivedBytes: 0,
        status: "pending",
        blob: null,
        downloadUrl: "",
      }))
    );
    setStats((current) => ({
      ...current,
      totalBytes: sumFileSizes(acceptedFiles),
      transferredBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      currentFileName: acceptedFiles.length === 1 ? acceptedFiles[0].name : `${acceptedFiles.length} files selected`,
    }));

    if (!sendControlMessage("transfer:accept", { transferId: manifest.transferId, selectedFileIds })) return;
    pendingManifestRef.current = null;
    setUiStep("transferring");
  }

  function handleReceiveSelectedFiles() {
    if (!pendingManifestRef.current) {
      showTransferError("No transfer is waiting for your selection.", "input");
      return;
    }

    acceptTransfer(pendingManifestRef.current, selectedReceiveIds);
  }

  function handleControlChannelMessage(rawMessage) {
    try {
      const message = parseControlMessage(JSON.parse(rawMessage.data));

      if (message.type === "transfer:manifest") {
        pendingManifestRef.current = message.payload;
        setReceivedFiles(
          message.payload.files.map((file) => ({
            ...file,
            receivedBytes: 0,
            status: "pending",
            blob: null,
            downloadUrl: "",
          }))
        );
        setSelectedReceiveIds([]);
        setStats((current) => ({
          ...current,
          totalBytes: message.payload.totalBytes,
          transferredBytes: 0,
          bytesPerSecond: 0,
          etaSeconds: null,
          currentFileName: "",
        }));
        setUiStep("review");
        return;
      }

      if (message.type === "transfer:accept") {
        const acceptedIds = new Set(message.payload.selectedFileIds);
        const acceptedFiles = filesRef.current.filter((file) => acceptedIds.has(file.id));

        if (acceptedFiles.length === 0) {
          showTransferError("The receiver did not select any files.", "code");
          return;
        }

        transferIdRef.current = message.payload.transferId;
        setStats((current) => ({
          ...current,
          totalBytes: sumFileSizes(acceptedFiles),
          transferredBytes: 0,
          bytesPerSecond: 0,
          etaSeconds: null,
          currentFileName: acceptedFiles.length === 1 ? acceptedFiles[0].name : `${acceptedFiles.length} files selected`,
        }));
        setUiStep("transferring");
        void sendSelectedFiles(message.payload.transferId, message.payload.selectedFileIds);
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
        setStats((current) => ({ ...current, currentFileName: message.payload.name }));
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

        return;
      }

      if (message.type === "transfer:complete") {
        setUiStep("complete");
        setStats((current) => ({ ...current, etaSeconds: 0 }));
        return;
      }

      if (message.type === "transfer:error") {
        showTransferError(message.payload.message || "Transfer failed.", "home");
      }
    } catch (error) {
      console.error(error);
      showTransferError("Received an invalid control message. Please retry the transfer.");
    }
  }

  function handleDataChannelMessage(event) {
    if (!(event.data instanceof ArrayBuffer)) return;

    const currentReceive = receiveStateRef.current;
    if (!currentReceive.currentFileId || !currentReceive.currentFileMeta) return;

    const chunks = currentReceive.chunks.get(currentReceive.currentFileId) || [];
    chunks.push(event.data);
    currentReceive.chunks.set(currentReceive.currentFileId, chunks);
    currentReceive.receivedBytes += event.data.byteLength;

    const now = Date.now();
    const elapsedSeconds = Math.max((now - currentReceive.startedAt) / 1000, 0.001);
    const bytesPerSecond = currentReceive.receivedBytes / elapsedSeconds;
    const remainingBytes = Math.max(stats.totalBytes - currentReceive.receivedBytes, 0);
    const etaSeconds = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;

    if (now - currentReceive.lastCheckpointAt > 100) {
      currentReceive.lastCheckpointAt = now;
      currentReceive.lastCheckpointBytes = currentReceive.receivedBytes;

      upsertReceivedFile({
        id: currentReceive.currentFileId,
        receivedBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
        status: "receiving",
      });
      setStats((current) => ({
        ...current,
        transferredBytes: currentReceive.receivedBytes,
        bytesPerSecond,
        etaSeconds,
      }));
    }
  }

  function wireControlChannel(channel) {
    controlChannelRef.current = channel;
    channel.onopen = () => {
      if (mode === "sender" && filesRef.current.length > 0) shareSelectedFiles();
    };
    channel.onmessage = handleControlChannelMessage;
    channel.onerror = () => {
      showTransferError("The control channel failed during transfer setup.");
    };
    channel.onclose = () => {
      if (intentionalCloseRef.current) return;
      if (uiStepRef.current === "complete") return;
      if (transferActiveRef.current || uiStepRef.current === "transferring") {
        showTransferError("The connection to the other device was lost during transfer.");
      }
    };
  }

  function wireFilesChannel(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 1024 * 1024;
    filesChannelRef.current = channel;
    channel.onopen = () => {
      receiveStateRef.current.startedAt = Date.now();
      receiveStateRef.current.lastCheckpointAt = Date.now();
      if (mode === "sender" && filesRef.current.length > 0) shareSelectedFiles();
    };
    channel.onmessage = handleDataChannelMessage;
    channel.onerror = () => {
      showTransferError("The file data channel failed.");
    };
    channel.onclose = () => {
      if (intentionalCloseRef.current) return;
      if (uiStepRef.current === "complete") return;
      if (transferActiveRef.current || uiStepRef.current === "transferring") {
        showTransferError("The file transfer stopped because the data channel closed.");
      }
    };
  }

  function setupPeerConnection(isInitiator) {
    if (peerRef.current) return peerRef.current;

    const peer = new RTCPeerConnection(createRtcConfig());
    peerRef.current = peer;

    peer.onicecandidate = (event) => {
      if (event.candidate && roomCodeRef.current) {
        sendSignal("signal:ice-candidate", { code: roomCodeRef.current, candidate: event.candidate });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") {
        showTransferError("Peer connection failed. The devices could not establish a direct link.");
      }

      if (peer.connectionState === "disconnected") {
        if (intentionalCloseRef.current) return;
        if (uiStepRef.current === "complete") return;
        showTransferError("The other device disconnected.");
      }
    };

    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === "failed") {
        showTransferError(
          hasTurnConfigured
            ? "Network path discovery failed. Try both devices on the same network or retry the transfer."
            : "Direct device connection failed. Mobile and cross-network transfers usually need a TURN relay server."
        );
      }
    };

    if (isInitiator) {
      wireControlChannel(peer.createDataChannel("control", { ordered: true }));
      wireFilesChannel(peer.createDataChannel("files", { ordered: true }));
    } else {
      peer.ondatachannel = (event) => {
        if (event.channel.label === "control") wireControlChannel(event.channel);
        if (event.channel.label === "files") wireFilesChannel(event.channel);
      };
    }

    return peer;
  }

  async function createOffer() {
    try {
      const peer = setupPeerConnection(true);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sendSignal("signal:offer", { code: roomCodeRef.current, sdp: offer });
    } catch (error) {
      console.error(error);
      showPairingError("Unable to start pairing on this device.", "home");
    }
  }

  async function handleSignalingMessage(message) {
    try {
      if (message.type === "room:created") {
        roomCodeRef.current = message.payload.code;
        setCode(message.payload.code);
        setPairingMessage("Scan the QR code or enter the code on the other device.");
        clearErrors();
        setUiStep("code");
        return;
      }
      if (message.type === "room:ready") {
        setPairingMessage("Receiver connected.");
        await createOffer();
        return;
      }
      if (message.type === "room:joined") {
        roomCodeRef.current = message.payload.code;
        setCode(message.payload.code);
        setPairingMessage("Connected. Waiting for sender...");
        clearErrors();
        setupPeerConnection(false);
        return;
      }
      if (message.type === "room:error") {
        showPairingError(message.payload.message || "Unable to connect.", modeRef.current === "receiver" ? "input" : "home");
        joinAttemptRef.current = "";
        return;
      }
      if (message.type === "room:expired" || message.type === "room:peer-left") {
        showPairingError(message.type === "room:peer-left" ? "The other device left." : "This code expired.", modeRef.current === "sender" ? "home" : "input");
        joinAttemptRef.current = "";
        return;
      }
      if (message.type === "signal:offer") {
        const peer = setupPeerConnection(false);
        await peer.setRemoteDescription(new RTCSessionDescription(message.payload.sdp));
        flushPendingCandidates();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendSignal("signal:answer", { code: roomCodeRef.current, sdp: answer });
        return;
      }
      if (message.type === "signal:answer") {
        await peerRef.current?.setRemoteDescription(new RTCSessionDescription(message.payload.sdp));
        flushPendingCandidates();
        return;
      }
      if (message.type === "signal:ice-candidate") {
        const candidate = new RTCIceCandidate(message.payload.candidate);
        if (peerRef.current?.remoteDescription) {
          await peerRef.current.addIceCandidate(candidate);
        } else {
          pendingCandidatesRef.current.push(candidate);
        }
      }
    } catch (error) {
      console.error(error);
      showPairingError("Pairing failed while negotiating the device connection.", modeRef.current === "sender" ? "home" : "input");
    }
  }

  function connectSocket(nextMode, specificCode = null) {
    closeConnection();
    setMode(nextMode);
    clearErrors();
    setPairingError("");
    setPairingMessage(nextMode === "sender" ? "Creating a secure connection..." : "Connecting...");
    if (nextMode === "sender") {
      setUiStep("code");
    }

    const socket = new WebSocket(signalUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (nextMode === "sender") {
        socket.send(JSON.stringify({ type: "room:create", payload: { role: "sender" } }));
      } else {
        const jCode = sanitizeRoomCode(specificCode || joinCode);
        if (jCode.length !== 6) {
          showPairingError("Enter a valid 6-character code.", "input");
          return;
        }
        socket.send(JSON.stringify({ type: "room:join", payload: { code: jCode, role: "receiver" } }));
      }
    });
    socket.addEventListener("message", (event) => {
      try {
        void handleSignalingMessage(JSON.parse(event.data));
      } catch (error) {
        console.error(error);
        showPairingError("Received an invalid response from the pairing server.", nextMode === "sender" ? "home" : "input");
      }
    });
    socket.addEventListener("error", () => {
      showPairingError("Unable to reach the pairing server.", nextMode === "sender" ? "home" : "input");
    });
    socket.addEventListener("close", () => {
      if (intentionalCloseRef.current) return;
      if (transferActiveRef.current) return;
      if (uiStepRef.current === "complete") return;
      if (nextMode === "sender" && !roomCodeRef.current) {
        showPairingError("Connection closed before a pairing code was created.", "home");
        return;
      }
      if (uiStepRef.current === "code" || uiStepRef.current === "input") {
        showPairingError("Pairing server connection was closed.", nextMode === "sender" ? "home" : "input");
      }
    });
  }

  function shareSelectedFiles() {
    if (manifestSentRef.current || mode !== "sender" || controlChannelRef.current?.readyState !== "open" || filesRef.current.length === 0) return;
    const transferId = crypto.randomUUID();
    transferIdRef.current = transferId;
    manifestSentRef.current = true;

    const manifest = {
      transferId,
      totalBytes: filesRef.current.reduce((total, file) => total + file.size, 0),
      files: filesRef.current.map(({ file, ...metadata }) => metadata),
    };

    sendControlMessage("transfer:manifest", manifest);
    setStats((current) => ({ ...current, totalBytes: manifest.totalBytes }));
  }

  async function sendSelectedFiles(transferId, selectedFileIds = []) {
    if (transferActiveRef.current || filesChannelRef.current?.readyState !== "open") return;
    transferActiveRef.current = true;
    const channel = filesChannelRef.current;
    const startedAt = Date.now();
    const filesToSend = selectedFileIds.length > 0
      ? filesRef.current.filter((file) => selectedFileIds.includes(file.id))
      : filesRef.current;
    const totalBytes = sumFileSizes(filesToSend);
    let transferredBytes = 0;

    try {
      if (filesToSend.length === 0) {
        throw new Error("The receiver did not approve any files for transfer.");
      }

      for (const fileDescriptor of filesToSend) {
        if (!sendControlMessage("file:start", { transferId, ...fileDescriptor, file: undefined })) return;
        for (let offset = 0; offset < fileDescriptor.size; offset += chunkSize) {
          const chunk = await fileDescriptor.file.slice(offset, offset + chunkSize).arrayBuffer();
          channel.send(chunk);
          transferredBytes += chunk.byteLength;
          updateTransferStats(transferredBytes, totalBytes, startedAt, fileDescriptor.name);
          await waitForBuffer(channel);
        }
        if (!sendControlMessage("file:end", { transferId, fileId: fileDescriptor.id })) return;
      }
      if (!sendControlMessage("transfer:complete", { transferId })) return;
      setUiStep("complete");
    } catch (error) {
      console.error(error);
      showTransferError(error?.message || "Transfer failed while sending the selected files.");
    } finally {
      transferActiveRef.current = false;
    }
  }

  function handleFileSelection(event) {
    const nextFiles = Array.from(event.target.files || []).map(createFileDescriptor);
    if (nextFiles.length > 0) {
      clearErrors();
      setSelectedFiles(nextFiles);
      setStats((current) => ({
        ...current,
        totalBytes: sumFileSizes(nextFiles),
        transferredBytes: 0,
        currentFileName: nextFiles.length === 1 ? nextFiles[0].name : `${nextFiles.length} files selected`,
      }));
      connectSocket("sender");
    }
    event.target.value = "";
  }

  function onPinChange(e) {
    const val = sanitizeRoomCode(e.target.value);
    if (joinAttemptRef.current && val !== joinAttemptRef.current) {
      joinAttemptRef.current = "";
      setPairingMessage("");
      setPairingError("");
    }
    setJoinCode(val);
  }

  const progressRatio = stats.totalBytes > 0 ? stats.transferredBytes / stats.totalBytes : 0;
  const qrValue = code ? `${window.location.origin}/#join=${code}` : "";
  const completedReceivedFiles = receivedFiles.filter((file) => file.status === "complete" && file.downloadUrl);
  const selectedReceiveFiles = receivedFiles.filter((file) => selectedReceiveIds.includes(file.id));
  const selectedCompleteFiles = completedReceivedFiles.filter((file) => selectedDownloadIds.includes(file.id));
  const displayErrors = Array.from(new Set([pairingError, transferError, ...errorMessages].filter(Boolean)));
  const shouldShowBrandHeader = !(mode === "sender" && selectedFiles.length > 0 && ["code", "transferring", "complete"].includes(uiStep));

  return (
    <main className="app-main">
      <Suspense fallback={<div className="scene-background" />}>
        <TransferScene step={uiStep === "complete" ? "done" : uiStep} progress={progressRatio} />
      </Suspense>

      <div className="overlay-ui">
        {shouldShowBrandHeader ? <BrandHeader /> : null}

        {uiStep === "home" && (
          <div className="card fade-in home-card">
            <p>Direct peer-to-peer file transfer.</p>
            {displayErrors.length > 0 ? (
              <div className="error-block">
                {displayErrors.map((message) => (
                  <p key={message} className="error-text">{message}</p>
                ))}
              </div>
            ) : null}
            <div className="action-buttons">
              <label className="primary-btn button-label" htmlFor="file-input">
                Send Files
              </label>
              <button className="secondary-btn" type="button" onClick={() => { setMode("receiver"); setUiStep("input"); setPairingError(""); setPairingMessage(""); }}>
                Receive
              </button>
            </div>
            <input id="file-input" type="file" multiple ref={fileInputRef} onChange={handleFileSelection} style={{ display: "none" }} />
          </div>
        )}

        {uiStep === "code" && (
          <div className="card scale-in">
            <h2>Ready to send</h2>
            <p>Open Receive on the other device and use this code.</p>
            <div className="big-code">{code || "......"}</div>
            <div className="qr-container">
              {qrValue ? <QRCodeSVG value={qrValue} size={160} includeMargin bgColor="#ffffff" fgColor="#000000" /> : <div className="qr-placeholder">Creating code...</div>}
            </div>
            {selectedFiles.length > 0 ? (
              <div className="selection-panel">
                <p className="status-text">{selectedFiles.length === 1 ? "1 file selected" : `${selectedFiles.length} files selected`}</p>
                <FileSummaryList files={selectedFiles} emptyLabel="No files selected." />
              </div>
            ) : null}
            <p className="status-text">{pairingMessage || "Waiting for the other device..."}</p>
            {displayErrors.length > 0 ? (
              <div className="error-block">
                {displayErrors.map((message) => (
                  <p key={message} className="error-text">{message}</p>
                ))}
              </div>
            ) : null}
            {displayErrors.length > 0 ? <button className="secondary-btn" type="button" onClick={goHome}>Back to Home</button> : null}
            <button className="text-btn" type="button" onClick={goHome}>Cancel</button>
          </div>
        )}

        {uiStep === "input" && (
          <div className="card scale-in">
            <h2>Receive Files</h2>
            <p>Type the 6-character code. It connects automatically.</p>
            <input 
              autoFocus
              className="pin-input"
              value={joinCode}
              onChange={onPinChange}
              maxLength={6}
              placeholder="ABC123"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
            />
            <p className="status-text">{pairingMessage}</p>
            {displayErrors.length > 0 ? (
              <div className="error-block">
                {displayErrors.map((message) => (
                  <p key={message} className="error-text">{message}</p>
                ))}
              </div>
            ) : null}
            {displayErrors.length > 0 ? <button className="secondary-btn" type="button" onClick={goHome}>Back to Home</button> : null}
            <button className="text-btn" type="button" onClick={goHome}>Cancel</button>
          </div>
        )}

        {uiStep === "review" && (
          <div className="card scale-in">
            <h2>Choose Files to Receive</h2>
            <p>Select the files you want. The sender will only transfer the files you approve.</p>
            <div className="download-actions">
              <div className="download-list">
                {receivedFiles.map((file) => (
                  <label key={file.id} className="download-item">
                    <input
                      type="checkbox"
                      checked={selectedReceiveIds.includes(file.id)}
                      onChange={() => toggleReceiveSelection(file.id)}
                    />
                    <span className="download-item-text">
                      <strong>{file.name}</strong>
                      <span>{formatBytes(file.size)}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="complete-note review-note">
                {selectedReceiveFiles.length > 0
                  ? `${selectedReceiveFiles.length} file${selectedReceiveFiles.length === 1 ? "" : "s"} selected for transfer.`
                  : "Choose at least one file to start the transfer."}
              </p>
              <div className="download-toolbar">
                <button
                  className="secondary-btn download-button"
                  type="button"
                  onClick={() => setSelectedReceiveIds(receivedFiles.map((file) => file.id))}
                  disabled={receivedFiles.length === 0}
                >
                  Select All
                </button>
                <button
                  className="secondary-btn download-button"
                  type="button"
                  onClick={() => setSelectedReceiveIds([])}
                  disabled={selectedReceiveIds.length === 0}
                >
                  Clear Selection
                </button>
                <button
                  className="primary-btn download-button"
                  type="button"
                  onClick={handleReceiveSelectedFiles}
                  disabled={selectedReceiveIds.length === 0}
                >
                  Receive Selected ({selectedReceiveFiles.length})
                </button>
              </div>
            </div>
            {displayErrors.length > 0 ? (
              <div className="error-block">
                {displayErrors.map((message) => (
                  <p key={message} className="error-text">{message}</p>
                ))}
              </div>
            ) : null}
            <button className="text-btn" type="button" onClick={goHome}>Cancel</button>
          </div>
        )}

        {uiStep === "transferring" && (
          <div className="card glass-card transfer-card float-in">
            <h2>{mode === 'sender' ? 'Uploading' : 'Downloading'}</h2>
            <p className="filename">{stats.currentFileName || (mode === "sender" ? "Preparing files" : "Receiving files")}</p>
            {mode === "sender" && selectedFiles.length > 1 ? <FileSummaryList files={selectedFiles} activeName={stats.currentFileName} emptyLabel="No files selected." /> : null}
            {mode === "receiver" && receivedFiles.length > 0 ? <FileSummaryList files={receivedFiles} activeName={stats.currentFileName} emptyLabel="Waiting for files." /> : null}
            {displayErrors.length > 0 ? (
              <div className="error-block">
                {displayErrors.map((message) => (
                  <p key={message} className="error-text">{message}</p>
                ))}
              </div>
            ) : null}
            <CircularProgress progress={progressRatio} />
            <div className="transfer-stats">
              <div>
                <span>Speed</span>
                <strong>{formatRate(stats.bytesPerSecond)}</strong>
              </div>
              <div>
                <span>ETA</span>
                <strong>{formatEta(stats.etaSeconds)}</strong>
              </div>
              <div>
                <span>Size</span>
                <strong>{formatBytes(stats.transferredBytes)} / {formatBytes(stats.totalBytes)}</strong>
              </div>
            </div>
            <div className="action-buttons compact-actions">
              <button className="secondary-btn" type="button" onClick={cancelTransfer}>Cancel Transfer</button>
              {displayErrors.length > 0 ? <button className="text-btn" type="button" onClick={goHome}>Back to Home</button> : null}
            </div>
          </div>
        )}

        {uiStep === "complete" && (
          <div className="card scale-in success-card">
            <div className="check-icon">✓</div>
            <h2>Transfer Complete!</h2>
            <p>{mode === 'sender' ? 'Your files have been successfully sent.' : 'Choose which received files you want to save.'}</p>
            {mode === "receiver" && completedReceivedFiles.length > 0 ? (
              <div className="download-actions">
                <p className="complete-note">Select files below. Nothing will download until you press a download button.</p>
                <div className="download-list">
                  {completedReceivedFiles.map((file) => (
                    <label key={file.id} className="download-item">
                      <input
                        type="checkbox"
                        checked={selectedDownloadIds.includes(file.id)}
                        onChange={() => toggleDownloadSelection(file.id)}
                      />
                      <span className="download-item-text">
                        <strong>{file.name}</strong>
                        <span>{formatBytes(file.size)}</span>
                      </span>
                      <button
                        className="secondary-btn download-inline-button"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void saveReceivedFile(file);
                        }}
                      >
                        Download
                      </button>
                    </label>
                  ))}
                </div>
                <div className="download-toolbar">
                  <button className="secondary-btn download-button" type="button" onClick={() => void downloadSelectedFiles()}>
                    Download Selected ({selectedCompleteFiles.length})
                  </button>
                  <button className="primary-btn download-button" type="button" disabled={archiveBusy} onClick={() => void downloadSelectedAsZip()}>
                    {archiveBusy ? "Preparing Zip..." : `Download as Zip (${selectedCompleteFiles.length})`}
                  </button>
                </div>
              </div>
            ) : null}
            {transferError ? <p className="error-text error-block">{transferError}</p> : null}
            <button className="primary-btn mt" onClick={goHome}>Done</button>
          </div>
        )}
      </div>
    </main>
  );
}
