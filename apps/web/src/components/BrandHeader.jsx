import mintshareLogo from "../mintshare-logo.svg";

export function BrandHeader() {
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
