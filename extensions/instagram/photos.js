export function isInstagramPhoto(obj) {
  if (!obj || typeof obj !== "object") return false;
  return !!obj.image_versions2 || !!obj.display_url;
}
