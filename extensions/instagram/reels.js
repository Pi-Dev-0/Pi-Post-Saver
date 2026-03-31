export function isInstagramReel(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);
  
  // Basic heuristic: check if it's a video and might have come from a reel path
  // Since Instagram doesn't typically distinguish reel from post at the data layer other than is_video=true or has video_versions
  if (o.is_video || (o.video_versions && Array.isArray(o.video_versions))) {
     // Optionally check window location if needed, but keeping logic generalized
     return true;
  }
  return false;
}
