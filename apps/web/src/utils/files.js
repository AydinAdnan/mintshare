export function createFileDescriptor(file) {
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

export function sumFileSizes(files) {
  return files.reduce((total, file) => total + file.size, 0);
}

export function toDownloadName(relativePath) {
  return relativePath.split("/").filter(Boolean).join("-");
}

export function createArchiveName() {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
  return `MintShare_${suffix}.zip`;
}

export function triggerBrowserDownload(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
