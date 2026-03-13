import { formatBytes } from "../utils/format.js";

export function FileSummaryList({ files, activeName = "", emptyLabel }) {
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
