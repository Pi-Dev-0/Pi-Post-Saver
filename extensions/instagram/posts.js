export function isInstagramPost(obj) {
  if (!obj || typeof obj !== "object") return false;
  // Fallback for regular posts (carousels, single posts)
  return !!obj.image_versions2 || !!obj.carousel_media || !!obj.display_url;
}
