export function isInstagramStory(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  if (o.__typename === "InstagramStory") return true;

  if (o.placeholder === true) {
    return window.location.hostname.includes("instagram.com");
  }

  const typenames = new Set([
    "XDTGraphVideo",
    "XDTGraphImage",
    "XDTGraphSidecar",
    "GraphVideo",
    "GraphImage",
    "GraphSidecar",
    "XDTGraphMedia",
    "GraphMedia",
    "StoryVideo",
    "StoryImage",
  ]);

  if (typenames.has(String(o.__typename))) {
    return !!(o.shortcode || o.id || o.code);
  }

  if (
    (o.code ||
      o.shortcode ||
      o.pk ||
      (typeof o.id === "string" && o.id.includes("_"))) &&
    (o.image_versions2 ||
      o.video_versions ||
      o.display_url ||
      o.carousel_media ||
      o.media_type)
  ) {
    return true;
  }

  return false;
}
